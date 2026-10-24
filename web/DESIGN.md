# FatCat Watch — design system v3

The spec every page is built to. Values live in `app/globals.css` (`:root` /
`.dark`, mapped to Tailwind utilities in `@theme inline`); the components are
in `app/charts.tsx`, `app/page-header.tsx`, `app/ui.tsx`, `app/disclosure.tsx`.
Data-viz colours (`--viz-*`) are also governed by CLAUDE.md, "Data-viz".

## Direction

**Apple-like: apple.com product pages, iOS Settings / Stocks / Health, the
App Store.** Concretely:

1. **Canvas and tiles.** A `#f5f5f7` canvas with white content tiles (true
   black with iOS system-grey tiles in dark mode). Tone separates a tile from
   the canvas; there are no borders, and the shadow is one you only notice
   when it is missing.
2. **The system font.** `-apple-system` / `BlinkMacSystemFont` first, so
   Apple devices render SF Pro; Inter (self-hosted) everywhere else. Large,
   bold, tight titles; reading-size body; tabular figures for every number.
3. **A monochrome interface, one pair of data hues.** Graphite in light
   mode, white in dark: the filled button, the selected segment, the active
   section, link hovers. The data has exactly two hues: **bought is Apple
   blue, sold is Apple orange** (the user's choice, 2026-10-24 — this
   branch is the alternative to #107's graphite/silver; merge one, close
   the other). Because blue means "bought", nothing interactive is blue.
   Direction always also reads from position and words. Everything else is
   grey, bar small status marks (a dot, a triangle, a diamond) and the app
   icon's gold tie.
4. **Big numbers, small grey labels.** Stocks/Health tiles: a 13px semibold
   grey label, a 30–36px figure, one grey line of context.
5. **Grouped lists.** Lists and tables sit in a tile as iOS inset-grouped
   tables: rows separated by hairlines inset from the left.
6. **State the caveat once, well.** Load-bearing caveats (ranges, estimates,
   shares × reported price, quarantined scans) live in a `Disclosure`.

## Colour

### Surfaces

| Role | Token / utility | Light | Dark |
| --- | --- | --- | --- |
| Canvas | `--background` / `bg-background` | `#f5f5f7` | `#000000` |
| Tile | `--card` / `bg-card`, `.tile` | `#ffffff` | `#1c1c1e` |
| Popover, tooltip | `--popover` | `#ffffff` | `#2c2c2e` |
| Pressed / raised row | `--raised` | `#f2f2f4` | `#2c2c2e` |
| iOS fill (search, segmented track, grey buttons, chips) | `--fill` / `bg-fill`, `--field` | `rgba(118,118,128,.12)` | `rgba(118,118,128,.24)` |
| Opaque overlay that must match a tile (sticky column, scroll fade, a mark's ring) | `--card-solid` | `#ffffff` | `#1c1c1e` |
| Nav bar (frosted) | `--nav-bg` / `--nav-bg-solid` | `rgba(250,250,252,.78)` / `#fafafc` | `rgba(22,22,23,.74)` / `#161617` |

The feed's sticky day headers sit on the canvas, so they take
`--background`, not `--card-solid`.

### Text

| Level | Token / utility | Light | Dark | On tile (light / dark) |
| --- | --- | --- | --- | --- |
| Label | `--foreground` / `text-foreground` | `#1d1d1f` | `#f5f5f7` | 16.8 / 15.6 |
| Secondary | `--ink-2` / `text-ink-2` | `#424245` | `#d1d1d6` | 10.0 / 11.2 |
| Muted | `--muted-foreground` / `text-muted-foreground` | `#6e6e73` | `#98989d` | 5.1 / 5.9 (4.7 on the canvas, 4.5 on a hovered row) |
| Tertiary | `--ink-3` / `text-ink-3` | `#86868b` | `#8e8e93` | 3.6 — large text and marks only |

All sentence-size text uses the first three; they pass WCAG AA on the
canvas, the tile and the hover wash in both modes.

### Lines

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--border` | `rgba(60,60,67,.16)` | `rgba(84,84,88,.6)` | the nav's bottom hairline, table rows, footer rules |
| `--border-strong` | `rgba(60,60,67,.3)` | `rgba(120,120,128,.7)` | inset row separators (drawn at 0.5px on retina), link underlines, the dashed "transcribed" chip |
| `--rule` | = `--border` | | v3 has no ink rules |

### Interaction (the accent constraint)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--primary` / `bg-primary` | `#1d1d1f` | `#f5f5f7` | the one filled button (`BUTTON_PRIMARY`), the Filter pill when filters are on |
| `--ring` | `#1d1d1f` | `#f5f5f7` | focus ring: 2px, offset 2px |
| `--selection` | black 14% | white 24% | text selection |
| `--gold` | `#f5b41b` | `#f7c544` | not used in the interface; the bow tie on the app icon is `BOW_TIE_FILL` (`#fbbf24`) |

Where iOS would be blue, v3 is graphite — on this site systemBlue means
"bought": links are ink with a hairline underline that firms on hover; the
selected segment is a white raised chip on a grey track (`#636366` in dark
mode); the active nav section is a grey capsule. Nothing interactive is ever
coloured, and never blue.

### Status accents (pipeline and filing state — never buy/sell, never the accent)

| Token | Shape | Light | Dark | On tile (light / dark) |
| --- | --- | --- | --- | --- |
| `--ok` | dot | `#248a3d` | `#30d158` | 4.4 / 8.4 |
| `--attention` | **triangle** | `#424245` | `#d1d1d6` | 10.0 / 11.2 |
| `--error` (`--destructive`) | diamond | `#d70015` | `#ff453a` | 5.4 / 5.0 |

iOS Settings style: the state is a **small mark beside ink text**, and each
tone has its own **shape** — a green dot for ok, a grey triangle for
attention, a red diamond for an error — in a grey pill (`StatusBadge`,
`HealthPill`, the status screen's chip) or before a sentence (`StatusNote`,
`AsFiled`). Pills are never tinted and words are never set in these colours
(they are non-text marks: 3:1 is the bar). An error pill also carries a
hairline outline.

Why these, now that sold is orange:

- **Attention is not orange** (it was `#c93400` / `#ff9f0a` under #107): an
  orange dot beside a trade reads as "sold", and a sell mark is a dot.
  Apple yellow was measured and rejected — ΔE 13.3 from the dark sell
  orange under normal vision (floor 15) and 1.5:1 on white — so attention is
  the secondary ink with the triangle carrying it. Grey triangle vs sell:
  CVD ΔE 32.1 light / 18.2 dark; vs buy 30.2 / 27.1.
- **Error is a darker red in light mode.** `#ff3b30` sat ΔE 14.8 from the
  light sell orange (CVD 7.3); Apple's high-contrast `#d70015` is 21.7
  (CVD 17.3) and 5.4:1 on white. Dark `#ff453a` vs `#ff9f0a`: 18.4 (CVD
  12.1). Red is free for errors because it does not mean "sold".
- **Ok stays green.** vs sell: CVD 9.0 light, 7.1 dark (deutan, the WARN
  band) — legal only because a status mark always sits beside its word and
  never beside a trade; ok vs attention 19.6 / 15.0.

Late counts are an ink figure (an outlined chip in tables, "49d late" in
rows) with no colour: a reporting fact, not an alarm.

### Data-viz roles (`--viz-*`)

| Role | Light | Dark | Notes |
| --- | --- | --- | --- |
| `--viz-buy` | `#007aff` | `#0a84ff` | bought: Apple systemBlue (4.0:1 / 4.7:1 on the tile) |
| `--viz-sell` | `#f08a00` | `#ff9f0a` | sold: Apple orange (2.5:1 light — always labelled; 8.3:1 dark) |
| `--viz-buy-text` | `#0058c4` | `#5aa9ff` | "Buy" chip and table text: 5.4:1 on its tint over the tile (5.0:1 over the canvas) / 5.4:1 |
| `--viz-sell-text` | `#9a4a00` | `#ffb340` | "Sell" chip and table text: 5.4:1 (5.0:1) / 6.7:1 |
| `--viz-seq` | `#7c7c80` | `#909095` | a neutral quantity: ranked volume and count bars, sparkbars' current period, the range band, the bracket ladder's own rung, "exchange / other" marks, scan counts. The mid grey, **never a hue**. |
| `--viz-price` | `#48484a` | `#c1c1c6` | the strong neutral line: the price close, the delay median. Dark grey. |
| `--viz-bench` | = seq, dashed | = seq, dashed | the SPY benchmark, the delay p90 (solid) |
| `--viz-track` | fill 12% | fill 24% | empty bar track |
| `--viz-grid` / `--viz-axis` | `#e8e8ed` / `#8e8e93` | `#2c2c2e` / `#8e8e93` | recessive grid and axes |
| `--viz-rung-off/below/on` | `#e8e8ed` / `#aeaeb2` / seq | `#3a3a3c` / `#636366` / seq | the bracket ladder (neutral ordinal ramp) |

**Direction is double-encoded, always.** Blue vs orange is one channel; the
second is always there:

| Where | Position | Words / arrows |
| --- | --- | --- |
| `DivergingSplit` | bought left of the axis, sold right | legend "Bought" / "Sold", "← Bought" / "Sold →" captions, counts at every tip |
| `MonthlyColumns` (/trends) | bought up, sold down | legend, cap labels, tooltip, table |
| Timeline, price lanes | buys above the axis, sells below | "Buys →" / "← Sells", "bought" / "sold" lane labels, legend counts, tooltips |
| `SplitCell`, member/ticker glance bar | buys first (left) | "12 / 30" with the header naming the order; "44 bought … sold 34" |
| `ActionBadge` | — | "↗ Buy" / "↘ Sell": tinted pills (blue 15% / orange 16%, 20% / 18% dark), text in `--viz-*-text` |
| Insider value cells, "Most bought / sold" | their own column or list | the column header / section title |
| Share cards | — | a small dot beside "buys" / "sells" |

Collisions with the neutral roles, and how they are kept apart:

- **Quantity vs a direction.** A single-series bar is the mid grey — CVD ΔE
  ≥ 16.5 from blue and orange (21.3 normal) light, ≥ 17.3 dark — has no
  chroma, and never carries a Bought/Sold legend. It cannot be read as one.
- **Price line vs buys.** The close is `--viz-price`, a dark grey line in its
  own panel; buys are blue dots in the lanes under it, with "bought" printed
  beside them. SPY is the mid grey, dashed, named in the legend.
- **Exchange / other.** The mid grey, on the axis (neither above nor below),
  named in the legend.
- **Cluster spans.** A buying cluster is a flat blue wash (8% / 14%) with a
  solid blue bar over its lane; a selling cluster is an orange diagonal
  hatch with a dashed orange bar — hue and texture both. Legend, span list
  and readout say "buying" / "selling".
- **Party inside a direction.** Hatching (solid Democrat, 45° Republican,
  135° other), tone-on-tone inside the blue or orange column.
- **Transcribed (scanned) rows are not a colour.** They are drawn hollow and
  dashed (the bracket ladder, the timeline) or hatched (/trends), and always
  say "transcribed from scan" in words.

Validated with the `dataviz` skill's `validate_palette.js` against the v3
tiles (`#ffffff` / `#1c1c1e`); re-run it before changing any value:

- buy · sell — light CVD ΔE 33.2 (protan), normal 40.2, on the tile and on
  `#f5f5f7`; dark CVD 33.5, normal 40.8, on the tile and on `#000`.
- buy · sell · seq · price, `--pairs all` — worst CVD 16.5 light (seq/sell),
  15.7 dark (price/seq); worst normal 18.5 / 15.7 (both neutral pairs).
  `bench` is seq's own tone (ΔE 0 to it by construction), set apart by its
  dash.
- Expected and accepted: the **dark orange FAILs the lightness band** (L
  0.78 against 0.48–0.67) — it is Apple's own dark systemOrange, 8.3:1 on the
  tile, and a darker one turns brown; the **light orange WARNs on contrast**
  (2.52:1 on the tile, 2.31:1 on the canvas) — every orange mark has its
  value or word printed beside it. seq and price FAIL the band and chroma
  checks by design: neutral roles, never categorical slots. (`#e07b00`
  would reach 3.0:1 on white if the WARN ever has to go.)
- rung below → on (`#aeaeb2` → `#7c7c80`, `#636366` → `#909095`),
  `--ordinal` — both modes pass (monotone L, ΔL 0.164 / 0.154, light end
  2.21:1 light / 2.84:1 dark).
- Green/red stays out: Apple's `#34c759` / `#ff3b30` measure CVD ΔE 6.8
  (deutan) on white.

## Type

- **Sans** (`font-sans`, the body default): `-apple-system,
  BlinkMacSystemFont, "SF Pro Text", Inter, …`.
- **Display** (`font-display`, `.display`, `.figure`): the same with
  `"SF Pro Display"`; titles, section heads, hero figures.
- **Mono** (`font-mono`): Geist Mono, filing ids and code only. Tickers are
  set in the sans, semibold, like Apple Stocks.

SF Pro is never self-hosted (its licence forbids web embedding). Inter is
self-hosted by `next/font` and **not preloaded**: a Mac or an iPhone never
uses it. Body text carries `-0.006em` tracking, which brings Inter close to
SF Text and is invisible on SF. Share cards use static Inter TTFs
(`assets/fonts`, OFL); "Inter Display" there is Inter SemiBold.

### Scale

| Role | Class / component | Size (phone → ≥640px) | Weight, tracking |
| --- | --- | --- | --- |
| Large title (h1) | `PageHeader` / `.display` | 34 → 48px, leading 1.1 → 1.06 | 700, −0.025em |
| Member name (h1) | `MemberHero` | 32 → 44px | 700, −0.025em |
| Subtitle | `PageHeader subtitle` / `.dek` | 17 → 19px, leading 1.42 | 400, −0.012em, muted |
| Eyebrow | `.kicker` | 13px | 600, muted |
| Section head (h2) | `SectionTitle` | 22 → 24px | 700, −0.022em |
| Day header (h3) | `FeedList` | 17px | 600, −0.018em |
| Hero figure | `StatTile` / `.figure` | 30 → 36px | 600, −0.022em, tabular |
| Tile label | `StatTile` | 13px | 600, muted |
| Body, list rows | — | 14px | 400–600 |
| Meta, captions, footnotes | — | 12–13px | muted |
| Chips, pills | `ui.tsx` | 12px, 22px tall | 500–600 |
| Nav sections | `Tabs` | 13px | 500 |

Unit suffixes on a figure (k, M, B, %, d) render at 0.62em in muted ink.
Sentence case everywhere; no tracked capitals.

## Layout and shape

- Content column 1080px (`max-w-[1080px]`); gutters 16px phone / 24px from
  `sm`. Sections 32px apart on a phone, 48px from `sm` (`.page-flow`).
- 4px grid; tile gaps 12px phone / 16px from `sm`; tile padding 16 / 24px.
- Radii: tiles 20px (`rounded-tile`), popovers 20px, controls and fields
  12px (`rounded-control`), segmented track 9px / segment 7px, chips 6px;
  buttons, pills, avatars and the active-section capsule fully round.
- Elevation: `--elev-card` (light only: 1px + 16px very soft), the popover
  shadow, the segmented chip's iOS shadow. None in dark mode — tone does it.

## Components

- **Nav bar** (`layout.tsx`, `nav.tsx`, `.site-header`) — 52px, frosted
  (`backdrop-filter: saturate(180%) blur(20px)` over `--nav-bg`), a hairline
  beneath, opaque under `prefers-reduced-transparency` and
  `prefers-contrast: more`. Glyph + wordmark, five sections in 13px medium
  (active: grey capsule + `aria-current`), an iOS search field, theme
  toggle. On a phone the brand row scrolls away and the sections row stays.
- **Footer** — apple.com's: 12px grey, semibold column heads, hairlines.
  Keep all three "Reading the numbers" caveats.
- **PageHeader** — back link (`‹ Members`), eyebrow, large title, badges,
  subtitle, aside, then the facts (usually StatTiles).
- **MemberHero** — an iOS contact card: round 96/120px portrait, the name,
  "House · CA-11 · Democrat", one plain-language line, the actions as
  capsules (share, Congress bio, scanned filings). `MemberGlance` is the
  buy/sell split and most-traded tickers in a tile.
- **SectionTitle** — bold heading on the canvas above its tile; muted meta
  or a control on the right. No rule.
- **Card** — `tile` (default), `panel` (same), `open` (no surface).
- **StatTile** — a tile: label → figure (+ sparkbars) → hint. Keep the DOM
  order; `data-stat-tile` is the e2e hook.
- **FactStrip** — inline figures for counts that are context, not news.
- **Disclosure** — "How to read this": the lead at reading size in
  secondary ink, the detail in a native `<details>`.
- **Badges** (`ui.tsx`) — chip (6px, facts), pill (round, filing state).
  Direction chips are "↗ Buy" / "↘ Sell" as blue / orange tinted pills
  with darker text of the same hue — the glyph and word carry it; ticker
  chips are grey-filled
  semibold sans; `ScanTag` is a dashed outline; state pills are grey with a
  small status mark.
- **Controls** — `Segmented` (iOS segmented control), `BUTTON` (grey
  capsule), `BUTTON_PRIMARY` (graphite capsule), `FIELD` (grey filled 12px
  rect, no border). One focus ring.
- **Feed** (`feed-list.tsx`, `feed-controls.tsx`) — toolbar on the canvas:
  segmented All/Buys/Sells, the **Filter** pill (a native `<details>`
  wrapping the GET form, shown as a popover; works without JavaScript),
  Reset, the bracket legend, CSV; the count line under it. Each day is a
  sticky bold header on the canvas over one grouped tile of filings
  (`.inset-rows`, separators inset to the member's name).
- **Tables** (`ResponsiveTable`) — in a tile, cells inset 16px, clipped with
  `overflow: clip` so the sticky header still works.
- **Charts** (`charts.tsx`) — pure CSS/SVG. Capsule bars (both ends
  round), thin tracks, no heavy gridlines, legends as small capsules with
  the words "Bought" / "Sold" inline above the plot, values printed at the
  tip.
- **Brand** (`lib/brand.ts`, `brand.tsx`) — on the site a **monochrome
  glyph** in the page ink, tie included (a masked hairline keeps chin and
  tie apart), like the apple in Apple's nav. The **app icon** (`icon.svg`,
  `apple-icon`, share cards) is a white cat on a graphite squircle with a
  soft top-lit gradient, gold tie: the one place colour belongs to the
  brand. The favicon is the squircle (superellipse n = 5); the apple-touch
  icon is full bleed for iOS to mask. `lib/brand.test.ts` checks
  `icon.svg` is byte-for-byte `markSvg()`.
- **Share cards** — the canvas, the app icon and wordmark, an Inter
  SemiBold headline at −0.03em, counts in a white 28px-radius tile.

## Do / don't

- **Do** put content in a tile; **don't** add borders round tiles.
- **Do** use graphite/white for anything interactive; **don't** make a
  button, link or selected state blue (blue is "bought"), **don't** add
  colour beyond blue/orange data and the small status marks, and **don't**
  colour a party.
- **Do** give every buy/sell mark a position and/or words; **don't** draw a
  neutral quantity in blue or orange, an orange mark without its label, or
  a status mark in orange.
- **Do** give every number tabular figures; **don't** print a congressional
  dollar figure without "est." or a range.
- **Do** say a caveat once, in a `Disclosure`.
- **Don't** add icons to navigation or gradients to the interface (the app
  icon's tile is the one gradient).

## Interaction and motion

- Focus: 2px `--ring`, offset 2px, from the base layer. Never removed.
- Transitions 150–200ms with `cubic-bezier(.25,.1,.25,1)` (`--dur-fast`,
  `--dur`, `--ease-out`); bars grow once on first paint (480ms); everything
  still under `prefers-reduced-motion`.
- `prefers-contrast: more` darkens separators and muted text and makes the
  nav opaque; forced colours keep the data marks.
