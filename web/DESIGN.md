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
3. **Monochrome interface.** Graphite in light mode, white in dark: the
   filled button, the selected segment, the active section, link hovers.
   **Apple's blue is not available — blue means "bought".** Buy-blue and
   sell-red are the only saturated colours on a page.
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

Where iOS would be blue, v3 is graphite: links are ink with a hairline
underline that firms on hover; the selected segment is a white raised chip
on a grey track (`#636366` in dark mode); the active nav section is a grey
capsule. Nothing interactive is ever blue or red.

### Status (pipeline and filing state — never buy/sell, never the accent)

| Token | Light | Dark |
| --- | --- | --- |
| `--ok` | `#24744a` | `#5bb585` |
| `--attention` | `#a34f0b` | `#f0954a` |
| `--error` (`--destructive`) | `#8a3478` (plum: red is "sold") | `#eaa8e4` |

Each has a `*-soft` wash for pills. Status always ships with a word; error
pills are also outlined and carry a diamond, not a dot. Error vs buy/sell on
the v3 tiles (dataviz validator, `--pairs all`): light CVD ΔE 14.5 (protan),
normal 17.5; dark CVD 15.3, normal 19.1; all ≥ 3:1.

### Data-viz roles (`--viz-*`)

| Role | Light | Dark | Notes |
| --- | --- | --- | --- |
| `--viz-buy` | `#2a78d6` | `#3987e5` | bought; diverging pair with sell |
| `--viz-sell` | `#d03b3b` | `#e66767` | sold |
| `--viz-seq` | `#3a3a3c` | `#aeaeb2` | single-series magnitude (ranked bars, sparkbars' current period, the range band). Graphite, like the interface. |
| `--viz-track` | fill 12% | fill 24% | empty bar track |
| `--viz-grid` / `--viz-axis` | `#e8e8ed` / `#8e8e93` | `#2c2c2e` / `#8e8e93` | recessive grid and axes |
| `--viz-rung-off/below/on` | `#e8e8ed` / `#aeaeb2` / `#1d1d1f` | `#3a3a3c` / `#636366` / `#f5f5f7` | the bracket ladder (neutral ordinal ramp) |
| `--viz-price` / `--viz-bench` | `#1d1d1f` / `#8e8e93` | `#f5f5f7` / `#aeaeb2` | price overlay: one ink, one grey |

Validated with the `dataviz` skill's `validate_palette.js` against the v3
tiles (`#ffffff` / `#1c1c1e`); re-run it before changing any value:

- buy · sell · seq, `--pairs all` — light: worst CVD ΔE 14.2 (seq/sell,
  protan), normal 27.7, all ≥ 3:1; dark: CVD 10.5 (seq/sell, deutan), normal
  17.9, all ≥ 3:1. The lightness-band and chroma-floor checks fail for seq by
  design: it is a neutral single-series role, never a categorical slot.
- buy/sell alone (unchanged hues): CVD 23.8 / normal 31.6 light, 19.2 / 29.0
  dark — on the tiles and on the canvases (`#f5f5f7`, `#000`); all pass.
- price · bench · buy · sell, `--pairs all` — light CVD 11.6, normal 17.3;
  dark CVD 10.5, normal 17.9; all ≥ 3:1.
- rung below → on, `--ordinal` — both modes pass (monotone L, ΔL ≥ 0.06,
  light end 2.21:1 light / 2.84:1 dark).

**Transcribed (scanned) rows are not a colour.** They are drawn hollow and
dashed (the bracket ladder, the timeline) or hatched, and always say
"transcribed from scan" in words.

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
  Direction chips are buy/sell tints with a glyph and the word; ticker chips
  are grey-filled semibold sans; `ScanTag` is a dashed outline.
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
- **Charts** (`charts.tsx`) — pure CSS/SVG. Fully rounded bar ends, thin
  tracks, no heavy gridlines, legends as small capsules inline above the
  plot, values printed at the tip.
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
- **Do** use graphite/white for anything interactive; **don't** use blue or
  red for anything but buy/sell, and **don't** colour a party.
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
