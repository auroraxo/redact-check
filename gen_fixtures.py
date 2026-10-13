#!/usr/bin/env python3
"""Generate test fixtures: PDFs with a black box drawn over live text.

Writes fixtures/fake-redacted.pdf (text still under the box) and
fixtures/proper-redacted.pdf (text genuinely absent). No third-party deps.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")


def build_pdf(text_lines, cover_line_index=None):
    """One-page PDF; optionally paint an opaque black rectangle over one line."""
    # Helvetica at 12pt; lines start at y=700, 18pt leading.
    ops = ["BT", "/F1 12 Tf", "14 TL", "72 700 Td"]
    first = True
    covered_y = None
    for i, line in enumerate(text_lines):
        esc = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        if first:
            ops.append(f"({esc}) Tj")
            first = False
        else:
            ops.append(f"T* ({esc}) Tj")
        if i == cover_line_index:
            # Text line i baseline: 700 - 18*i; glyph tops ~ +12pt.
            covered_y = 700 - 18 * i
    ops.append("ET")
    if covered_y is not None:
        # Rectangle fully covering the line, painted AFTER the text.
        x, w, h = 70, 320, 15
        y = covered_y - 3
        ops.append(f"0 g {x} {y} {w} {h} re f")
    stream = "\n".join(ops).encode("latin-1")

    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append(
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
    )
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    objs.append(
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
    )
    info = b"<< /Title (Fixture) /Author (Redact Check Tests) >>"
    objs.append(info)

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i
        out += body
        out += b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 %d\n" % (len(objs) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += (
        b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objs) + 1, len(objs), xref_pos)
    )
    return bytes(out)


def main():
    os.makedirs(OUT, exist_ok=True)
    lines = [
        "ACME CORP EMPLOYMENT AGREEMENT - CONFIDENTIAL",
        "Employee: Jane Q. Doe",
        "SSN: 123-45-6789",
        "Email: jane.doe@example.com",
        "Card: 4111 1111 1111 1111",
        "Salary: $120,000 per year, paid monthly.",
        "Page 1 of 1",
    ]
    # Box over the SSN line only.
    fake = build_pdf(lines, cover_line_index=2)
    with open(os.path.join(OUT, "fake-redacted.pdf"), "wb") as f:
        f.write(fake)
    # Proper version: SSN never written to the file at all.
    proper = build_pdf([l for i, l in enumerate(lines) if i != 2], cover_line_index=None)
    with open(os.path.join(OUT, "proper-redacted.pdf"), "wb") as f:
        f.write(proper)
    print(f"wrote {len(fake)} and {len(proper)} bytes into {OUT}")


if __name__ == "__main__":
    main()
