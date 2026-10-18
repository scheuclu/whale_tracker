"""Read the checkbox grids on a scanned House PTR paper form geometrically.

The paper form records the amount as a row of checkboxes (one column per
disclosure bracket, lettered A–K) and the transaction type as a few more
(Purchase, Sale, Partial Sale, Exchange). Every model tested reads those marks
wrong in about a quarter of rows — it loses count across the long grid —
while the grid itself is printed and ruled. So this module finds the printed
rules in the page image, works out which rules bound which block of the
table, cuts the rows at the horizontal rules, and measures the ink inside
each cell. A mark is a cell carrying far more ink than its row's others.

Four layouts occur in the 2026 corpus and all share one structure, which is
what the reader keys on: each block of the table — asset name, transaction
type, the two dates, amount — has a merged header, so the rules *between*
blocks run from the top of the table while the rules *inside* a block start
lower, under the block's header. The amount block is the rightmost run of
inner rules; the two full-height columns to its left are the dates; any
further full-height columns before the type block are flag columns (one
member's spreadsheet adds "Capital Gains > $200" and "Partial Transaction");
the type block is the next run of inner rules. Column meaning follows from
the counts: 11 amount columns are A–K, the older form's 10 are A–J; four
type columns are Purchase/Sale/Partial Sale/Exchange, three are
Purchase/Sale/Exchange.

It decides nothing it cannot measure. A row with no mark, or two, in a grid
is reported as unknown for that field, never a guess. A page with a table
that cannot be decomposed is returned with the reason on it (`GridPage.error`)
and no rows: the join (`vision.join`) matches the transcription page by
page, so that page alone yields nothing and the rest of the filing is still
read. A page with no table at all (a scanner separator sheet, a blank side,
a cover letter) contributes no rows; the join catches a transcription that
found transactions there.

numpy is imported lazily so the package imports without it; it lives in the
`vision` extra, which is what the scheduled workflow installs.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass, field

import pdfplumber

log = logging.getLogger(__name__)

# Column meanings by block width. Letter K is not an amount — it flags a
# transaction in a spouse's or dependent child's asset over $1,000,000 — and
# `vision.AMOUNT_COLUMNS` maps it to no bracket.
AMOUNT_LETTERS = {11: "ABCDEFGHIJK", 10: "ABCDEFGHIJ"}
TYPE_ACTIONS = {
    4: ("purchase", "sale", "sale_partial", "exchange"),
    3: ("purchase", "sale", "exchange"),
}
# Full-height columns between the type block and the dates. Only one shape
# has been seen: the e-filing's own two extra columns, in its order. The
# hybrid transcription checks the printed headers against this.
FLAG_COLUMNS = {0: (), 2: ("cap_gains", "partial")}

# Rasterisation. 200 dpi puts a data row at 35–80 px and a column at 40–75 px
# across the four layouts; every threshold below is relative to the page or
# the cell, so another resolution reads the same.
RENDER_DPI = 200

# Pixels darker than this are ink. Scans are near-bilevel, so the exact value
# matters little; 150 keeps light JPEG halos out.
INK_THRESHOLD = 150

# Marks. A cell is marked when its ink stands clearly above the row's others.
# In a boxed cell (the official forms) the measure is the box interior, which
# an untouched box leaves at 0.00–0.03 while a tick or X fills 0.20–0.45 of
# it: the margin over the row's median is the test. In a bare cell (the
# spreadsheet forms, and the older form's hand-drawn X) the measure is the
# central 70% of the cell, where a typed "x" is a small glyph in a large
# cell — 0.03 on the widest spreadsheet, 0.13 on the dense one, 0.3 for a
# hand-drawn X — against 0.000–0.006 of speckle in an empty cell, so the
# test is a low floor plus a share of the row's strongest cell.
BOXED_MARK_MARGIN = 0.15
BARE_INSET = 0.12
BARE_MARK_FLOOR = 0.012
BARE_MARK_SHARE = 0.5
BARE_MARK_MARGIN = 0.01
# The smallest glyph seen (a typed "x" on a faint print) inks ~60 pixels at
# RENDER_DPI; speckle in an empty cell at most ~15.
MIN_MARK_PIXELS = 30

# Ink fraction in the date cells above which a row holds a transaction. A
# typed "07/22/26" measures 0.06–0.20; the form's blank lines under 0.005.
# Above the upper bound the "row" is a filled bar (a spreadsheet's account
# heading), not text.
POPULATED_DATE_INK = (0.015, 0.6)
# Ink fraction in the asset-name cell that counts as a name being written.
POPULATED_ASSET_INK = 0.01

# Rules: a line of ink unbroken for at least this fraction of the page.
VERTICAL_MIN_RUN = 0.08
HORIZONTAL_MIN_RUN = 0.3
# Rules inside a block start at least this far below the block's boundary;
# rules level with each other differ by a few pixels at most, and on the
# spreadsheet with unequal columns the header above the inner rules is
# only ~35 px tall at 200 dpi.
INNER_RULE_OFFSET = 0.006
# A rule starting this far below the others of its block is a chain of box
# borders or a rule the scan truncated, not a rule known to be a column's.
CHAIN_OFFSET = 0.03
# An amount column is this wide, as a fraction of the page width, across
# the four layouts (40–78 px at 200 dpi on a 2200 px page).
COLUMN_PITCH = (0.016, 0.045)
# How many of a block's inner rules must be found on its fitted lines.
MIN_COLUMN_RULES = 4
# Rules of the table reach its bottom border, to within this: a faint scan
# loses the tail of a rule, not the rule.
RULE_END_TOLERANCE = 0.25
# Data rows are the modal band height; the printed example row is ~0.5 of it.
ROW_HEIGHT_BAND = (0.8, 1.25)

# A nearly empty page (a blank side) has no grid and no rows, and is not an
# error; nor is a page without a table at all.
BLANK_PAGE_INK = 0.002
TABULAR_MIN_RULES = (4, 8)   # at least this many rules each way, either axis


class GridNotFound(Exception):
    """A page whose table could not be decomposed."""


@dataclass(frozen=True)
class Layout:
    """How many columns each block of the table has, left to right."""
    type_columns: int
    flag_columns: int
    amount_columns: int

    @property
    def letters(self) -> str:
        return AMOUNT_LETTERS[self.amount_columns]

    @property
    def actions(self) -> tuple[str, ...]:
        return TYPE_ACTIONS[self.type_columns]

    @property
    def flags(self) -> tuple[str, ...]:
        return FLAG_COLUMNS[self.flag_columns]


@dataclass
class GridRow:
    page: int
    top: int
    bottom: int
    layout: Layout
    # Indexes of the cells that cleared the mark threshold, per block.
    amount_marks: list[int] = field(default_factory=list)
    type_marks: list[int] = field(default_factory=list)
    flag_marks: list[int] = field(default_factory=list)
    date_ink: float = 0.0
    asset_ink: float = 0.0
    # Whether the amount cells carry printed boxes (the official forms) or
    # are bare (the spreadsheet forms); decides how a mark is judged.
    boxed: bool = False
    amount_density: list[float] = field(default_factory=list)
    type_density: list[float] = field(default_factory=list)
    flag_density: list[float] = field(default_factory=list)
    # How clearly the strongest cell stood above the row's median — the
    # quantity the mark test compares (BOXED_MARK_MARGIN for boxed rows).
    amount_margin: float = 0.0
    type_margin: float = 0.0

    @property
    def amount(self) -> str | None:
        """The single marked amount column's letter; None for none or several."""
        if len(self.amount_marks) != 1:
            return None
        return self.layout.letters[self.amount_marks[0]]

    @property
    def flags(self) -> set[str]:
        return {self.layout.flags[i] for i in self.flag_marks}

    @property
    def action(self) -> str | None:
        """The single marked type, with a marked "partial" flag column turning
        a sale into a partial sale; None for no mark or several."""
        if len(self.type_marks) != 1:
            return None
        action = self.layout.actions[self.type_marks[0]]
        if action == "sale" and "partial" in self.flags:
            return "sale_partial"
        return action

    @property
    def cap_gains(self) -> bool | None:
        """The "capital gains > $200" flag where the form has that column."""
        if "cap_gains" not in self.layout.flags:
            return None
        return "cap_gains" in self.flags

    @property
    def filled(self) -> bool:
        """A solid bar across the row — a heading, not a transaction."""
        return self.date_ink > POPULATED_DATE_INK[1]

    @property
    def populated(self) -> bool:
        """A transaction row: it carries a date, or an asset name with a mark
        in either grid. A mark with no text at all is a stray, not a row."""
        if self.filled:
            return False
        if self.date_ink >= POPULATED_DATE_INK[0]:
            return True
        return self.asset_ink >= POPULATED_ASSET_INK and bool(self.amount_marks or self.type_marks)


@dataclass
class GridPage:
    index: int
    rotation: int
    rows: list[GridRow]
    layout: Layout | None = None
    # No table on the page: blank, a separator sheet, a cover letter.
    no_table: bool = False
    # Why the page's table could not be decomposed, when it could not. Such
    # a page has no rows; the filing's other pages are read regardless.
    error: str | None = None
    # Geometry of the oriented page, in pixels at RENDER_DPI: its size and
    # the column edges of the amount, type and flag blocks — what an overlay
    # needs to draw the reader's decisions on the page.
    width: int = 0
    height: int = 0
    amount_cols: list[int] = field(default_factory=list)
    type_cols: list[int] = field(default_factory=list)
    flag_cols: list[int] = field(default_factory=list)


@dataclass
class GridReading:
    pages: list[GridPage]

    @property
    def rows(self) -> list[GridRow]:
        """Transaction rows across every page, in page order."""
        return [r for p in self.pages for r in p.rows if r.populated]

    @property
    def unread(self) -> list[GridPage]:
        """Pages with a table the reader could not decompose."""
        return [p for p in self.pages if p.error]

    @property
    def readable(self) -> bool:
        """Whether any page's table was decomposed."""
        return any(p.layout is not None for p in self.pages)


def read_pdf(pdf_bytes: bytes) -> GridReading:
    """Read every page's grids. A page with a table that cannot be
    decomposed is returned with `error` set and no rows; nothing raises."""
    pages: list[GridPage] = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for index, page in enumerate(pdf.pages):
            image = page.to_image(resolution=RENDER_DPI).original
            pages.append(try_read_page(image, index))
    return GridReading(pages)


def try_read_page(image, index: int = 0) -> GridPage:
    """`read_page`, with a page that cannot be decomposed returned as a
    rowless GridPage carrying the reason rather than raised."""
    try:
        return read_page(image, index)
    except GridNotFound as exc:
        return GridPage(index, 0, [], error=str(exc), width=image.width, height=image.height)


def read_page(image, index: int = 0) -> GridPage:
    """Decompose the table on one page image (PIL). Tries the four
    orientations and keeps the first where the table reads."""
    import numpy as np

    ink0 = np.asarray(image.convert("L")) < INK_THRESHOLD
    if ink0.mean() < BLANK_PAGE_INK or not _tabular(ink0):
        return GridPage(index, 0, [], no_table=True, width=ink0.shape[1], height=ink0.shape[0])

    failures = []
    for rotation in (0, 90, 270, 180):
        ink = ink0 if rotation == 0 else np.ascontiguousarray(np.rot90(ink0, k=rotation // 90))
        try:
            layout, rows, table = _read_oriented(ink, index)
        except GridNotFound as exc:
            failures.append(f"{rotation}°: {exc}")
            continue
        return GridPage(index, rotation, rows, layout,
                        width=ink.shape[1], height=ink.shape[0],
                        amount_cols=list(table.amount), type_cols=list(table.types),
                        flag_cols=list(table.flags))
    raise GridNotFound(f"page {index + 1}: " + "; ".join(failures))


def _tabular(ink) -> bool:
    """Whether the page carries a ruled table in some orientation."""
    H, W = ink.shape
    n_v = len(_rules(ink, axis=0, min_run=VERTICAL_MIN_RUN * H))
    n_h = len(_rules(ink, axis=1, min_run=HORIZONTAL_MIN_RUN * W))
    lo, hi = TABULAR_MIN_RULES
    return min(n_v, n_h) >= lo and max(n_v, n_h) >= hi


# --- table decomposition ----------------------------------------------------


@dataclass
class _Table:
    layout: Layout
    top: int
    bottom: int
    amount: list[int]      # column boundaries, left to right (n+1 of them)
    dates: list[int]       # the two date columns' boundaries (3)
    flags: list[int]       # flag columns' boundaries (0 or n+1)
    types: list[int]       # type columns' boundaries (n+1)
    asset_left: int        # left edge of the asset-name region
    row_rules: list[int]   # horizontal rules spanning the table, top to bottom


def _read_oriented(ink, page_index: int) -> tuple[Layout, list[GridRow], "_Table"]:
    H, W = ink.shape
    table = _decompose(_rules(ink, axis=0, min_run=VERTICAL_MIN_RUN * H),
                       _rules(ink, axis=1, min_run=HORIZONTAL_MIN_RUN * W), H, W)
    bands = _row_bands(table.row_rules, H)
    if not bands:
        raise GridNotFound("no data rows")

    rules = [table.asset_left] + table.types + table.flags + table.dates + table.amount
    # The form is boxed or bare as a whole, and every box on a page is
    # printed alike, so the boxes are located over the whole page first:
    # the page is boxed if most amount cells hold one, and a cell whose own
    # box was not found (a border lost against the rule, a mark over it)
    # borrows the page's typical box for its block.
    blocks = {"amount": table.amount, "types": table.types, "flags": table.flags}
    located = {name: [[_locate_box(ink[r0 + 4: r1 - 4, c0 + 4: c1 - 4], r1 - r0, c1 - c0)
                       for c0, c1 in zip(cols, cols[1:])] for r0, r1 in bands]
               for name, cols in blocks.items()}
    amount_boxes = [b for row in located["amount"] for b in row]
    boxed = sum(b is not None for b in amount_boxes) * 2 > len(amount_boxes)
    typical = {name: _typical_box([b for row in found for b in row])
               for name, found in located.items()}

    rows = []
    for k, (r0, r1) in enumerate(bands):
        a = _block_ink(ink, r0, r1, table.amount, boxed, located["amount"][k], typical["amount"])
        t = _block_ink(ink, r0, r1, table.types, boxed, located["types"][k], typical["types"])
        f = _block_ink(ink, r0, r1, table.flags, boxed, located["flags"][k], typical["flags"])
        rows.append(GridRow(
            page=page_index, top=r0, bottom=r1, layout=table.layout, boxed=boxed,
            amount_marks=_marks(a, boxed),
            type_marks=_marks(t, boxed),
            flag_marks=_marks(f, boxed, independent=True),
            date_ink=_region_ink(ink, r0, r1, table.dates[0], table.dates[-1], rules),
            asset_ink=_region_ink(ink, r0, r1, table.asset_left, table.types[0], rules),
            amount_density=[round(d, 3) for d in a],
            type_density=[round(d, 3) for d in t],
            flag_density=[round(d, 3) for d in f],
            amount_margin=_margin(a),
            type_margin=_margin(t),
        ))
    return table.layout, rows, table


def _margin(densities: list[float]) -> float:
    """The strongest cell's lead over the row's median."""
    import numpy as np

    if not densities:
        return 0.0
    return round(float(max(densities) - np.median(densities)), 3)


def _decompose(verticals: list[tuple[int, int, int]],
               horizontals: list[tuple[int, int, int]], H: int, W: int) -> _Table:
    """Find the table's blocks from the rules and their extents.

    The row rules give the table's width: they run border to border, so
    their shared end is the right edge even on a scan that lost the vertical
    border itself (common — the right edge is where a fed sheet fades). The
    amount block is then the rightmost run of nine or ten rules inside the
    table that all start below the rule on their left — its merged header —
    and the blocks to its left follow from which rules start at the table
    top and which start under a header. The table ends where the amount
    rules do: the official forms print a "filer notes" box underneath whose
    rows must not read as transactions.
    """
    import numpy as np

    wide = [(y, x0, x1) for y, x0, x1 in horizontals if x1 - x0 >= 0.5 * W]
    if len(wide) < 3:
        raise GridNotFound(f"only {len(wide)} wide horizontal rules")
    right = _mode([x1 for _, _, x1 in wide], 0.01 * W)
    left = _mode([x0 for _, x0, _ in wide], 0.01 * W)
    spanning = sorted(y for y, x0, x1 in wide
                      if x0 <= left + 0.02 * W and x1 >= right - 0.02 * W)
    if len(spanning) < 2:
        raise GridNotFound("no rules span the table")
    bottom0 = max(spanning)
    xtol = 0.01 * W

    # Rules that belong to the table: inside its width, reaching (nearly)
    # its bottom.
    rules = sorted(
        (x, y0, y1) for x, y0, y1 in verticals
        if left - xtol <= x <= right + xtol
        and y1 >= bottom0 - RULE_END_TOLERANCE * H and y0 < bottom0 - 0.1 * H)
    if len(rules) < 12:
        raise GridNotFound(f"only {len(rules)} vertical rules reach the table bottom")
    inner = [i for i, (x, _, _) in enumerate(rules) if x < right - xtol]

    # The amount block: scan left boundaries from the right. Among the rules
    # to the right of a candidate, some are not column rules and are set
    # aside before counting: ones much shorter than the others (the rotated
    # header text of the last column can chain into a short one), ones a few
    # pixels from a neighbour (box borders chaining just inside a cell rule
    # make a column narrower than any the form has), and ones whose extent
    # disagrees with the block's — a chain of box borders starts at the
    # first row of boxes and ends at the last, while column rules run from
    # the header to the table bottom. A rule the scan truncated looks like
    # the last kind, so the block is first fitted without the suspects and,
    # failing that, with them: the spreadsheet with unequal columns has no
    # boxes to chain, and does lose the tops of its thin rules.
    def fit(li: int) -> tuple[list[int], list[int]] | None:
        """The amount block with `rules[li]` as its left boundary, or None.

        On the official forms and the common spreadsheet the columns are an
        equal subdivision of the block, so the block is fitted as one — ten
        or eleven columns between the boundary and the table's right edge —
        and the fit is accepted when the column rules the scan did keep sit
        on its lines and every rule that starts in the header is one of
        them. A scan may lose the top half of several rules to dropouts, or
        add a column of box borders beside each one; neither moves the
        lines that remain. The spreadsheet with unequal columns is the
        fallback: all ten of its inner rules, as found.
        """
        x_left, y_left = rules[li][0], rules[li][1]
        members = [i for i in inner if i > li]
        if not members:
            return None
        # Rules starting in the header — at the earliest height several
        # members share — are column rules for certain; chains and
        # truncated rules start lower. Any of them level with the boundary
        # means this is not a boundary. The block's typical rule length is
        # theirs: chains can outnumber rules, two to a box.
        start = _shared(sorted(rules[i][1] for i in members), 0.01 * H)
        trusted = [i for i in members if rules[i][1] <= start + CHAIN_OFFSET * H]
        if any(rules[i][1] <= y_left + INNER_RULE_OFFSET * H for i in trusted):
            return None
        typical = float(np.median([rules[i][2] - rules[i][1]
                                   for i in (trusted if len(trusted) >= 3 else members)]))
        members = [i for i in members if rules[i][2] - rules[i][1] >= 0.5 * typical]
        trusted = [i for i in trusted if i in members]

        best = None
        for n in (11, 10):
            pitch = (right - x_left) / n
            if not COLUMN_PITCH[0] * W <= pitch <= COLUMN_PITCH[1] * W:
                continue
            tol = 0.25 * pitch
            cols, used, residual = [x_left], [], 0.0
            for k in range(1, n):
                point = x_left + k * pitch
                near = [i for i in members if abs(rules[i][0] - point) <= tol and i not in used]
                if near:
                    # A rule known to be a column's takes the line over a
                    # chain that happens to sit nearer it.
                    i = min(near, key=lambda i: (i not in trusted, abs(rules[i][0] - point)))
                    used.append(i)
                    residual += abs(rules[i][0] - point)
                    cols.append(rules[i][0])
                else:
                    cols.append(int(round(point)))
            cols.append(right)
            if len(used) < MIN_COLUMN_RULES or not all(i in used for i in trusted):
                continue
            score = (len(used), -residual)
            if best is None or score > best[0]:
                best = (score, used, cols)
        if best is not None:
            return best[1], best[2]

        attempt = _drop_narrow(rules, members, x_left, right)
        if len(attempt) == 10 and all(rules[i][1] > y_left + INNER_RULE_OFFSET * H
                                      for i in attempt):
            cols = [x_left] + [rules[i][0] for i in attempt] + [right]
            if _recover_column(cols, W) is not None:
                return attempt, cols
        return None

    found = None
    for k, li in enumerate(reversed(inner)):
        result = fit(li)
        if result is None:
            continue
        if len(result[1]) == 11 and k + 1 < len(inner):
            # Ten columns read. A stamp or smudge can lift the top of the
            # first inner rule of an eleven-column block enough for it to
            # pass as the boundary; if the rule to the left bounds a full
            # eleven-column block, that is the block. The older form's real
            # ten-column block cannot do this: the rule to its left is a
            # date divider, starting level with its boundary, not above.
            wider = fit(list(reversed(inner))[k + 1])
            if wider is not None and len(wider[1]) == 12:
                li, result = list(reversed(inner))[k + 1], wider
        found = (li, *result)
        break
    if found is None:
        raise GridNotFound("no amount block of 10 or 11 columns under a merged header")
    li, members, amount_cols = found
    n_amount = len(amount_cols) - 1

    table_top = int(rules[li][1])
    inner_y = float(np.median([rules[i][1] for i in members]))
    threshold = table_top + 0.5 * (inner_y - table_top)
    # Where the amount rules end is where the transaction table ends.
    bottom = int(max(rules[i][2] for i in members))

    # The same stray rules occur left of the amount block: short ones (a
    # stamp, handwriting) and box-border chains starting below the header.
    typical = float(np.median([rules[i][2] - rules[i][1] for i in members]))
    keep = [k for k, (x, y0, y1) in enumerate(rules)
            if k >= li or (y1 - y0 >= 0.5 * typical and y0 <= inner_y + CHAIN_OFFSET * H)]
    rules = [rules[k] for k in keep]
    li = keep.index(li)

    def full(i: int) -> bool:
        # A full-height column rule starts at the table top — or, when a
        # faint scan lost its top, anywhere but the one height the inner
        # rules share. Chains were dropped above.
        return rules[i][1] <= threshold or rules[i][1] > inner_y + INNER_RULE_OFFSET * H

    # Walk left: full-height columns up to the type block's inner rules.
    i = li
    full_cols = []
    while i - 1 >= 0 and full(i - 1):
        full_cols.append(rules[i - 1][0])
        i -= 1
    # full_cols holds the left boundaries, nearest first; the dates are the
    # two columns adjacent to the amount block.
    if len(full_cols) < 2:
        raise GridNotFound("fewer than two full-height columns left of the amounts")
    n_flags = len(full_cols) - 2
    if n_flags not in FLAG_COLUMNS:
        raise GridNotFound(f"{n_flags} flag column(s) between the dates and the type block")
    # Now rules[i] is the type block's right boundary and the inner rules
    # of the type block follow leftwards until its left boundary. Its boxes
    # chain into narrow columns just like the amount block's.
    j = i
    type_inner = []
    while j - 1 >= 0 and not full(j - 1):
        type_inner.append(j - 1)
        j -= 1
    if j - 1 < 0:
        raise GridNotFound("type block has no left boundary")
    type_inner = _drop_narrow(rules, sorted(type_inner), rules[j - 1][0], rules[i][0])
    types = [rules[j - 1][0]] + [rules[k][0] for k in type_inner] + [rules[i][0]]
    if n_flags == 0 and not _regular(types) and len(type_inner) >= 3:
        # The walk ran past a lost left boundary into the asset block. The
        # type columns are printed evenly, so the block is the run of
        # evenly spaced rules at its right, and its boundary one pitch
        # further left.
        run = _regular_run(types[1:])
        if run is not None and len(run) >= 3:
            pitch = (run[-1] - run[0]) / (len(run) - 1)
            types = [int(round(run[0] - pitch))] + run
            if types[0] - rules[j - 1][0] < pitch:
                types = None
    n_types = len(types) - 1 if types else 0
    if n_types not in TYPE_ACTIONS:
        raise GridNotFound(f"{n_types} type columns")
    if n_flags == 0 and not _regular(types):
        # Three and four type columns mean different things, and the forms
        # print both evenly. A four-column block that lost a rule would read
        # as three and call every partial sale an exchange. The spreadsheet
        # with flag columns has an uneven type block by design.
        raise GridNotFound("type columns are not evenly spaced: a rule is missing")

    boundaries = sorted(full_cols) + [rules[li][0]]   # type-right … amount-left
    dates = boundaries[-3:]
    flags = boundaries[:-2] if n_flags else []
    asset_left = rules[j - 2][0] if j - 2 >= 0 else left
    row_rules = [y for y in spanning if table_top - 0.01 * H <= y <= bottom + 0.01 * H]
    return _Table(
        layout=Layout(n_types, n_flags, n_amount),
        top=table_top, bottom=bottom,
        amount=amount_cols, dates=dates, flags=flags, types=types,
        asset_left=asset_left, row_rules=row_rules,
    )


def _drop_narrow(rules: list[tuple[int, int, int]], members: list[int],
                 left_x: int, right_x: int) -> list[int]:
    """Remove rules that make a column under half the block's typical width.

    Such a rule is a chain of checkbox borders, printed a few pixels inside
    the real cell rule. Of the pair, the one that starts lower is the chain
    (boxes begin at the first data row; rules in the header); a rule against
    the block's own boundary is the one dropped.
    """
    import numpy as np

    members = list(members)
    while len(members) >= 1:
        xs = [left_x] + [rules[i][0] for i in members] + [right_x]
        widths = np.diff(xs)
        median = float(np.median(widths))
        narrow = [k for k, w in enumerate(widths) if w < 0.4 * median]
        if not narrow or median <= 0:
            break
        k = narrow[0]
        if k == 0:
            members.pop(0)
        elif k >= len(members):
            members.pop()
        else:
            a, b = members[k - 1], members[k]
            (_, ya, ea), (_, yb, eb) = rules[a], rules[b]
            drop = a if (ya, -(ea - ya)) > (yb, -(eb - yb)) else b
            members.remove(drop)
    return members


def _recover_column(cols: list[int], W: int) -> list[int] | None:
    """Validate the amount columns' widths; mend up to two lost rules.

    Ten or eleven columns are accepted. On the official forms every column
    is the same width, so a column measuring double means a scan dropped
    the rule between two columns — put back at the midpoint, since letters
    right of the gap would otherwise all shift. One member's spreadsheet has
    unequal columns by design, but its first is a normal one and its block
    is eleven wide, which is enough to tell the shapes apart. Anything else
    is not a layout this reader knows, and reads as none.
    """
    import numpy as np

    widths = np.diff(cols).astype(float)
    median = float(np.median(widths))
    if median <= 0:
        return None
    ratio = widths / median
    regular = bool(np.all((ratio > 0.8) & (ratio < 1.25)))
    if len(cols) == 12 and regular:
        return cols
    if len(cols) == 12 and 0.8 < ratio[0] < 1.25 and np.all(ratio > 0.6):
        # The unequal spreadsheet.
        return cols
    if len(cols) == 11 and regular:
        return cols
    # A regular grid with one or two columns of double width: each is a
    # lost rule. Inserted at the midpoints; the result must be a whole,
    # regular block of ten or eleven.
    doubles = [k for k, r in enumerate(ratio) if 1.75 < r < 2.3]
    rest = np.delete(ratio, doubles)
    if not 1 <= len(doubles) <= 2 or not np.all((rest > 0.8) & (rest < 1.25)):
        return None
    if len(cols) + len(doubles) not in (11, 12):
        return None
    mended = list(cols)
    for k in reversed(doubles):
        mended.insert(k + 1, int(round((cols[k] + cols[k + 1]) / 2)))
    return mended


def _regular(cols: list[int], spread: float = 0.35) -> bool:
    """Whether consecutive boundaries are evenly spaced, to within `spread`
    of the median width."""
    import numpy as np

    widths = np.diff(cols).astype(float)
    median = float(np.median(widths))
    return median > 0 and bool(np.all(np.abs(widths / median - 1) <= spread))


def _regular_run(xs: list[int], spread: float = 0.35) -> list[int] | None:
    """The longest run of evenly spaced positions ending at the last of
    `xs` (positions ascending), or None if there is no such run of two."""
    xs = sorted(xs)
    if len(xs) < 2:
        return None
    pitch = xs[-1] - xs[-2]
    if pitch <= 0:
        return None
    run = [xs[-2], xs[-1]]
    for x in reversed(xs[:-2]):
        if abs((run[0] - x) / pitch - 1) <= spread:
            run.insert(0, x)
        else:
            break
    return run


def _mode(values: list[int], tol: float) -> int:
    """The value shared by the most others, to within `tol`."""
    import numpy as np

    arr = np.array(values)
    best = max(values, key=lambda v: (int(np.sum(np.abs(arr - v) <= tol)), -v))
    return int(np.median(arr[np.abs(arr - best) <= tol]))


def _shared(values: list[int], tol: float, least: int = 3) -> int:
    """The first value in `values` that at least `least` of them lie within
    `tol` of; the first value when none is shared."""
    import numpy as np

    arr = np.array(values)
    for v in values:
        if int(np.sum(np.abs(arr - v) <= tol)) >= least:
            return int(v)
    return int(values[0])


def _rules(ink, axis: int, min_run: float) -> list[tuple[int, int, int]]:
    """Positions of long straight rules, as (position, start, end).

    axis=0 finds vertical rules (one position per column), axis=1 horizontal.
    A rule is a line of ink whose longest unbroken run is at least `min_run`
    pixels. The mask is thickened by two pixels across the rule first, so a
    slight scanner skew — which spreads one line over several columns — does
    not break the run, and closed by four along it to bridge the dropouts of
    a faint scan. Adjacent hits are one rule.
    """
    import numpy as np

    m = ink if axis == 0 else ink.T
    across = m.copy()
    for k in (1, 2):
        across |= np.roll(m, k, axis=1) | np.roll(m, -k, axis=1)
    # Two pixels along: enough to close the pinholes of a thin line, not the
    # gap between a stacked column of typed glyphs and the row rule beneath
    # them, which a dense spreadsheet would otherwise chain into a "rule".
    # Larger dropouts are healed by `_extent` on the detected rules only.
    along = across.copy()
    for k in (1, 2):
        along |= np.roll(across, k, axis=0) | np.roll(across, -k, axis=0)
    runs = _run_lengths(along)
    longest = runs.max(axis=0)
    hits = np.where(longest >= min_run)[0]

    groups: list[list[int]] = []
    for p in hits:
        if groups and p - groups[-1][-1] <= 3:
            groups[-1].append(int(p))
        else:
            groups.append([int(p)])

    n = along.shape[0]
    out = []
    for g in groups:
        # The extent over every column of the group: a thin rule wanders a
        # pixel or two across a scan, and no single column holds all of it.
        start, end = _extent(along[:, g[0]:g[-1] + 1].any(axis=1), n)
        if axis == 1 and len(g) > BAR_THICKNESS:
            # A filled bar across the table (a spreadsheet's account heading
            # printed white on black) is not a row rule at its centre: its
            # two edges are where the rows above and below it end and begin.
            out.append((g[0], start, end))
            out.append((g[-1], start, end))
        else:
            out.append((int(round(sum(g) / len(g))), start, end))
    return out


# A horizontal "rule" thicker than this many pixels is a filled bar, not a
# line: the boldest printed rule is ~8 px at 200 dpi, 12 after dilation.
BAR_THICKNESS = 20


# A rule's extent is its longest run, extended across the dropouts of a
# faint scan: a gap of at most DROPOUT_GAP of the page is bridged when the
# piece beyond it is at least DROPOUT_PIECE long. Both are small — a
# dropout is a pinhole of 10–30 px — so that a column of checkbox borders
# cannot be joined across the header gap to the rotated label text above
# it and come out looking like a rule that starts in the header.
DROPOUT_GAP = 0.02
DROPOUT_PIECE = 0.015


def _extent(col, n: int) -> tuple[int, int]:
    import numpy as np

    d = np.diff(np.concatenate(([0], col.astype(np.int8), [0])))
    starts = np.where(d == 1)[0]
    ends = np.where(d == -1)[0] - 1
    lengths = ends - starts + 1
    k = int(lengths.argmax())
    s, e = int(starts[k]), int(ends[k])
    gap, piece = DROPOUT_GAP * n, DROPOUT_PIECE * n
    long_pieces = [(int(a), int(b)) for a, b, ln in zip(starts, ends, lengths) if ln >= piece]
    changed = True
    while changed:
        changed = False
        for a, b in long_pieces:
            if a > e and a - e <= gap:
                e, changed = b, True
            elif b < s and s - b <= gap:
                s, changed = a, True
    return s, e


def _run_lengths(mask):
    """At each position, the length of the run of True ending there, down
    each column."""
    import numpy as np

    m = mask.astype(np.int32)
    c = np.cumsum(m, axis=0)
    resets = np.where(m == 0, c, 0)
    return c - np.maximum.accumulate(resets, axis=0)


def _row_bands(ys: list[int], H: int) -> list[tuple[int, int]]:
    """Consecutive rule pairs of the modal data-row height."""
    import numpy as np

    ys = sorted(set(ys))
    gaps = [(a, b) for a, b in zip(ys, ys[1:]) if b - a >= 0.012 * H]
    if not gaps:
        return []
    heights = np.array([b - a for a, b in gaps])
    # The data rows are the plurality: the height most bands share, to
    # within a few pixels. Ties go to the shorter, since the header bands
    # are the tall ones.
    best_h, best_n = None, 0
    for h in heights:
        n = int(np.sum(np.abs(heights - h) <= 0.004 * H))
        if n > best_n or (n == best_n and best_h is not None and h < best_h):
            best_h, best_n = int(h), n
    assert best_h is not None
    lo, hi = ROW_HEIGHT_BAND[0] * best_h, ROW_HEIGHT_BAND[1] * best_h
    return [(a, b) for a, b in gaps if lo <= b - a <= hi]


# A printed box border spans most of the row height, so its column in the
# cell's ink profile is this full; a mark's stroke crossing a column is not.
BORDER_PROFILE = 0.45
# A box is 0.45–0.92 of its cell on either axis; anything else is not a box.
BOX_EXTENT = (0.45, 0.92)
# Inside the box border by this share of the box, plus the border's own
# thickness: the official forms print each box with a doubled, offset
# outline, and the inner line must stay outside the measured interior.
BOX_INSET = 0.15


def _block_ink(ink, r0: int, r1: int, cols: list[int], boxed: bool,
               boxes: list, typical: tuple[int, int, int, int] | None) -> list[float]:
    """Ink fraction per cell of one block of a row.

    On a boxed page each cell is measured inside its box — its own where
    `_locate_box` found it, the page's typical one for that block where it
    did not, and a central window when the block has no boxes located at
    all. Measuring inside the box makes the reading indifferent to where
    the box sits in the cell (the printing shifts boxes between rows) and
    to a doubled outline. On a bare page (the spreadsheet forms, the older
    form's hand-drawn X) each cell is measured over its central 70%: a
    typed "x" is a small glyph low in a large cell, and the window must
    reach it while staying clear of the cell rules.
    """
    if len(cols) < 2:
        return []
    h = r1 - r0
    out = []
    for (c0, c1), box in zip(zip(cols, cols[1:]), boxes):
        w = c1 - c0
        if boxed and (box or typical):
            top, bottom, left, right = box or typical
            dy = 3 + int(BOX_INSET * (bottom - top))
            dx = 3 + int(BOX_INSET * (right - left))
            inner = ink[r0 + 4 + top + dy: r0 + 4 + bottom - dy + 1,
                        c0 + 4 + left + dx: c0 + 4 + right - dx + 1]
        else:
            inset = BARE_INSET if not boxed else 0.3
            inner = ink[r0 + int(inset * h): r1 - int(inset * h),
                        c0 + int(inset * w): c1 - int(inset * w)]
            if not boxed and inner.size:
                inner = _without_lines(inner)
        if not inner.size:
            out.append(0.0)
            continue
        density = float(inner.mean())
        if not boxed and density * inner.size < MIN_MARK_PIXELS:
            # Fewer inked pixels than any glyph has: speckle, read as none,
            # whatever fraction of a small window it happens to be.
            density = 0.0
        out.append(density)
    return out


def _without_lines(region):
    """The region with any rule crossing it blanked: a row or column of the
    window inked nearly end to end is a printed line that strayed into the
    window (a thick or offset cell rule in a dense table), never a glyph."""
    import numpy as np

    region = region.copy()
    rows = np.where(region.mean(axis=1) >= 0.8)[0]
    cols = np.where(region.mean(axis=0) >= 0.8)[0]
    region[rows, :] = False
    region[:, cols] = False
    return region


def _typical_box(boxes: list) -> tuple[int, int, int, int] | None:
    """The median box of those found in one block across a page."""
    import numpy as np

    found = [b for b in boxes if b is not None]
    if not found:
        return None
    return tuple(int(round(float(np.median([b[k] for b in found])))) for k in range(4))


def _locate_box(cell, h: int, w: int) -> tuple[int, int, int, int] | None:
    """The checkbox printed in a cell, as (top, bottom, left, right) within
    the cell crop; None when no box-sized pair of borders is found."""
    if cell.size == 0:
        return None
    pair = _border_pair(cell.mean(axis=0), w)
    if pair is None:
        return None
    left, right = pair
    rows = _border_pair(cell[:, left:right + 1].mean(axis=1), h)
    if rows is None:
        return None
    return rows[0], rows[1], left, right


def _border_pair(profile, extent: int) -> tuple[int, int] | None:
    """The innermost pair of border lines in a 1-D ink profile that are a
    box's width apart, as (first, last) positions."""
    import numpy as np

    hits = np.where(profile >= BORDER_PROFILE)[0]
    if len(hits) < 2:
        return None
    groups: list[list[int]] = []
    for p in hits:
        if groups and p - groups[-1][-1] <= 2:
            groups[-1].append(int(p))
        else:
            groups.append([int(p)])
    best = None
    for a in range(len(groups)):
        for b in range(a + 1, len(groups)):
            span = groups[b][-1] - groups[a][0]
            if BOX_EXTENT[0] * extent <= span <= BOX_EXTENT[1] * extent:
                if best is None or span < best[1] - best[0]:
                    best = (groups[a][0], groups[b][-1])
    return best


def _region_ink(ink, r0: int, r1: int, c0: int, c1: int, rules: list[int]) -> float:
    """Ink fraction across a span of cells, with the printed rules masked out."""
    h = r1 - r0
    region = ink[r0 + int(0.2 * h): r1 - int(0.2 * h), c0 + 4: c1 - 4].copy()
    if region.size == 0:
        return 0.0
    for x in rules:
        if c0 <= x <= c1:
            lo, hi = x - 4 - (c0 + 4), x + 5 - (c0 + 4)
            region[:, max(0, lo): max(0, hi)] = False
    return float(region.mean())


def _marks(densities: list[float], boxed: bool, independent: bool = False) -> list[int]:
    """Indexes of the cells inked clearly above the row's others — or, for
    `independent` cells (the flag columns, any of which may be marked
    together), above the floor on their own."""
    import numpy as np

    if not densities:
        return []
    if independent:
        floor = BOXED_MARK_MARGIN if boxed else BARE_MARK_FLOOR
        return [i for i, d in enumerate(densities) if d >= floor]
    base = float(np.median(densities))
    if boxed:
        return [i for i, d in enumerate(densities) if d - base >= BOXED_MARK_MARGIN]
    top = max(densities)
    return [i for i, d in enumerate(densities)
            if d >= BARE_MARK_FLOOR and d >= BARE_MARK_SHARE * top
            and d - base >= BARE_MARK_MARGIN]
