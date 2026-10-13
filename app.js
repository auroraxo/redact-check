// Browser app: load a PDF entirely client-side, extract text + metadata,
// let the user verify that "redacted" terms are really gone.

import * as pdfjsLib from "./vendor/pdf.min.mjs";
import {
  escapeHtml,
  normalizePageText,
  parseTerms,
  checkTerm,
  scanPII,
} from "./logic.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);

const state = {
  fileName: "",
  fileSize: 0,
  raw: null, // Uint8Array copy for byte scans
  pages: [], // [{num, text}]
  metadataText: "",
  scannedDoc: false,
};

function setBusy(busy) {
  $("run").disabled = busy;
  $("file").disabled = busy;
  document.body.classList.toggle("busy", busy);
}

function progress(pct, label) {
  const bar = $("bar");
  bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  $("progress-label").textContent = label || "";
  $("progress").hidden = pct <= 0 || pct >= 100;
}

async function loadFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    showError("That is not a PDF file.");
    return;
  }
  state.fileName = file.name;
  state.fileSize = file.size;
  $("file-name").textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
  $("file-name").hidden = false;
  setBusy(true);
  clearResults();
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    state.raw = buf.slice(); // keep our own copy; pdf.js may transfer/detach the original
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;

    state.pages = [];
    const n = doc.numPages;
    for (let i = 1; i <= n; i++) {
      progress((i / n) * 80, `Reading page ${i} of ${n}…`);
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let raw = "";
      for (const item of tc.items) {
        if (!("str" in item)) continue;
        raw += item.str + (item.hasEOL ? "\n" : " ");
      }
      state.pages.push({ num: i, text: normalizePageText(raw) });
      // yield so the progress bar can paint on big files
      await new Promise((r) => setTimeout(r, 0));
    }

    progress(90, "Reading document metadata…");
    let meta = "";
    try {
      const md = await doc.getMetadata();
      const info = md.info || {};
      meta = [
        info.Title,
        info.Author,
        info.Subject,
        info.Keywords,
        info.Creator,
        info.Producer,
        info.Trapped,
      ]
        .filter((v) => v && typeof v === "string")
        .join("\n");
      if (md.metadata && typeof md.metadata.toString === "function") {
        try {
          meta += "\n" + md.metadata.toString();
        } catch {
          /* XMP node stringification varies; ignore */
        }
      }
    } catch {
      /* metadata is optional */
    }
    state.metadataText = meta;

    const totalChars = state.pages.reduce((s, p) => s + p.text.length, 0);
    state.scannedDoc = totalChars < Math.max(40, state.pages.length * 10);

    renderFileInfo(doc, totalChars);
    progress(100, "Ready.");
    $("run").disabled = false;
    autoScan();
  } catch (err) {
    const msg =
      err && err.name === "PasswordException"
        ? "This PDF is password-protected. Remove the password (open it and Save As without protection), then try again."
        : `Could not read the PDF: ${err && err.message ? err.message : err}`;
    showError(msg);
  } finally {
    setBusy(false);
    setTimeout(() => progress(0, ""), 600);
  }
}

function renderFileInfo(doc, totalChars) {
  const el = $("file-info");
  const meta = state.metadataText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const rows = [
    ["Pages", String(doc.numPages)],
    ["Extractable text", state.scannedDoc ? "almost none (likely a scan)" : `${totalChars.toLocaleString()} characters`],
    ["pdf.js version", pdfjsLib.version || "unknown"],
  ];
  if (meta.length) rows.push(["Metadata fields", meta.join(" · ")]);
  el.innerHTML = rows
    .map(
      ([k, v]) =>
        `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`
    )
    .join("");
  el.hidden = false;
}

function clearResults() {
  $("verdict").hidden = true;
  $("terms-result").hidden = true;
  $("terms-body").innerHTML = "";
  $("pii-result").hidden = true;
  $("pii-body").innerHTML = "";
  $("extracted").hidden = true;
  $("extracted-text").innerHTML = "";
  $("scanned-warning").hidden = true;
  $("error").hidden = true;
}

function showError(msg) {
  const el = $("error");
  el.textContent = msg;
  el.hidden = false;
  $("verdict").hidden = true;
}

function verdictHtml(kind, headline, detail) {
  return `<div class="verdict ${kind}"><strong>${escapeHtml(
    headline
  )}</strong><p>${detail}</p></div>`;
}

function autoScan() {
  // PII-shaped strings are reported even if the user enters no terms.
  const hits = [];
  for (const p of state.pages) {
    for (const h of scanPII(p.text)) {
      hits.push({ ...h, page: p.num });
    }
  }
  const body = $("pii-body");
  $("pii-result").hidden = false;
  if (!hits.length) {
    body.innerHTML =
      '<tr><td class="ok">No SSN-, email- or card-shaped strings found in extractable text.</td></tr>';
    return hits;
  }
  const seen = new Map();
  for (const h of hits) {
    const key = h.type + "|" + h.value;
    if (seen.has(key)) {
      seen.get(key).pages.push(h.page);
    } else {
      seen.set(key, { ...h, pages: [h.page] });
    }
  }
  body.innerHTML = [...seen.values()]
    .map(
      (h) => `<tr>
      <td><span class="pill danger">${escapeHtml(h.type)}</span></td>
      <td><code>${escapeHtml(h.value)}</code></td>
      <td>${h.pages.map((p) => "p." + p).join(", ")}</td>
    </tr>`
    )
    .join("");
  return hits;
}

function run() {
  clearErrorsOnly();
  const terms = parseTerms($("terms").value);
  const piiHits = autoScan();

  if (!state.pages.length) {
    showError("Load a PDF first.");
    return;
  }

  const results = terms.map((t) =>
    checkTerm(t, state.pages, state.metadataText, state.raw)
  );

  const leaked = results.filter((r) => r.found);
  const hidden = results.filter((r) => !r.found);

  // --- verdict ---
  const v = $("verdict");
  v.hidden = false;
  if (terms.length === 0) {
    if (piiHits.length) {
      v.innerHTML = verdictHtml(
        "bad",
        `FAIL — ${piiHits.length} sensitive-looking string(s) are still extractable`,
        "No terms were entered, but the automatic scan found data you may not have meant to expose. Enter the exact terms you tried to redact to confirm line by line."
      );
    } else {
      v.innerHTML = verdictHtml(
        "neutral",
        "Nothing to verify yet",
        "Enter each value you tried to redact (one per line), then run the check. The automatic scan runs anyway."
      );
    }
  } else if (leaked.length) {
    const extractable = leaked.filter((r) => r.extractable);
    v.innerHTML = verdictHtml(
      "bad",
      `FAIL — ${leaked.length} of ${terms.length} term(s) are still in the file`,
      extractable.length
        ? `${extractable.length} of them are <b>copy-paste reachable</b> (visible text layer or metadata). Anyone can select the text you blacked out and read it. This is the classic black-box redaction failure.`
        : `They no longer appear as readable text, but their bytes are still present in the file — recoverable by anyone who digs into the content streams.`
    );
  } else {
    v.innerHTML = verdictHtml(
      "good",
      `PASS — none of the ${terms.length} term(s) found`,
      `The terms do not appear in the text layer, metadata, or raw file bytes of <b>${escapeHtml(
        state.fileName
      )}</b>. Caveat: this checks text, not images — see the limitations below.`
    );
  }

  // --- per-term table ---
  $("terms-result").hidden = false;
  $("terms-body").innerHTML = results
    .map((r) => {
      const pill = r.found
        ? `<span class="pill danger">${r.extractable ? "LEAKED" : "BYTES"}</span>`
        : `<span class="pill ok">gone</span>`;
      const where = r.found ? r.where.join("<br>") : "not found anywhere";
      const hits = r.pageHits
        .map(
          (h) =>
            `<div class="hit"><span class="page">p.${h.page}</span> <span class="snippet">${h.snippet}</span></div>`
        )
        .join("");
      return `<tr>
        <td><code>${escapeHtml(r.term)}</code></td>
        <td>${pill}</td>
        <td>${where}${hits}</td>
      </tr>`;
    })
    .join("");

  // --- extracted text viewer ---
  renderExtracted();
}

function renderExtracted() {
  $("extracted").hidden = false;
  $("extracted-text").innerHTML = state.pages
    .map(
      (p) =>
        `<details${p.num === 1 ? " open" : ""}><summary>Page ${p.num}</summary><pre>${escapeHtml(
          p.text || "(no extractable text)"
        )}</pre></details>`
    )
    .join("");
}

function clearErrorsOnly() {
  $("error").hidden = true;
}

function init() {
  const drop = $("drop");
  const fileInput = $("file");

  fileInput.addEventListener("change", (e) => loadFile(e.target.files[0]));

  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  for (const ev of ["dragover", "dragenter"]) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
  }
  for (const ev of ["dragleave", "drop"]) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    });
  }
  drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

  $("run").addEventListener("click", run);
  $("run").disabled = true;

  $("show-extracted").addEventListener("click", () => {
    if (state.pages.length) renderExtracted();
  });

  $("terms").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
  });
}

init();
