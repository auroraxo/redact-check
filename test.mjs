// Node tests: prove the checker catches a black-box "redaction" and passes a real one.
// Run: node test.mjs  (generates fixtures first if missing)
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { checkTerm, scanPII, findBytes, makeBytePatterns, parseTerms, luhnOk } from "./logic.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixDir = path.join(dir, "fixtures");

if (!existsSync(path.join(fixDir, "fake-redacted.pdf"))) {
  execSync("python3 gen_fixtures.py", { cwd: dir });
}

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

// Extract text the same way the browser does, via vendored pdf.js.
const pdfjs = await import(path.join(dir, "vendor", "pdf.min.mjs"));
pdfjs.GlobalWorkerOptions.workerSrc = path.join(dir, "vendor", "pdf.worker.min.mjs");

async function extract(file) {
  const data = new Uint8Array(readFileSync(file));
  const doc = await pdfjs.getDocument({ data: data.slice() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let raw = "";
    for (const item of tc.items) {
      if ("str" in item) raw += item.str + (item.hasEOL ? "\n" : " ");
    }
    pages.push({ num: i, text: raw.replace(/[ \t]+/g, " ").trim() });
  }
  const md = await doc.getMetadata();
  const meta = [md.info?.Title, md.info?.Author].filter(Boolean).join("\n");
  return { pages, meta, raw: data };
}

console.log("unit: parseTerms / luhn / scanPII");
assert(parseTerms("a\nb; a\n \n").join(",") === "a,b", "dedupes and splits terms");
assert(luhnOk("4111111111111111") === true, "Luhn accepts test Visa");
assert(luhnOk("4111111111111112") === false, "Luhn rejects bad checksum");
{
  const pii = scanPII("SSN 123-45-6789, card 4111 1111 1111 1111, x@y.co");
  const types = new Set(pii.map((h) => h.type));
  assert(types.has("US SSN"), "SSN detected");
  assert(types.has("payment-card number"), "card detected");
  assert(types.has("email address"), "email detected");
}
{
  const buf = new TextEncoder().encode("prefix 123-45-6789 suffix");
  const hit = makeBytePatterns("123-45-6789").find((p) => findBytes(buf, p.bytes) >= 0);
  assert(hit && hit.label === "plain text", "byte scan finds plain-text term");
  const u16 = new Uint8Array([0xfe, 0xff, 0x00, 0x31, 0x00, 0x32]); // BOM + "12"
  assert(findBytes(u16, makeBytePatterns("12").find((p) => p.label.startsWith("UTF-16BE")).bytes, false) === 0, "byte scan finds UTF-16BE term");
}

console.log("e2e: fake (black-box) redaction must FAIL");
{
  const { pages, meta, raw } = await extract(path.join(fixDir, "fake-redacted.pdf"));
  const r = checkTerm("123-45-6789", pages, meta, raw);
  assert(r.found, "covered SSN is still found");
  assert(r.extractable, "covered SSN is copy-paste reachable");
  assert(r.pageHits.length > 0, "report includes page + snippet");
  const pii = pages.flatMap((p) => scanPII(p.text));
  assert(pii.some((h) => h.type === "US SSN"), "auto-scan flags the SSN");
}

console.log("e2e: proper redaction must PASS");
{
  const { pages, meta, raw } = await extract(path.join(fixDir, "proper-redacted.pdf"));
  const r = checkTerm("123-45-6789", pages, meta, raw);
  assert(!r.found, "removed SSN is not found anywhere");
  const pii = pages.flatMap((p) => scanPII(p.text));
  assert(!pii.some((h) => h.type === "US SSN"), "auto-scan sees no SSN");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall tests passed");
process.exit(failures ? 1 : 0);
