"""Render a syllabus .md to .docx in the bookSHelf theme, on a 7.5in text column.

    python render.py "Syllabus - Stats 2026-2027.md" [...]

Two things pandoc will not do on its own:

  * The bookSHelf reference doc sets no page size, so Word falls back to 1in
    margins. We stamp 0.5in left and right into the section properties.
  * Pandoc's docx writer pins every table to 5.5in no matter what the page
    says (verified against a landscape reference doc), so the grid is rescaled
    to the real text column afterwards. Column *ratios* still come from the
    dash counts in each table's separator row.
"""
import os, re, subprocess, sys, tempfile, zipfile

REF = r"C:\Users\shuff\Documents\GitHub\bookSHelf\projects\_docx-theme\bookshelf-reference.docx"
TWIP = 1440
PAGE, SIDE, TOPBOT = 8.5 * TWIP, 0.5 * TWIP, 1.0 * TWIP
TEXT = PAGE - 2 * SIDE

SECT = ('<w:pgSz w:h="%d" w:w="%d"/>'
        '<w:pgMar w:top="%d" w:right="%d" w:bottom="%d" w:left="%d"'
        ' w:header="720" w:footer="720" w:gutter="0"/>'
        % (11 * TWIP, PAGE, TOPBOT, SIDE, TOPBOT, SIDE))


def patch(path, fn):
    zin = zipfile.ZipFile(path)
    items = [(i, zin.read(i.filename)) for i in zin.infolist()]
    zin.close()
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for i, b in items:
            if i.filename == "word/document.xml":
                b = fn(b.decode("utf-8")).encode("utf-8")
            z.writestr(i, b)


def widen(doc):
    doc = doc.replace("<w:sectPr>", "<w:sectPr>" + SECT, 1)

    def grid(m):
        w = [int(x) for x in re.findall(r'w:w="(\d+)"', m.group(1))]
        tot = sum(w) or 1
        # Distribute by ratio, then hand the rounding remainder to the widest
        # column so the row still adds up to exactly the text column.
        new = [round(c * TEXT / tot) for c in w]
        new[new.index(max(new))] += int(TEXT) - sum(new)
        return "<w:tblGrid>%s</w:tblGrid>" % "".join(
            '<w:gridCol w:w="%d"/>' % c for c in new)

    return re.sub(r"<w:tblGrid>(.*?)</w:tblGrid>", grid, doc, flags=re.S)


def main(paths):
    for md in paths:
        out = os.path.splitext(md)[0] + ".docx"
        subprocess.run(["pandoc", md, "--reference-doc", REF, "-o", out], check=True)
        patch(out, widen)
        print("%s  (text column %.2fin)" % (out, TEXT / TWIP))


def demo():
    """Self-check: a grid of any scale comes out summing to the text column."""
    src = ('<w:sectPr></w:sectPr><w:tblGrid><w:gridCol w:w="1863"/>'
           '<w:gridCol w:w="1397"/><w:gridCol w:w="4657"/></w:tblGrid>')
    grid = re.search(r"<w:tblGrid>.*?</w:tblGrid>", widen(src), re.S).group()
    got = [int(x) for x in re.findall(r'w:w="(\d+)"', grid)]
    assert sum(got) == int(TEXT), got
    assert got[2] > got[0] > got[1], got          # ratios preserved
    assert SECT in widen(src)
    print("ok", got)


if __name__ == "__main__":
    args = sys.argv[1:]
    demo() if args == ["--check"] else main(args or sys.exit(__doc__))
