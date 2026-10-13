// Pure logic — no DOM, no pdf.js. Shared by the browser app (app.js) and tests (test.mjs).

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Collapse runs of spaces/tabs but keep newlines. */
export function normalizePageText(raw) {
  return raw
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Case-insensitive literal search. Returns index or -1. */
export function findTermInText(text, term) {
  if (!term) return -1;
  return text.toLowerCase().indexOf(term.toLowerCase());
}

/** Snippet around an index, with the term wrapped in <mark>. HTML-escaped. */
export function snippetAround(text, idx, term, radius = 70) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  const before = escapeHtml(text.slice(start, idx));
  const hit = escapeHtml(text.slice(idx, idx + term.length));
  const after = escapeHtml(text.slice(idx + term.length, end));
  return (
    (start > 0 ? "…" : "") +
    before +
    "<mark>" +
    hit +
    "</mark>" +
    after +
    (end < text.length ? "…" : "")
  );
}

function asciiBytes(str) {
  // Strip non-latin1; PDF literal strings are usually ASCII.
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    out.push(c <= 0xff ? c : 0x3f); // "?" for anything else
  }
  return Uint8Array.from(out);
}

function utf16Bytes(str, littleEndian) {
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const hi = (cp >> 8) & 0xff;
    const lo = cp & 0xff;
    if (littleEndian) out.push(lo, hi);
    else out.push(hi, lo);
  }
  return Uint8Array.from(out);
}

/**
 * Byte patterns to hunt for in the raw file: UTF-8/ASCII, UTF-16BE with BOM
 * (PDF text strings), and UTF-16LE (some producers / embedded docs).
 */
export function makeBytePatterns(term) {
  const enc = new TextEncoder().encode(term);
  const beBom = Uint8Array.from([0xfe, 0xff, ...utf16Bytes(term, false)]);
  const le = Uint8Array.from(utf16Bytes(term, true));
  const out = [{ label: "plain text", bytes: enc }];
  if (enc.length) {
    out.push({ label: "UTF-16BE string", bytes: beBom });
    out.push({ label: "UTF-16LE string", bytes: le });
  }
  return out;
}

/** Byte-array search; ci = case-insensitive ASCII letters. Returns offset or -1. */
export function findBytes(buf, pat, ci = true) {
  if (!pat.length || buf.length < pat.length) return -1;
  const n = buf.length;
  const m = pat.length;
  const last = n - m;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < m; j++) {
      let a = buf[i + j];
      let b = pat[j];
      if (ci && a >= 0x41 && a <= 0x5a) a += 32;
      if (ci && b >= 0x41 && b <= 0x5a) b += 32;
      if (a !== b) continue outer;
    }
    return i;
  }
  return -1;
}

/** Luhn check for card-like digit runs. */
export function luhnOk(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const PATTERNS = [
  {
    type: "US SSN",
    // No leading digit; separator is space, dash, or none.
    // Lookaround avoids the all-zeros 000-00-0000; we still surface the
    // famous 123-45-6789 example and any real SSN.
    re: /(?<!\d)(?!000[- ]?00[- ]?0000)\d{3}[- ]?\d{2}[- ]?\d{4}(?!\d)/g,
    validate: () => true,
  },
  {
    type: "email address",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    validate: () => true,
  },
  {
    type: "payment-card number",
    re: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    validate: (m) => {
      const digits = m.replace(/[ -]/g, "");
      return (digits.length === 13 || digits.length === 15 || digits.length === 16 || digits.length === 19) && luhnOk(digits);
    },
  },
];

/**
 * Find PII-shaped strings in `text`.
 * Returns [{type, value, index}].
 */
export function scanPII(text) {
  const hits = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      if (p.validate(m[0])) {
        hits.push({ type: p.type, value: m[0], index: m.index });
      }
      if (m[0].length === 0) p.re.lastIndex++;
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

/** Split a textarea into terms: newlines or semicolons; trims; drops empties. */
export function parseTerms(raw) {
  return [...new Set(
    String(raw || "")
      .split(/[\n;]+/)
      .map((t) => t.trim())
      .filter(Boolean)
  )];
}

/**
 * Full verdict for one term.
 * pages: [{num, text}]  metadataText: string  raw: Uint8Array|null
 * Returns {term, found, where[], pageHits[{page, snippet}], byteHitLabel}
 */
export function checkTerm(term, pages, metadataText, raw) {
  const where = [];
  const pageHits = [];

  for (const p of pages) {
    const idx = findTermInText(p.text, term);
    if (idx >= 0) {
      if (pageHits.length < 3) {
        pageHits.push({ page: p.num, snippet: snippetAround(p.text, idx, term) });
      }
      if (!where.includes("page text")) where.push("page text");
    }
  }

  if (metadataText && findTermInText(metadataText, term) >= 0) {
    where.push("document metadata");
  }

  let byteHitLabel = null;
  if (raw) {
    for (const pat of makeBytePatterns(term)) {
      if (findBytes(raw, pat.bytes) >= 0) {
        byteHitLabel = pat.label;
        where.push("raw file bytes (" + pat.label + ")");
        break;
      }
    }
  }

  return {
    term,
    found: where.length > 0,
    where,
    pageHits,
    // page text or metadata == copy-paste reachable; raw bytes == still in the file
    extractable: where.includes("page text") || where.includes("document metadata"),
    byteHitLabel,
  };
}
