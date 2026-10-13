# Redact Check

**A black box over text in a PDF is not a redaction.** The text underneath is
still copy-pasteable. Courts have sanctioned lawyers for it (one reported
$30,000 fine). Journalists have recovered data from corporate filings with a
single Select-All.

This page tells you, in your browser, whether the values you tried to redact
are really gone — from the visible text, the document metadata, and the raw
file bytes.

- **100% client-side.** The PDF is never uploaded; you can run this on a
  plane, on a court deadline, or with the network cable unplugged.
- **Vendored libraries.** The single ~1.7 MB of `vendor/` is the entire
  parsing stack. No CDN, no telemetry, no build step.
- **No install.** Open the page, drop a file, read the result.

## Live page

Open `index.html` in any modern browser, or serve the directory. The
production page is deployed to GitHub Pages — see the repo **About** panel
or the page footer for the URL.

## Use

1. Drop a PDF on the page.
2. Paste the values you tried to redact (one per line) into the box.
3. Click **Verify redaction**.

The automatic scan runs first, regardless of whether you entered anything:
it finds SSN-, email-, and valid-card-number-shaped strings anywhere in the
extractable text.

A red **FAIL** means the value is still copy-pasteable (visible text or
metadata) or still present in the file bytes. A green **PASS** means none
of the terms appear in the text layer, the document metadata, or the raw
file bytes.

## What this is and is not

**Is:** a fast, private, no-trust check for the most common redaction
failure — text that was covered but not deleted.

**Is not:** a substitute for properly redacting the file. Real redaction
removes the bytes. If the page reports **FAIL**, rebuild the page (e.g.
rasterize the redaction, or use a tool that strips text from the
content stream). It is also **not** legal advice — court rules vary by
jurisdiction; the limitations panel on the page links to the most
commonly cited U.S. guidance.

## Run the tests

```bash
python3 gen_fixtures.py
node test.mjs
```

The fixtures are two hand-rolled PDFs: one with a black box drawn over
live text (text still under the box — the typical broken redaction), and
one with the sensitive value never written to the file in the first
place. The tests must see **FAIL** on the first and **PASS** on the
second.

## Files

| File          | Purpose                                               |
|---------------|-------------------------------------------------------|
| `index.html`  | Single-page app (HTML + CSS).                         |
| `app.js`      | Browser controller: file input, pdf.js glue, render.  |
| `logic.js`    | Pure logic, also imported by `test.mjs`.              |
| `vendor/`     | Vendored pdf.js 4.10.38 (MIT, Mozilla).               |
| `gen_fixtures.py` | Builds the two test PDFs (stdlib only).            |
| `test.mjs`    | Node test suite.                                      |
| `.github/workflows/ci.yml` | CI: re-runs the fixtures + tests.        |

## License

MIT. See `LICENSE`.
