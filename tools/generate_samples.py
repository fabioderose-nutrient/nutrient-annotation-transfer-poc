"""Generate the two fictitious sample documents used by the demo.

- public/samples/proposal-v1-annotated.pdf: first version of a renovation proposal,
  with reviewer annotations of every supported kind (highlight, underline, strikeout,
  note, free text, rectangle, ellipse, ink arrow, ink circle, highlighter band).
- public/samples/proposal-v2.pdf: second version of the same proposal, without
  annotations. A paragraph is inserted, words are edited, two sections swap places,
  an amount changes and a sentence is removed, so the text reflows across pages.

Requirements: Python 3.9+, reportlab and pypdf (pip install reportlab pypdf).
Run from the repository root: python tools/generate_samples.py
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass, field
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "samples"

PAGE_W, PAGE_H = letter
LEFT = 72
TEXT_W = 400  # leaves a wide right margin for reviewer notes
TOP = PAGE_H - 96
BOTTOM = 90
BODY_FONT, BODY_SIZE, LEADING = "Helvetica", 11, 15.5
HEAD_FONT, HEAD_SIZE = "Helvetica-Bold", 13


# ---------------------------------------------------------------------------
# Document content. Version 2 is derived from version 1 with a few edits.
# ---------------------------------------------------------------------------

def content(version: int) -> list[tuple]:
    summary = (
        "This proposal describes the renovation of the Harbor View Community Center, "
        "a two-storey building from 1978 used by local clubs, a day nursery and an "
        "evening language school. The proposal covers the roof, the heating system and "
        "step-free access to the main hall. Work is planned in three phases so that the "
        "building stays open during most of the renovation."
    )
    survey = (
        "Since the first draft, the facilities team has completed a structural survey of "
        "the roof deck. The deck itself is sound, which removes the need for the timber "
        "repairs listed as optional in the first draft. The survey report is attached as "
        "an appendix to this version."
    )
    condition = (
        "The building is safe and in daily use, but three elements have reached the end of "
        "their service life. Repairs have become more frequent and more expensive every "
        "year, and the boiler is 27 years old. The main points raised by the last "
        "inspection are listed below."
    )
    bullets = [
        "Roof: the flat roof membrane leaks above the main hall after heavy rain.",
        "Heating: the gas boiler fails several times each winter.",
        "Access: the main hall can only be reached by a flight of six steps.",
        "Windows: single glazing on the north side causes heat loss.",
    ]
    works_v1 = (
        "The committee recommends replacing the roof membrane and adding 120 mm of "
        "insulation. The gas boiler is replaced by two air-source heat pumps with a "
        "smaller gas unit kept as backup for very cold days. A ramp and an automatic "
        "door give step-free access to the main hall. The single glazing on the north "
        "side is replaced by double glazing in the same frames."
    )
    works_v2 = works_v1.replace(
        "The committee recommends replacing",
        "The committee strongly recommends replacing",
    ).replace("120 mm", "140 mm")
    budget_intro = (
        "The estimate below is based on two quotes per work package. Prices include "
        "labour and materials and exclude tax."
    )
    budget_rows_v1 = [
        ("Roof membrane and insulation", "$48,500"),
        ("Heat pumps and backup unit", "$36,200"),
        ("Ramp and automatic door", "$14,800"),
        ("North side double glazing", "$9,600"),
        ("Contingency (5%)", "$5,455"),
        ("Total", "$114,555"),
    ]
    budget_rows_v2 = [
        ("Roof membrane and insulation", "$48,500"),
        ("Heat pumps and backup unit", "$39,400"),
        ("Ramp and automatic door", "$14,800"),
        ("North side double glazing", "$9,600"),
        ("Contingency (5%)", "$5,615"),
        ("Total", "$117,915"),
    ]
    budget_note = (
        "A grant from the regional energy fund could cover up to 30% of the heat pump "
        "cost. The application must be filed before the end of March."
    )
    schedule_v1 = (
        "Phase one replaces the roof during the summer break, when the nursery is closed. "
        "Phase two installs the heat pumps in September and October. Phase three builds "
        "the ramp and replaces the windows. The last phase should end in June 2027, and "
        "the hall stays closed for four weeks in total. The old boiler room will be "
        "turned into a storage room for the clubs."
    )
    schedule_v2 = (
        "Phase one replaces the roof during the summer break, when the nursery is closed. "
        "Phase two installs the heat pumps in September and October. Phase three builds "
        "the ramp and replaces the windows. The last phase should end in June 2027, and "
        "the hall stays closed for four weeks in total."
    )
    risks = (
        "Delivery times for heat pumps vary between eight and sixteen weeks, so the order "
        "has to be placed as soon as the budget is approved. Roof work depends on dry "
        "weather. If the summer is wet, phase one moves to the autumn and phase two "
        "follows it. The contractor has confirmed that both phases can run in parallel "
        "if needed."
    )
    decision = (
        "The board is asked to approve the budget of the three phases, to authorise the "
        "grant application, and to appoint a project lead from the facilities team. A "
        "progress report will be presented at every board meeting until the work is "
        "complete."
    )

    survey_findings = (
        "The survey also measured the heat loss of the building envelope. Most of the loss "
        "comes from the roof and from the single glazing on the north side, which confirms "
        "the priorities of this proposal. No asbestos was found in the areas affected by "
        "the works. The survey team recommends a second inspection of the roof deck ten "
        "years after the new membrane is laid, and a yearly check of the gutters and of the "
        "roof drains, which were partly blocked on the day of the visit. The full list of "
        "measurements is part of the appendix, together with photos of each roof section."
    )

    sections: list[tuple[str, list[tuple]]] = [("Summary", [("para", summary)])]
    if version == 2:
        sections.append(("Survey results", [("para", survey), ("para", survey_findings)]))
    sections += [
        ("Current condition", [("para", condition), ("bullets", bullets if version == 1 else bullets + [
            "Drainage: the roof drains and gutters are partly blocked.",
            "Lighting: the hall lighting uses old fluorescent tubes.",
        ])]),
        ("Proposed works", [("para", works_v1 if version == 1 else works_v2)]),
        ("Budget", [
            ("para", budget_intro),
            ("table", budget_rows_v1 if version == 1 else budget_rows_v2),
            ("para", budget_note),
        ]),
    ]
    schedule = ("Schedule", [("para", schedule_v1 if version == 1 else schedule_v2)])
    risk = ("Risks", [("para", risks)])
    # in version 2 the risks come before the schedule
    sections += [schedule, risk] if version == 1 else [risk, schedule]
    sections.append(("Decision requested", [("para", decision)]))

    blocks: list[tuple] = [
        ("title", "Community Center Renovation Proposal"),
        ("subtitle", f"Version {version}  -  prepared for the board of trustees"),
    ]
    for number, (title, body) in enumerate(sections, start=1):
        blocks.append(("heading", f"{number}. {title}"))
        blocks += body
    return blocks


# ---------------------------------------------------------------------------
# Minimal layout engine that remembers where every word is drawn.
# ---------------------------------------------------------------------------

@dataclass
class Word:
    text: str
    page: int
    x: float
    baseline: float
    size: float
    font: str

    @property
    def width(self) -> float:
        return stringWidth(self.text, self.font, self.size)


@dataclass
class Layout:
    pages: list[list[tuple]] = field(default_factory=lambda: [[]])
    words: list[Word] = field(default_factory=list)
    y: float = TOP

    def new_page(self) -> None:
        self.pages.append([])
        self.y = TOP

    def ensure(self, height: float) -> None:
        if self.y - height < BOTTOM:
            self.new_page()

    def text_line(self, words: list[str], x: float, font: str, size: float, spacing=None) -> None:
        page = len(self.pages) - 1
        space = spacing if spacing is not None else stringWidth(" ", font, size)
        cx = x
        for w in words:
            self.pages[page].append(("text", cx, self.y, w, font, size))
            self.words.append(Word(w, page, cx, self.y, size, font))
            cx += stringWidth(w, font, size) + space

    def paragraph(self, text: str, x: float = LEFT, width: float = TEXT_W,
                  font: str = BODY_FONT, size: float = BODY_SIZE, after: float = 8) -> None:
        words = text.split()
        line: list[str] = []
        space = stringWidth(" ", font, size)
        for w in words:
            trial = line + [w]
            if line and stringWidth(" ".join(trial), font, size) > width:
                self.ensure(LEADING)
                self.y -= LEADING
                self.text_line(line, x, font, size)
                line = [w]
            else:
                line = trial
        if line:
            self.ensure(LEADING)
            self.y -= LEADING
            self.text_line(line, x, font, size, space)
        self.y -= after


def layout(blocks: list[tuple]) -> Layout:
    lay = Layout()
    for kind, value in blocks:
        if kind == "title":
            lay.y -= 6
            lay.text_line(value.split(), LEFT, "Helvetica-Bold", 20)
            lay.y -= 22
        elif kind == "subtitle":
            lay.text_line(value.split(), LEFT, "Helvetica-Oblique", 11)
            lay.y -= 18
        elif kind == "heading":
            lay.ensure(LEADING * 6)  # keep a heading with the start of its section
            lay.y -= 10
            lay.y -= HEAD_SIZE + 2
            lay.text_line(value.split(), LEFT, HEAD_FONT, HEAD_SIZE)
            lay.y -= 2
        elif kind == "para":
            lay.paragraph(value)
        elif kind == "bullets":
            for item in value:
                lay.ensure(LEADING * 2)
                page = len(lay.pages) - 1
                lay.pages[page].append(("bullet", LEFT + 6, lay.y - LEADING + 3.5))
                lay.paragraph(item, x=LEFT + 18, width=TEXT_W - 18, after=1)
            lay.y -= 7
        elif kind == "table":
            lay.ensure(LEADING * (len(value) + 1))
            for i, (label, amount) in enumerate(value):
                lay.y -= LEADING + 1
                bold = i == len(value) - 1
                font = "Helvetica-Bold" if bold else BODY_FONT
                page = len(lay.pages) - 1
                if bold:
                    lay.pages[page].append(("rule", LEFT + 12, lay.y + LEADING - 3, LEFT + 330))
                lay.text_line(label.split(), LEFT + 12, font, BODY_SIZE)
                ax = LEFT + 330 - stringWidth(amount, font, BODY_SIZE)
                lay.text_line([amount], ax, font, BODY_SIZE)
            lay.y -= 12
    return lay


def render(lay: Layout, version: int) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setTitle(f"Community Center Renovation Proposal - version {version}")
    c.setAuthor("Facilities committee")
    c.setCreator("tools/generate_samples.py")
    total = len(lay.pages)
    for index, ops in enumerate(lay.pages):
        # header and footer repeat on every page, like in most real documents
        c.setFont("Helvetica", 8.5)
        c.setFillGray(0.45)
        c.drawString(LEFT, PAGE_H - 50, "Harbor View Community Center  |  Renovation Proposal")
        c.drawRightString(PAGE_W - LEFT, PAGE_H - 50, f"Version {version}")
        c.drawString(LEFT, 50, "Fictitious sample document")
        c.drawRightString(PAGE_W - LEFT, 50, f"Page {index + 1} of {total}")
        c.setStrokeGray(0.8)
        c.line(LEFT, PAGE_H - 58, PAGE_W - LEFT, PAGE_H - 58)
        c.setFillGray(0)
        for op in ops:
            if op[0] == "text":
                _, x, y, text, font, size = op
                c.setFont(font, size)
                c.drawString(x, y, text)
            elif op[0] == "bullet":
                c.circle(op[1], op[2], 1.8, stroke=0, fill=1)
            elif op[0] == "rule":
                c.setStrokeGray(0.3)
                c.line(op[1], op[2], op[3], op[2])
        c.showPage()
    c.save()
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Annotations, placed from the recorded word positions (PDF coordinates).
# ---------------------------------------------------------------------------

def find_phrase(lay: Layout, phrase: str, occurrence: int = 0) -> list[Word]:
    target = phrase.split()
    found = 0
    for i in range(len(lay.words) - len(target) + 1):
        if [w.text for w in lay.words[i:i + len(target)]] == target:
            if found == occurrence:
                return lay.words[i:i + len(target)]
            found += 1
    raise ValueError(f"phrase not found: {phrase}")


def line_rects(words: list[Word]) -> list[tuple[int, float, float, float, float]]:
    """One rectangle per text line: (page, x1, y1, x2, y2) in PDF coordinates."""
    rects: list[list] = []
    for w in words:
        top = w.baseline + w.size * 0.80
        bottom = w.baseline - w.size * 0.25
        if rects and rects[-1][0] == w.page and abs(rects[-1][5] - w.baseline) < 0.1:
            rects[-1][3] = w.x + w.width
        else:
            rects.append([w.page, w.x, bottom, w.x + w.width, top, w.baseline])
    return [tuple(r[:5]) for r in rects]


def num_array(values) -> ArrayObject:
    return ArrayObject([FloatObject(round(v, 2)) for v in values])


def base_annot(subtype: str, rect, color, author="Reviewer", contents="", opacity=1.0) -> DictionaryObject:
    d = DictionaryObject()
    d[NameObject("/Type")] = NameObject("/Annot")
    d[NameObject("/Subtype")] = NameObject(subtype)
    d[NameObject("/Rect")] = num_array(rect)
    d[NameObject("/C")] = num_array(color)
    d[NameObject("/T")] = TextStringObject(author)
    d[NameObject("/M")] = TextStringObject("D:20260301120000Z")
    d[NameObject("/F")] = NumberObject(4)
    if contents:
        d[NameObject("/Contents")] = TextStringObject(contents)
    if opacity < 1:
        d[NameObject("/CA")] = FloatObject(opacity)
    return d


def text_markup(subtype: str, words: list[Word], color, contents="", opacity=1.0):
    per_page: dict[int, list] = {}
    for page, x1, y1, x2, y2 in line_rects(words):
        per_page.setdefault(page, []).append((x1, y1, x2, y2))
    out = []
    for page, rects in per_page.items():
        quads = []
        for x1, y1, x2, y2 in rects:
            quads += [x1, y2, x2, y2, x1, y1, x2, y1]
        bbox = (min(r[0] for r in rects), min(r[1] for r in rects),
                max(r[2] for r in rects), max(r[3] for r in rects))
        d = base_annot(subtype, bbox, color, contents=contents, opacity=opacity)
        d[NameObject("/QuadPoints")] = num_array(quads)
        out.append((page, d))
    return out


def shape(subtype: str, page: int, rect, color, width=1.5):
    d = base_annot(subtype, rect, color)
    bs = DictionaryObject()
    bs[NameObject("/W")] = FloatObject(width)
    d[NameObject("/BS")] = bs
    return page, d


def ink(page: int, strokes: list[list[tuple[float, float]]], color, width=2.0, opacity=1.0):
    xs = [p[0] for s in strokes for p in s]
    ys = [p[1] for s in strokes for p in s]
    pad = width / 2 + 1
    rect = (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)
    d = base_annot("/Ink", rect, color, opacity=opacity)
    d[NameObject("/InkList")] = ArrayObject(
        [num_array([c for p in s for c in p]) for s in strokes]
    )
    bs = DictionaryObject()
    bs[NameObject("/W")] = FloatObject(width)
    d[NameObject("/BS")] = bs
    return page, d


def free_text(page: int, rect, text: str, color=(0.75, 0.1, 0.1), size=10):
    d = base_annot("/FreeText", rect, color, contents=text)
    del d["/C"]  # for free text /C is the background colour: keep it transparent
    r, g, b = color
    d[NameObject("/DA")] = TextStringObject(f"/Helv {size} Tf {r} {g} {b} rg")
    border = DictionaryObject()
    border[NameObject("/W")] = FloatObject(0)
    d[NameObject("/BS")] = border
    return page, d


def note(page: int, x: float, y: float, text: str, color=(1, 0.82, 0.2)):
    d = base_annot("/Text", (x, y, x + 24, y + 24), color, contents=text)
    d[NameObject("/Name")] = NameObject("/Comment")
    return page, d


def densify(points: list[tuple[float, float]], step: float = 3.0) -> list[tuple[float, float]]:
    """Add intermediate points, like a stroke drawn by hand in a viewer."""
    out = [points[0]]
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        n = max(1, int(math.hypot(x2 - x1, y2 - y1) / step))
        out += [(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n) for i in range(1, n + 1)]
    return out


def build_annotations(lay: Layout) -> list[tuple[int, DictionaryObject]]:
    annots: list[tuple[int, DictionaryObject]] = []
    red = (0.85, 0.1, 0.1)
    blue = (0.1, 0.35, 0.85)

    # 1. highlight a sentence of the summary
    annots += text_markup(
        "/Highlight",
        find_phrase(lay, "The proposal covers the roof, the heating system and step-free access to the main hall."),
        (1, 0.9, 0.2), contents="Key scope for the vote.",
    )

    # 2. underline a fact in the current condition
    annots += text_markup("/Underline", find_phrase(lay, "the boiler is 27 years old."), blue)

    # 3. rectangle around the bullet list
    first = find_phrase(lay, "Roof: the flat roof membrane")
    last = find_phrase(lay, "causes heat loss.")
    page = first[0].page
    x1 = LEFT - 4
    y2 = first[0].baseline + 13
    y1 = last[-1].baseline - 6
    annots.append(shape("/Square", page, (x1, y1, LEFT + TEXT_W + 4, y2), red))

    # 4. sticky note next to the proposed works
    w = find_phrase(lay, "The committee recommends replacing the roof membrane")
    annots.append(note(w[0].page, LEFT + TEXT_W + 20, w[0].baseline - 8,
                       "Ask the contractor for a second quote for the membrane."))

    # 5. ellipse around the roof line of the budget table
    row = find_phrase(lay, "Roof membrane and insulation $48,500")
    annots.append(shape("/Circle", row[0].page,
                        (row[0].x - 14, row[0].baseline - 8, row[-1].x + row[-1].width + 14, row[0].baseline + 16),
                        red, width=1.8))

    # 6. ink arrow pointing at the grant deadline, with a free text label at its tail
    deadline = find_phrase(lay, "end of March.")[-1]
    tip = (deadline.x + deadline.width + 3, deadline.baseline + 3.5)
    tail = (LEFT + TEXT_W + 44, tip[1] - 24)
    shaft = [tail, ((tail[0] + tip[0]) / 2 + 2, (tail[1] + tip[1]) / 2 - 5), tip]
    angle = math.atan2(tail[1] - tip[1], tail[0] - tip[0])
    head = [
        (tip[0] + 9 * math.cos(angle + 0.45), tip[1] + 9 * math.sin(angle + 0.45)),
        tip,
        (tip[0] + 9 * math.cos(angle - 0.45), tip[1] + 9 * math.sin(angle - 0.45)),
    ]
    annots.append(ink(deadline.page, [densify(shaft), head], red, width=1.8))
    annots.append(free_text(deadline.page, (tail[0] - 30, tail[1] - 32, tail[0] + 76, tail[1] - 2),
                            "Who files the grant application?"))

    # 7. hand-drawn circle around a date
    date = find_phrase(lay, "June 2027,")
    dx1, dy1 = date[0].x, date[0].baseline
    dx2 = date[-1].x + date[-1].width
    cx, cy = (dx1 + dx2) / 2, dy1 + 3.5
    rx, ry = (dx2 - dx1) / 2 + 7, 10
    loop = [(cx + rx * math.cos(t / 20 * 2 * math.pi + 0.3), cy + ry * math.sin(t / 20 * 2 * math.pi + 0.3))
            for t in range(0, 22)]
    annots.append(ink(date[0].page, [loop], blue, width=1.6))

    # 8. strikeout on a sentence of the schedule (the section moves in version 2)
    annots += text_markup("/StrikeOut",
                          find_phrase(lay, "and the hall stays closed for four weeks in total."),
                          red, contents="Four weeks is too long for the clubs.")

    # 9. highlighter band painted with a wide pen over one line of the risks
    band = find_phrase(lay, "has to be placed as soon as the budget is approved.")
    for page, x1, y1, x2, y2 in line_rects(band)[:1]:
        mid = (y1 + y2) / 2
        pts = densify([(x1 - 2, mid - 0.6), ((x1 + x2) / 2, mid + 0.8), (x2 + 2, mid - 0.4)])
        annots.append(ink(page, [pts], (0.2, 0.8, 0.3), width=18, opacity=0.35))

    # 10. free text comment in the margin of the decision
    dec = find_phrase(lay, "The board is asked to approve the budget")
    annots.append(free_text(dec[0].page,
                            (LEFT + TEXT_W + 12, dec[0].baseline - 30, PAGE_W - 18, dec[0].baseline + 10),
                            "Vote at the next board meeting.", color=blue))
    return annots


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    lay1 = layout(content(1))
    reader = PdfReader(io.BytesIO(render(lay1, 1)))
    writer = PdfWriter()
    writer.append(reader)
    for page_index, annot in build_annotations(lay1):
        writer.add_annotation(page_number=page_index, annotation=annot)
    writer.add_metadata({"/Title": "Community Center Renovation Proposal - version 1 (annotated)"})
    with open(OUT_DIR / "proposal-v1-annotated.pdf", "wb") as f:
        writer.write(f)

    lay2 = layout(content(2))
    (OUT_DIR / "proposal-v2.pdf").write_bytes(render(lay2, 2))
    print(f"version 1: {len(lay1.pages)} pages, version 2: {len(lay2.pages)} pages -> {OUT_DIR}")


if __name__ == "__main__":
    main()
