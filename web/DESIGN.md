# Dashboard design tokens

The values the dashboard's look is built from. They live in `app/globals.css`
(`:root` / `.dark`, mapped to Tailwind utilities in `@theme inline`); this
file records the decisions so later work stays consistent. Data-viz colours
(`--viz-*`) are governed separately: see CLAUDE.md, "Data-viz".

Direction: calm, precise, editorial-financial. Hairlines do the work, shadows
are rare, colour is restrained, and dark mode is designed rather than inverted.

## Surfaces

| Role | Token / utility | Light | Dark |
| --- | --- | --- | --- |
| Page | `--background` / `bg-background` | `#f6f7f9` | `#0b0c0f` |
| Card | `--card` / `bg-card` | `#ffffff` | `#131419` |
| Raised (inner panel, hover fill on a card) | `--raised` / `bg-raised` | `#f9fafb` | `#1a1b21` |
| Popover / tooltip | `--popover` / `bg-popover` | `#ffffff` | `#1f2027` |
| Card, solid (sticky column, scroll fade) | `--card-solid` | `#ffffff` | `#131419` |

Cards are solid: the page tint is what makes them read as surfaces, not a
shadow. Do not reintroduce translucent "glass" cards. `.glass` is kept only as
the class name for the card elevation.

## Ink

| Level | Token / utility | Light | Dark | Use |
| --- | --- | --- | --- | --- |
| 1 | `--foreground` / `text-foreground` | `#0f1117` | `#ededf0` | headings, figures, primary text |
| 2 | `--ink-2` / `text-ink-2` | `#3f4451` | `#b9bcc6` | secondary labels, legend labels, link text in fine print |
| 3 | `--muted-foreground` / `text-muted-foreground` | `#646a78` | `#8d919d` | meta, hints, captions, units |

All three meet WCAG AA (4.5:1) as text on every surface in both modes,
including the 4–5% neutral chip fill. Do not fade muted text further with an
opacity modifier (`text-muted-foreground/80`): that is what breaks AA.

## Lines

| Token / utility | Light | Dark | Use |
| --- | --- | --- | --- |
| `--border` / `border-border` | `rgba(15,17,23,.085)` | `rgba(255,255,255,.08)` | every hairline: card edges, dividers |
| `--border-strong` / `border-border-strong` | `rgba(15,17,23,.14)` | `rgba(255,255,255,.13)` | hover edge, emphasised rule |
| `--input` / `border-input` | `rgba(15,17,23,.12)` | `rgba(255,255,255,.11)` | form controls |

## Accent and status

Indigo is for accent roles only: active nav, links, focus ring, selection.

| Token / utility | Light | Dark |
| --- | --- | --- |
| `--primary` / `text-primary`, `bg-primary` | `#5b5bd6` | `#8b8bf2` |
| `--accent` / `bg-accent` (active-tab fill) | indigo 9% | indigo 14% |
| `--ring` (focus) | `#6e6ee0` | `#8b8bf2` |
| `--selection` | indigo 20% | indigo 32% |
| `--ok` / `text-ok`, `bg-ok-soft` | `#2b7d55` | `#55b685` |
| `--attention` / `text-attention`, `bg-attention-soft` | `#9a6412` | `#d6a24a` |
| `--error` / `text-error`, `bg-error-soft` (`--destructive` aliases it) | `#c13d3d` | `#ec7a76` |

Status colours describe pipeline/system state (fresh, stale, failed). They are
never a buy/sell encoding: direction is `--viz-buy` / `--viz-sell` only, and
is always spelled out in text.

## Radius

| Utility | Value | Use |
| --- | --- | --- |
| `rounded-card`, `rounded-xl` (and `2xl`–`4xl`) | 12px | cards, tiles, panels |
| `rounded-control`, `rounded-lg` | 8px | inputs, buttons, inner panels, tooltips |
| `rounded-chip`, `rounded-md` | 6px | chips, tags |
| `rounded-sm` | 4px | small marks |
| `rounded-full` | — | status pills, avatars |

The stock `rounded-2xl`/`3xl`/`4xl` utilities are capped at 12px on purpose,
so nothing renders larger than a card.

## Elevation

| Utility / token | Light | Dark |
| --- | --- | --- |
| `shadow-card` (`--elev-card`; also `.glass`) | `0 1px 2px` at 4% | `0 1px 2px` black 35% |
| `--elev-card-hover` (`.lift:hover`) | adds a soft 12px drop | adds a 16px drop |
| `shadow-popover` (`--elev-popover`) | 1px ring + 32px drop at 18% | white 9% ring + 40px drop |

Card = hairline + `shadow-card`. Popovers and tooltips = `bg-popover` +
`shadow-popover`. Nothing else casts a shadow.

## Type

Geist Sans / Geist Mono. `tabular-nums` (the `.tabular` class) on every number.

| Size | Use |
| --- | --- |
| 12px (`text-xs`) | meta, tile hints, section-title meta, legend |
| 13px | tables, captions, tile labels, empty states |
| 14px (`text-sm`) | body; section titles (semibold, sentence case) |
| 16px | card titles |
| 20px | section heroes |
| 28px (24px on a phone) | stat values: semibold, `-0.025em` tracking |
| 36px | page titles |

Unit suffixes on a figure (k, M, B, %, d) render at 0.72em in muted ink
(`StatTile` does this automatically). No tracked ALL-CAPS headings.

## Spacing and layout

- 4px grid; gaps 8 / 12 / 16 / 24.
- Content column: `max-w-6xl` (1152px), gutters 16px phone / 24px from `sm`.
- Page sections: 28px apart on a phone, 40px from `sm`, set once by
  `.page-flow` on `<main>` (pages keep their `space-y-8` wrapper).
- Card padding: 16px phone / 20px from `sm` (`Card`: `p-4 sm:p-5`).

## Components (app/charts.tsx)

- `Card` — the one surface: `rounded-xl border bg-card shadow-card p-4 sm:p-5`.
- `StatTile` — label (13px medium, muted) → value (28px) → hint (12px muted).
  A zero value (`0`, `$0`, `0%`, `—`) is de-emphasised: muted figure, no card
  fill, sparkline at 60%.
- `SectionTitle` — 14px semibold foreground, sentence case; `right` is 12px muted.
- `Empty` — one muted 13px line on a 2px left hairline; no box.
- `Legend` — 12×8px bar swatches, labels in ink 2, note muted on the right.

## Interaction

- Focus: every element gets a 2px `--ring` outline, offset 2px, from the base
  layer. Restyle it if needed; never remove it.
- Transitions 120–180ms ease-out (`--dur-fast` 120ms, `--dur` 160ms,
  `--ease-out`). `.lift` firms the hairline and adds the hover shadow, with at
  most a 1px nudge, and no movement under `prefers-reduced-motion`.
- Scrollbars are thin, rounded and neutral (`--scrollbar`), `::selection` is
  the indigo `--selection` tint.
