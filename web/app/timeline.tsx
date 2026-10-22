/**
 * "When did they trade" — every disclosed trade of one ticker or one member
 * on a horizontal axis by trade date. Server-rendered SVG, no chart library.
 *
 * Encoding:
 * - x: trade date as filed. Buys stack above the axis, sells below, exchanges
 *   and other actions sit on it. Direction is spelled out in the legend and
 *   every tooltip, so the blue↔red pair never carries it alone.
 * - Mark size: the bracket FLOOR (log scale) — the least the disclosed range
 *   allows. Never a midpoint, never "the amount".
 * - Diamond: an option trade. Hollow dashed: transcribed from a scanned
 *   filing — plotted because it is a trade, but it enters no total anywhere.
 * - Outer hairline ring: a trade date after the filing's own date, shown where
 *   filed. Dates far before the rest of the record or after today are set off
 *   in a labelled gutter rather than stretching the scale; see lib/timeline.ts.
 *
 * Geometry comes from `layoutTimeline`; the server lays out a desktop and a
 * phone width (CSS picks one) so text stays 1:1 and nothing reflows on the
 * client. `TimelineFrame` adds the tooltip, keyboard walk and phone scroll.
 */

import { ACTION_LABEL, OWNER_LABEL, memberHref, memberLabel, range, shortDate, tickerHref } from "@/lib/format";
import { LABEL_COL, floorRadius, layoutTimeline, type PlacedMark, type TimelineLayout } from "@/lib/timeline";
import { getTimelineTrades, type TimelineTrade } from "@/lib/timeline-queries";
import { cn } from "@/lib/utils";
import { Card, Empty, SectionTitle } from "./charts";
import { TimelineFrame } from "./timeline-frame";
import { publicErrorMessage } from "@/lib/public-error";

type Mode = "ticker" | "member";

const COLOR = { buy: "var(--viz-buy)", sell: "var(--viz-sell)", other: "var(--viz-axis)" } as const;
const TOP = 18;
const AXIS_BAND = 36;
// Axis text at the 12px meta size, its year line a step below. Inline: the
// `.tl-*` rules in globals.css set the colour and figures, these the size.
const TICK = { fontSize: 12 } as const;
const TICK_SUB = { fontSize: 11 } as const;
// Sentence case, not tracked caps.
const SIDE = { fontSize: 11, letterSpacing: 0, textTransform: "none" } as const;

/**
 * Two server layouts, one shown per breakpoint. A phone gets its own
 * compressed axis that fits the screen — the whole record at a glance, no
 * sideways hunting for a burst that happened off-screen. From `sm` up the
 * wide layout is drawn; a tablet narrower than its floor scrolls a little.
 */
const LAYOUTS = [
  {
    key: "wide",
    width: 1040,
    maxExtent: 140,
    className: "hidden sm:block w-full min-w-[820px]",
    notesClassName: "hidden sm:block",
  },
  { key: "phone", width: 352, maxExtent: 110, className: "sm:hidden w-full", notesClassName: "sm:hidden" },
] as const;

export function TradeTimeline({
  trades,
  mode,
  today = new Date().toISOString().slice(0, 10),
}: {
  trades: TimelineTrade[];
  mode: Mode;
  /** ISO date; injectable so a render is reproducible. */
  today?: string;
}) {
  if (!trades.length) return <Empty>No dated trades to plot.</Empty>;
  const layouts = LAYOUTS.map((l) => ({
    ...l,
    layout: layoutTimeline(trades, { width: l.width, today, maxExtent: l.maxExtent }),
  }));
  const wide = layouts[0].layout;
  const hasOption = trades.some(isOption);
  const hasScan = trades.some((t) => t.transcribed);
  const hasOther = wide.counts.other > 0;

  return (
    <Card>
      <TimelineLegend
        layout={wide}
        hasOption={hasOption}
        hasScan={hasScan}
        hasOther={hasOther}
      />
      <TimelineFrame>
        {layouts.map((l) => (
          <TimelineSvg key={l.key} layout={l.layout} mode={mode} className={l.className} />
        ))}
      </TimelineFrame>
      {layouts.map((l) => (
        <TimelineNotes key={l.key} layout={l.layout} mode={mode} className={l.notesClassName} />
      ))}
    </Card>
  );
}

/**
 * The member page's "Trades over time" section. It fetches its own rows so
 * the page only mounts it; the trade list below stays paged, the timeline
 * plots the whole record.
 */
export async function MemberTimeline({ member }: { member: string }) {
  let trades: TimelineTrade[];
  try {
    trades = await getTimelineTrades({ member });
  } catch (err) {
    return <Empty>{publicErrorMessage(err)}</Empty>;
  }
  if (!trades.length) return null;
  return (
    <section>
      <SectionTitle right={<span className="text-[11px] text-muted-foreground">by trade date</span>}>
        Trades over time
      </SectionTitle>
      <TradeTimeline trades={trades} mode="member" />
    </section>
  );
}

function isOption(t: TimelineTrade): boolean {
  return t.option_kind != null || t.asset_type === "OP";
}

/* ------------------------------------------------------------------ legend */

const SIZE_KEYS = [
  { cents: 1_001_00, label: "$1k" },
  { cents: 15_001_00, label: "$15k" },
  { cents: 250_001_00, label: "$250k" },
  { cents: 1_000_001_00, label: "$1M" },
];

function TimelineLegend({
  layout,
  hasOption,
  hasScan,
  hasOther,
}: {
  layout: TimelineLayout<TimelineTrade>;
  hasOption: boolean;
  hasScan: boolean;
  hasOther: boolean;
}) {
  const { counts } = layout;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[12px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Dot color={COLOR.buy} />
        <span>
          <span className="font-medium text-foreground">Bought</span> · above the axis · {counts.buy}
        </span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Dot color={COLOR.sell} />
        <span>
          <span className="font-medium text-foreground">Sold</span> · below · {counts.sell}
        </span>
      </span>
      {hasOther ? (
        <span className="inline-flex items-center gap-1.5">
          <Dot color={COLOR.other} />
          <span>Exchange / other · on the axis · {counts.other}</span>
        </span>
      ) : null}
      {hasOption ? (
        <span className="inline-flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden className="shrink-0">
            <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="var(--muted-foreground)" />
          </svg>
          option
        </span>
      ) : null}
      {hasScan ? (
        <span className="inline-flex items-center gap-1.5" title="Read from a scanned paper filing. Plotted as a trade; excluded from every total.">
          <svg width="12" height="12" aria-hidden className="shrink-0">
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--muted-foreground)" strokeWidth="1.5" strokeDasharray="2.2 1.6" />
          </svg>
          transcribed from scan · not in totals
        </span>
      ) : null}
      {counts.afterFiling ? (
        <span className="inline-flex items-center gap-1.5" title="The trade date printed is later than the filing's own date. Shown as filed, not corrected.">
          <svg width="14" height="14" aria-hidden className="shrink-0">
            <circle cx="7" cy="7" r="6" fill="none" stroke="var(--foreground)" strokeOpacity="0.55" strokeWidth="1" />
            <circle cx="7" cy="7" r="3.2" fill="var(--muted-foreground)" />
          </svg>
          trade date after filing date · as filed
        </span>
      ) : null}
      <span className="inline-flex items-center gap-2 sm:ml-auto" title="Mark area grows with the bracket floor on a log scale: the floor is the least each disclosed range allows, not the amount traded.">
        <span>size = bracket floor</span>
        <span className="inline-flex items-end gap-1.5">
          {SIZE_KEYS.map((s) => {
            const r = floorRadius(s.cents);
            return (
              <span key={s.label} className="inline-flex items-center gap-0.5">
                <svg width={r * 2} height={r * 2} aria-hidden className="shrink-0">
                  <circle cx={r} cy={r} r={r} fill="var(--muted-foreground)" fillOpacity="0.55" />
                </svg>
                <span className="tabular">{s.label}</span>
              </span>
            );
          })}
        </span>
      </span>
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />;
}

/* --------------------------------------------------------------------- svg */

function TimelineSvg({
  layout,
  mode,
  className,
}: {
  layout: TimelineLayout<TimelineTrade>;
  mode: Mode;
  className: string;
}) {
  const { width, above, below, ticks, plotLeft, plotRight, early, late } = layout;
  const axisY = TOP + above;
  const plotBottom = axisY + below;
  const height = plotBottom + AXIS_BAND;
  const latest = layout.marks.length - 1;
  const label = `Trades over time: ${layout.counts.buy} buys above the axis, ${layout.counts.sell} sells below, by trade date. Use the arrow keys to move between trades.`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("tl-svg h-auto select-none", className)}
      role="group"
      aria-label={label}
    >
      {/* Off-scale gutters: a recessive band, its years, and why it is apart. */}
      {[early && { g: early, why: "off-scale", side: "early" as const }, late && { g: late, why: "future-dated", side: "late" as const }]
        .filter(Boolean)
        .map((o) => {
          const { g, why, side } = o!;
          const breakX = side === "early" ? plotLeft - 7 : plotRight + 7;
          return (
            <g key={side}>
              <rect x={g.x - 20} y={TOP - 6} width={40} height={plotBottom - TOP + 12} rx={8} fill="var(--viz-track)" />
              <text x={g.x} y={plotBottom + 16} textAnchor="middle" className="tl-tick" style={TICK}>
                {g.label}
              </text>
              <text x={g.x} y={plotBottom + 29} textAnchor="middle" className="tl-tick tl-tick-sub" style={TICK_SUB}>
                {why}
              </text>
              {/* Scale break on the axis. */}
              <path
                d={`M${breakX - 4} ${axisY + 5} L${breakX} ${axisY - 5} M${breakX} ${axisY + 5} L${breakX + 4} ${axisY - 5}`}
                stroke="var(--viz-axis)"
                strokeWidth="1"
                fill="none"
              />
            </g>
          );
        })}

      {/* Month gridlines and labels — hairline, recessive. */}
      {ticks.map((t) => {
        // A label that would run off the edge (or into the gutter) keeps its gridline only.
        const fits = t.x + 26 <= (late ? plotRight + 4 : width);
        return (
          <g key={t.x}>
            <line x1={t.x} x2={t.x} y1={TOP - 4} y2={plotBottom + 3} stroke="var(--viz-grid)" strokeWidth="1" />
            {fits ? (
              <text x={t.x + 3} y={plotBottom + 16} className="tl-tick" style={TICK}>
                {t.label}
              </text>
            ) : null}
            {fits && t.year ? (
              <text x={t.x + 3} y={plotBottom + 29} className="tl-tick tl-tick-sub" style={TICK_SUB}>
                {t.year}
              </text>
            ) : null}
          </g>
        );
      })}

      {layout.todayX != null ? (
        <g>
          <line x1={layout.todayX} x2={layout.todayX} y1={TOP - 4} y2={plotBottom + 3} stroke="var(--viz-axis)" strokeWidth="1" />
          <text x={layout.todayX - 3} y={TOP - 7} textAnchor="end" className="tl-tick" style={TICK}>
            today
          </text>
        </g>
      ) : null}

      {/* The axis: buys above, sells below. */}
      <line x1={plotLeft} x2={plotRight} y1={axisY} y2={axisY} stroke="var(--viz-axis)" strokeWidth="1" />
      {early ? <line x1={early.x - 14} x2={early.x + 14} y1={axisY} y2={axisY} stroke="var(--viz-axis)" strokeWidth="1" /> : null}
      {late ? <line x1={late.x - 14} x2={late.x + 14} y1={axisY} y2={axisY} stroke="var(--viz-axis)" strokeWidth="1" /> : null}
      {/* Side labels in their own column, rotated, so no mark or "+N" ever covers them. */}
      <text
        transform={`translate(${LABEL_COL / 2 + 3} ${axisY - 6}) rotate(-90)`}
        className="tl-side"
        style={SIDE}
      >
        Buys →
      </text>
      <text
        transform={`translate(${LABEL_COL / 2 + 3} ${axisY + 6}) rotate(-90)`}
        textAnchor="end"
        className="tl-side"
        style={SIDE}
      >
        ← Sells
      </text>

      {layout.marks.map((m, i) => (
        <Mark key={m.trade.id} m={m} axisY={axisY} mode={mode} focusable={i === latest} />
      ))}

      {layout.overflow.map((o) => (
        <text
          key={`${o.side}${o.x}`}
          x={Math.min(Math.max(o.x, LABEL_COL + 12), width - 12)}
          y={o.side === "buy" ? TOP + 4 : plotBottom - 2}
          textAnchor="middle"
          className="tl-more"
          style={{ fontSize: 11 }}
        >
          +{o.count}
        </text>
      ))}
    </svg>
  );
}

function Mark({
  m,
  axisY,
  mode,
  focusable,
}: {
  m: PlacedMark<TimelineTrade>;
  axisY: number;
  mode: Mode;
  focusable: boolean;
}) {
  const t = m.trade;
  const cy = m.side === "buy" ? axisY - m.y : m.side === "sell" ? axisY + m.y : axisY;
  const option = isOption(t);
  const scan = Boolean(t.transcribed);
  const amount = range(t.amount_min_cents, t.amount_max_cents, t.amount_exact_cents);
  const value = amount === "—" ? "amount not disclosed" : amount;
  const direction = ACTION_LABEL[t.action] ?? t.action;
  const owner = t.owner ? OWNER_LABEL[t.owner] ?? t.owner : null;

  const head =
    mode === "ticker"
      ? memberLabel(t.member_name, t.party, t.state, t.district, t.chamber)
      : t.ticker
        ? `${t.ticker} · ${t.asset_name}`
        : t.asset_name;
  const meta = [
    direction,
    `traded ${shortDate(t.tx_date)}`,
    t.filing_date ? `filed ${shortDate(t.filing_date)}${t.delay_days != null ? ` (${t.delay_days}d)` : ""}` : null,
    owner,
  ]
    .filter(Boolean)
    .join(" · ");
  const notes = [
    option ? (t.option_kind ? `${t.option_kind} option` : "option") : null,
    scan ? "transcribed from a scanned filing — not in any total" : null,
    m.afterFiling ? "trade date is after the filing date — shown as filed" : null,
    m.zone === "early" ? "far earlier than the rest of the record — set apart, date as filed" : null,
    m.zone === "late" ? "dated after today — set apart, date as filed" : null,
  ]
    .filter(Boolean)
    .join("; ");

  const href = mode === "ticker" ? memberHref(t.member_name, t.bioguide_id) : t.ticker ? tickerHref(t.ticker) : t.pdf_url;
  const external = mode === "member" && !t.ticker;
  const r = m.r;
  const x = round(m.x);
  const y = round(cy);
  const d = round(r * 1.2);
  // Absolute coordinates, colour from CSS classes (globals.css, "Trade
  // timeline"): a busy member plots ~1,000 marks, so each one stays lean.
  const shape = (cls: string, anchor = false) =>
    option ? (
      <path className={cls} data-shape={anchor || undefined} d={`M${x} ${round(y - d)}l${d} ${d}l${-d} ${d}l${-d} ${-d}z`} />
    ) : (
      <circle className={cls} data-shape={anchor || undefined} cx={x} cy={y} r={round(r)} />
    );

  return (
    <a
      href={href}
      className="tl-mark"
      tabIndex={focusable ? 0 : -1}
      aria-label={`${value}, ${head}, ${meta}${notes ? `; ${notes}` : ""}`}
      data-tip-value={value}
      data-tip-head={head}
      data-tip-meta={meta}
      data-tip-note={notes || undefined}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {/* Hit area: bigger than the mark, invisible. */}
      <circle className="tl-hit" cx={x} cy={y} r={round(Math.max(r + 3, 9))} />
      {/* The dot's own stroke, painted under its fill, is the 2px surface ring. */}
      {scan ? (
        <>
          {shape("tl-dot tl-blank", true)}
          {shape(`tl-hollow tl-${m.side}`)}
        </>
      ) : (
        shape(`tl-dot tl-${m.side}`, true)
      )}
      {m.afterFiling ? <circle className="tl-flag" cx={x} cy={y} r={round(r + 3.5)} /> : null}
    </a>
  );
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------------- notes */

function TimelineNotes({
  layout,
  mode,
  className,
}: {
  layout: TimelineLayout<TimelineTrade>;
  mode: Mode;
  className: string;
}) {
  const overflowed = layout.overflow.reduce((n, o) => n + o.count, 0);
  const parts: string[] = [
    "Each mark is one trade, placed on the trade date the filing printed; marks stack where trades collide.",
    "Size is the bracket floor — the least the disclosed range allows — not the amount traded.",
  ];
  if (layout.early) {
    parts.push(
      `${layout.early.count} trade${layout.early.count === 1 ? " is" : "s are"} dated ${layout.early.label}, far before the rest; ${layout.early.count === 1 ? "it sits" : "they sit"} in the left gutter, off the scale, with the date as filed.`
    );
  }
  if (layout.late) {
    parts.push(
      `${layout.late.count} trade${layout.late.count === 1 ? " is" : "s are"} dated after today (${shortDate(layout.late.from)}${layout.late.to !== layout.late.from ? `–${shortDate(layout.late.to)}` : ""}) — a typo on the filing, reproduced as filed in the right gutter.`
    );
  }
  if (overflowed) {
    parts.push(
      `${overflowed} trade${overflowed === 1 ? "" : "s"} past the stack height ${overflowed === 1 ? "is" : "are"} counted as “+N” at the end of ${overflowed === 1 ? "its" : "their"} column rather than drawn.`
    );
  }
  if (layout.counts.undated) {
    parts.push(`${layout.counts.undated} trade${layout.counts.undated === 1 ? " has" : "s have"} no readable trade date and ${layout.counts.undated === 1 ? "is" : "are"} not plotted.`);
  }
  parts.push(mode === "ticker" ? "Select a mark to open the member." : "Select a mark to open the ticker.");
  return (
    <p className={cn("mt-3 max-w-[76ch] px-1 text-[12px] leading-relaxed text-muted-foreground", className)}>
      {parts.join(" ")}
    </p>
  );
}
