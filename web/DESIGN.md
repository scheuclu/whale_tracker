# FatCat Watch — design system v2

The spec every page is built to. Values live in `app/globals.css` (`:root` /
`.dark`, mapped to Tailwind utilities in `@theme inline`); the components are
in `app/charts.tsx`, `app/page-header.tsx`, `app/ui.tsx`, `app/disclosure.tsx`.
Data-viz colours (`--viz-*`) are also governed by CLAUDE.md, "Data-viz".

## Direction

**An editorial data publication, not a SaaS dashboard.** Think ProPublica's
Represent, the FT and Bloomberg graphics desks, The Economist's charts — with
a little wit from the fat cat. Concretely:

1. **Paper and ink.** A warm paper page, near-black warm ink, a deep-ink dark
   mode. Content sits *on the paper*; it is not put in boxes.
2. **Rules, not cards.** A section is announced by a 1px ink rule and a serif
   heading. Hairlines separate rows. Whitespace does the rest.
3. **A typographic voice.** Newsreader (serif) for headlines, section heads
   and hero figures; Inter for interface and body; Geist Mono for tickers and
   ids. Real hierarchy: kicker → headline → dek → body.
4. **One accent, used sparingly.** The gold of the cat's bow tie: the active
   section, kickers, focus, selection, the reader's-note rule, magnitude bars.
   Never a button, never body text on paper.
5. **Blue↔red is direction, and only direction.** Bought is blue, sold is
   red, everywhere, always also in words. Nothing else may be blue or red.
6. **State the caveat once, well.** Load-bearing caveats (ranges, estimates,
   shares × reported price, quarantined scans) live in a `Disclosure` — one
   quiet, consistent place — not as repeated grey sentences under every widget.

## Colour

### Surfaces

| Role | Token / utility | Light | Dark |
| --- | --- | --- | --- |
| Page (paper) | `--background` / `bg-background` | `#f7f4ed` | `#131311` |
| Panel (a form, a link card) | `--card` / `bg-card` | `#fcfbf7` | `#1b1a17` |
| Hover wash, raised step | `--raised` / `bg-raised` | `#efebe2` | `#24231f` |
| Popover / tooltip | `--popover` / `bg-popover` | `#fffefa` | `#22211d` |
| Text field, secondary button | `--field` | `#fffefa` | `#1b1a17` |
| Opaque overlay that must match the page (sticky column, scroll fade, a mark's ring) | `--card-solid` | `#f7f4ed` | `#131311` |

`--card-solid` is the **paper**, because tables and charts now sit on it. If
you put an overlaying element inside a panel, give it `bg-card` explicitly.

### Ink

| Level | Token / utility | Light | Dark | On paper (light / dark) |
| --- | --- | --- | --- | --- |
| 1 | `--foreground` / `text-foreground` | `#1a1915` | `#ede9df` | 16.0 / 15.3 |
| 2 | `--ink-2` / `text-ink-2` | `#45423a` | `#c5c0b4` | 9.1 / 10.3 |
| 3 | `--muted-foreground` / `text-muted-foreground` | `#6a6558` | `#9a9486` | 5.3 / 6.2 |

All three pass WCAG AA (4.5:1) on paper, panel and the hover wash in both
modes. Do not fade muted text further with an opacity modifier.

### Lines

| Token / utility | Light | Dark | Use |
| --- | --- | --- | --- |
| `--rule` / `border-rule` | `#1a1915` | `#ede9df` | the 1px ink rule over a section, under the masthead, over the footer |
| `--border` / `border-border` | ink 13% | paper 12% | every hairline: rows, fact strips, panels |
| `--border-strong` | ink 24% | paper 22% | hover edge, dashed "transcribed" chip |
| `--input` / `border-input` | ink 22% | paper 20% | form controls |

### The accent (bow-tie gold)

| Token / utility | Light | Dark | Use |
| --- | --- | --- | --- |
| `--gold` / `bg-gold`, `border-gold` | `#e9a913` | `#f3c04f` | marks only: active-section bar, reader's-note rule, link-hover underline, the tie. 1.9:1 on light paper — never text. |
| `--primary` / `text-primary` | `#8a5d00` | `#f3c04f` | the gold's text-safe ink: kickers, focus ring. 5.2:1 / 11.0:1. |
| `--accent` / `bg-accent` | gold 16% | gold 14% | ticker-chip hover wash |
| `--selection` | gold 40% | gold 30% | text selection — a highlighter |
| `--ring` | `#8a5d00` | `#f3c04f` | focus ring |

The **primary button is ink** (`bg-foreground text-background`), not gold. A
gold button reads as a warning and spends the accent on chrome.

### Status (pipeline and filing state — never buy/sell, never the accent)

| Token | Light | Dark |
| --- | --- | --- |
| `--ok` | `#2a7049` | `#5bb585` |
| `--attention` | `#a34f0b` (burnt orange, so it never reads as the brand gold) | `#f0954a` |
| `--error` (`--destructive`) | `#b8322f` | `#ef7d74` |

Each has a `*-soft` 10–13% wash for pills. Status always ships with a word.

### Data-viz roles (`--viz-*`)

| Role | Light | Dark | Notes |
| --- | --- | --- | --- |
| `--viz-buy` | `#2a78d6` | `#3987e5` | bought; diverging pair with sell |
| `--viz-sell` | `#d03b3b` | `#e66767` | sold |
| `--viz-seq` | `#cf9a1c` | `#d9a53a` | single-series magnitude (volume bars, the range band, sparkbars' current period). Gold, stepped to stay clear of sell-red under deuteranopia. |
| `--viz-track` | ink 7% | paper 8% | empty bar track |
| `--viz-grid` / `--viz-axis` | `#e4dfd3` / `#8a8578` | `#2b2a26` / `#8a8578` | recessive grid and axes |
| `--viz-rung-off/below/on` | `#e4dfd3` / `#a29c8d` / `#3b3830` | `#2a2925` / `#6a655b` / `#ece8df` | the bracket ladder (neutral ordinal ramp) |
| `--viz-price` / `--viz-bench` | `#3b3830` / `#8e887b` | `#ece8df` / `#6a665d` | price overlay: one ink, one grey |

Validated with the `dataviz` skill's `validate_palette.js` against the v2
surfaces (re-run it before changing any value):

- buy · sell · seq, `--pairs all` — light: worst CVD ΔE 14.6 (seq/sell,
  deutan), normal-vision 21.6, seq contrast 2.31:1 (WARN: relief by direct
  labels — every gold mark prints its value); dark: CVD 10.2, normal 16.8,
  all ≥ 3:1, seq above the categorical dark L band (0.752) — accepted, it is
  a single-hue magnitude role, never a categorical slot.
- buy/sell alone (unchanged hues): 23.8 light / 19.2 dark, as before.
- price · bench · buy · sell, `--pairs all` — light CVD 8.3, normal 18.5;
  dark CVD 8.8, normal 20.8; all ≥ 3:1.
- rung below → on, `--ordinal` — both modes pass (monotone L, ΔL ≥ 0.06,
  light end 2.49:1 light / 3.21:1 dark).

**Transcribed (scanned) rows are not a colour.** They are drawn hollow and
dashed (the bracket ladder, the timeline) or hatched in ink (the Trends
"Scans transcribed" columns), and always say "transcribed from scan" in words.
Amber used to mark them; it now belongs to nobody, and gold is the accent.

## Type

Families (all self-hosted by `next/font`, Latin subset, `display: swap` with
metric-adjusted fallbacks; no third-party origin):

- **Newsreader** (`font-serif`, `--font-serif`) — variable on the weight axis
  only (the optical-size axis would more than double the file, 132 KB against
  58 KB, and the headline is the phone LCP). Lining figures (`.font-serif`).
- **Inter** (`font-sans`, the body default) — `cv05`/`cv08` on, so l/I/1 are
  distinct in names and tickers.
- **Geist Mono** (`font-mono`) — tickers, filing ids, code.

Numbers: `.tabular` (tabular lining figures) on every number in a table or
list; `.figure` for a serif hero number (lining + tabular).

### Scale

| Role | Class / component | Size (phone → ≥640px) | Face |
| --- | --- | --- | --- |
| Page headline (h1) | `PageHeader` / `.display` | 34 → 46px, leading 1.04–1.06 | Newsreader 500 |
| Dek (one-sentence summary) | `PageHeader subtitle` / `.dek` | 17 → 19px, leading 1.45 | Newsreader 400, ink 2 |
| Kicker / eyebrow | `.kicker` | 11.5px caps, +0.085em | Inter 600, `--primary` |
| Section head (h2) | `SectionTitle` | 19 → 21px | Newsreader 600 |
| Hero figure | `StatTile` / `.figure` | 28 → 34px | Newsreader 500 |
| Fact-strip figure | `FactStrip` | 20px | Newsreader 500 |
| Reader's note lead | `Disclosure size="md"` | 16px | Newsreader 400 |
| Body, list rows | — | 13–14px | Inter |
| Meta, captions, footnotes | — | 12–12.5px | Inter, muted |
| Badges | `ui.tsx` chips | 11px | Inter 500 |

Unit suffixes on a figure (k, M, B, %, d) render at 0.7em in muted ink
(`Figure`, automatic in StatTile/FactStrip/MagnitudeBars). Sentence case
everywhere except the kicker; no other tracked capitals.

## Layout

- Content column `max-w-6xl` (1152px); gutters 16px phone / 24px from `sm`.
- Sections 28px apart on a phone, 40px from `sm` (`.page-flow`); each one
  opens with a `SectionTitle` rule.
- Open content (charts, lists, tables) is **flush with the column** from
  640px: its text meets the section title's edge and its rules meet the
  section rule's ends. On a phone, lists and tables run edge to edge with the
  16px gutter as their inset (`ResponsiveTable`, `FeedList`, `TradeList`).
- 4px spacing grid; gaps 8 / 12 / 16 / 24.

## Fewer boxes

`Card` has two variants:

- `open` (default) — no box. Use for charts, ranked bars, lists, tables:
  almost everything.
- `panel` — hairline, `bg-card`, 4px radius, no shadow. Only for things that
  are genuinely an object: a form (`FilterBar`), a grid of link cards, a
  popover-like box.

Radius: 4px panels and controls, 3px chips, 2px small marks; fully round only
for status pills and avatars (the `rounded-xl…4xl` utilities are capped at
4px). Elevation: none, except popovers and tooltips (`shadow-popover`). No
glass, no gradients, no glow.

## Components

- **Masthead** (`layout.tsx`, `nav.tsx`, `header-shell.tsx`) — solid paper,
  ink rule beneath. Brand (tile-less cat + serif wordmark), five reader
  sections in words — Feed, Members (`/politicians`), Tickers, Insiders,
  Trends — search (a field from 640px, a link to `/search` on a phone), theme
  toggle. Active section: ink text, a 3px gold bar standing on the rule,
  `aria-current`. One row from 1024px; below it the sections take a second
  row, and on a phone only that row stays pinned (`.site-header` sticks at
  `top: -3rem`). No icons, no status pill.
- **Footer** (`site-footer.tsx`) — ink rule above. Brand + counts + the one
  freshness line ("Updated 25m ago", the pipeline's last run — the same clock
  as `/api/health`; "the pipeline is behind schedule" in words when stale);
  Sections; **About the data** (Methodology, Pipeline, Scanned filings, Alert
  log, API — and Contact when it exists); Sources; "Reading the numbers" (the
  three governing caveats; do not drop one); legal row.
- **PageHeader** — `back` / `share` row, `eyebrow` (kicker), `title` (h1,
  serif), `badges`, `subtitle` (dek), `aside`, then `children` (the facts).
  Every index page sets a kicker ("Congress · by member", "SEC Form 4",
  "About the data").
- **SectionTitle** — ink rule, serif h2, optional `kicker`, `right` meta.
- **StatTile** — a figure under a hairline, not a card: label (12.5px ink 2)
  → serif figure → hint. A row of them is a fact strip. Zero figures go muted.
  `data-stat-tile` is the e2e hook.
- **FactStrip** — the quieter inline variant: "6,208 trades · 135 members",
  serif figures with sans labels between two hairlines. Prefer it where the
  counts are context rather than the news.
- **Disclosure** — "How to read this". `md`: a reader's note with a 2px gold
  rule, the lead in the serif, detail folded in a native `<details>`. `sm`: a
  muted footnote under a chart. The single home for caveats.
- **Badges** (`ui.tsx`) — chip (3px, facts), pill (round, filing state), text
  (figures). Direction chips are buy/sell tints with a glyph and the word.
  `ScanTag` is a dashed neutral outline. `StatusBadge` "sending" is ink.
- **Controls** — `Segmented`: hairline group, active option ink-filled.
  `BUTTON`: hairline on `--field`. `BUTTON_PRIMARY`: ink. `FIELD`: hairline on
  `--field`. One focus ring: 2px `--ring`, offset 2px.
- **Tables** (`ResponsiveTable`, `sortable-table.tsx`) — open, hairline rows,
  sticky header and first column; the outer cells lose their inset from 640px
  (`.table-open`) so the table aligns to the column.
- **Feed** (`feed-list.tsx`) — day headers in the serif ("Sat, Dec 26"),
  sticky under the masthead; one block per filing; bracket ladder + range.
- **Charts** (`charts.tsx`) — pure CSS/SVG, no library. Single-series
  magnitude in `--viz-seq` (gold) with the value printed at the tip;
  direction in buy/sell with a legend and words; transcribed marks hollow,
  dashed or hatched.
- **Brand** (`lib/brand.ts`, `brand.tsx`) — on the site the cat stands on the
  page with no tile (`currentColor` ink, gold tie). Icons and share cards use
  `markSvg`: a paper cat on an ink tile, gold tie. `app/icon.svg` is checked
  against `lib/brand.ts` by `lib/brand.test.ts`.
- **Share cards** (`share-card.tsx`, `opengraph-image.tsx`) — the paper, the
  masthead over an ink rule, a gold-ink kicker, a Newsreader headline,
  hairline-separated counts. Fonts are static TTFs in `assets/fonts` (OFL).
- **Skeletons** (`skeletons.tsx`) — mirror the above: hairline-topped tiles,
  ink-ruled section titles, open lists. Index pages lead with
  `PageHeadSkeleton`.

## Do / don't

- **Do** open a section with `SectionTitle`; **don't** wrap it in a card.
- **Do** put a form in `Card variant="panel"`; **don't** make a panel for a
  chart that already has a title and a rule.
- **Do** set page titles, section heads and hero numbers in the serif;
  **don't** set body copy, tables or controls in it.
- **Do** use gold for the active state, kickers and single-series magnitude;
  **don't** use it for buttons, body text, or anything that means "warning".
- **Don't** use blue or red for anything but buy/sell; **don't** colour a
  party.
- **Do** give every number tabular figures; **don't** print a congressional
  dollar figure without "est." or a range.
- **Do** say a caveat once, in a `Disclosure`; **don't** repeat it under
  every widget.
- **Don't** add icons to navigation, shadows to content, gradients anywhere.

## Interaction and motion

- Focus: 2px `--ring` outline, offset 2px, from the base layer. Never removed.
- Transitions 120–180ms ease-out (`--dur-fast`, `--dur`, `--ease-out`); bars
  grow once on first paint; everything still under `prefers-reduced-motion`.
- `prefers-contrast: more` thickens rules and darkens muted ink
  (`motion.css`); forced colours keep the data marks.
