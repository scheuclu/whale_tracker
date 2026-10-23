/**
 * Pure CSS/SVG charts — no chart library, matching the sibling
 * youtube_finance_bro dashboard.
 *
 * Mark specs: bars ≤24px thick with a 4px rounded data-end squared at the
 * baseline, hairline recessive axes, 2px surface gaps between touching fills,
 * and selective direct labels (the value at the bar tip, never on every mark).
 *
 * Colour roles come from `--viz-*` in globals.css. Buy/sell is ink and
 * silver (no hue), so direction is always double-encoded: by position
 * (bought left / above, sold right / below) and by words or arrows. A
 * single-series quantity is the mid grey `--viz-seq`, never the buy ink.
 */

import { useId } from "react";
import { cn } from "@/lib/utils";
import { usd } from "@/lib/format";

/* ---------------------------------------------------------------- stat tile */

/** A change against a named earlier period. `text` must name the period
 *  ("+8% vs prior 12 wk"); colour stays neutral — more trades is neither
 *  good nor bad. */
export type StatDelta = {
  text: string;
  direction: "up" | "down" | "flat";
  /** Hover detail: the two figures being compared. */
  title?: string;
};

export function StatTile({
  label,
  value,
  hint,
  trend,
  trendLabel,
  trendCaption,
  trendLabels,
  delta,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Per-period counts, oldest → newest; the last entry is the period `value` reports. */
  trend?: number[];
  /** Accessible description of the trend, e.g. "cluster alerts per week, last 8 weeks". */
  trendLabel?: string;
  /** Visible caption over the sparkline stating the period, e.g. "per week · 12 wk". */
  trendCaption?: string;
  /** Per-period names for the hover detail, aligned with `trend`. */
  trendLabels?: string[];
  delta?: StatDelta;
}) {
  const zero = isZeroFigure(value);
  // A tile, the way Apple Health and Stocks set a number: a small grey
  // label, a big confident figure, one grey line of context. A zero figure
  // is set in muted ink, so the tiles that report something lead.
  return (
    <div data-stat-tile className="viz-rise flex h-full min-w-0 flex-col rounded-tile bg-card p-4 shadow-card max-[359px]:px-3.5 sm:px-5 sm:pb-5 sm:pt-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="truncate text-[13px] font-semibold leading-5 text-muted-foreground">{label}</div>
        {trend?.length && trendCaption ? (
          <div className="shrink-0 truncate text-[12px] leading-5 text-muted-foreground">{trendCaption}</div>
        ) : null}
      </div>
      <div className={cn("mt-2.5 flex flex-wrap items-end justify-between gap-x-3 gap-y-2.5", zero && "[&>svg]:opacity-60")}>
        <div
          className={cn(
            "figure text-[30px] leading-none sm:text-[36px]",
            zero ? "text-muted-foreground" : "text-foreground"
          )}
        >
          <Figure value={value} />
        </div>
        {trend?.length ? (
          <Sparkbars values={trend} label={trendLabel ?? label} names={trendLabels} />
        ) : null}
      </div>
      {hint ? (
        <div className="mt-auto pt-2.5 text-[13px] leading-snug text-muted-foreground max-[359px]:text-[12px]">
          <Hint text={hint} />
        </div>
      ) : null}
      {delta ? (
        <div className="tabular mt-1 text-[13px] leading-snug text-ink-2 max-[359px]:text-[12px]" title={delta.title}>
          <span aria-hidden className="mr-1 text-[9px] text-muted-foreground">
            {delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "■"}
          </span>
          <Hint text={delta.text} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A tile's grey context line, broken only where it reads well. On a phone a
 * tile is ~140px wide and the line wraps; left alone it broke inside a
 * phrase ("438 in last / 12 wk") or a range ("$3.9M– / $8.9M"). Each
 * " · "-separated phrase is kept whole when it is short enough to fit a
 * phone tile (21 characters: "1,787 in last 12 wk" fits a 390px phone's
 * tile at 13px and a 320px one's at 12px), and a range never breaks at its
 * dash.
 */
function Hint({ text }: { text: string }) {
  const parts = text.split(" · ");
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i ? " · " : null}
          <span className={p.length <= 21 ? "whitespace-nowrap" : undefined}>{keepTogether(p)}</span>
        </span>
      ))}
    </>
  );
}

/**
 * Where a longer phrase may not break: never at a range's dash, and never
 * before its last word, so no word sits alone on a line (the last two words
 * are one unbreakable span; the text itself keeps plain spaces).
 */
function keepTogether(p: string): React.ReactNode {
  const t = p.replace(/(\d[kMB%]?)–(\$?\d)/g, "$1\u2060–\u2060$2");
  const words = t.split(" ");
  if (words.length < 3) return t;
  return (
    <>
      {words.slice(0, -2).join(" ")} <span className="whitespace-nowrap">{words.slice(-2).join(" ")}</span>
    </>
  );
}

/** "0", "$0", "0%", "—": a tile reporting nothing is drawn quieter. */
function isZeroFigure(value: string): boolean {
  return /^(?:\$?0(?:\.0+)?[kMB%]?|[—–-])$/.test(value.trim());
}

/**
 * A formatted figure with its unit suffixes (k, M, B, %, d) in muted ink and
 * a step smaller, so the digits carry the weight. Only a suffix directly
 * after a digit is split off; everything else renders as given.
 */
function Figure({ value }: { value: string }) {
  const parts = value.split(/(?<=\d)([kKMBT%]|d(?![a-z]))/);
  if (parts.length === 1) return <>{value}</>;
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <span key={i} className="ml-[0.05em] text-[0.62em] font-medium tracking-normal text-muted-foreground">
            {p}
          </span>
        ) : (
          p
        )
      )}
    </>
  );
}

/**
 * The stat tile's trend: one thin column per period, the current period in
 * the accent and the rest de-emphasised. Columns rather than a line because
 * the series are small integer counts where most periods may be zero — a
 * zero is drawn as a hairline at the baseline so "nothing" is visibly
 * nothing, not missing. 2px surface gaps between fills; no per-mark labels
 * (the tile's value carries the current figure). Each column carries its
 * count in a hover title over a full-height hit area.
 */
function Sparkbars({ values, label, names }: { values: number[]; label: string; names?: string[] }) {
  const max = Math.max(...values, 1);
  const w = 4;
  const gap = 3;
  const h = 28;
  const width = values.length * (w + gap) - gap;
  return (
    <svg
      viewBox={`0 0 ${width} ${h}`}
      width={width}
      height={h}
      role="img"
      aria-label={`${label}: ${values.join(", ")}`}
      className="mb-1 h-[28px] w-auto shrink-0 overflow-visible sm:max-w-[45%]"
      preserveAspectRatio="none"
    >
      {values.map((v, i) => {
        const bh = v > 0 ? Math.max((v / max) * h, 2) : 1;
        const current = i === values.length - 1;
        return (
          <g key={i} className="viz-spark group/spark">
            <title>{`${names?.[i] ?? `period ${i + 1}`}: ${v.toLocaleString("en-US")}`}</title>
            <rect x={i * (w + gap) - gap / 2} y={0} width={w + gap} height={h} fill="transparent" />
            <rect
              x={i * (w + gap)}
              y={h - bh}
              width={w}
              height={bh}
              rx={2}
              fill={current ? "var(--viz-seq)" : "var(--viz-axis)"}
              opacity={current ? 1 : v > 0 ? 0.45 : 0.25}
              // The column under the pointer lifts to full ink; its count is in the title.
              className="viz-grow-y transition-opacity duration-(--dur) group-hover/spark:opacity-100 motion-reduce:transition-none"
              style={{ "--viz-i": i } as React.CSSProperties}
            />
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------- magnitude bar list */

export type MagnitudeDatum = {
  key: string;
  label: string;
  sublabel?: string;
  value: number;
  valueLabel: string;
  href?: string;
  /** Hover/focus detail under the value — the disclosed range, say. */
  detail?: string;
  /** Full name for the hover detail when `label` is a symbol. */
  title?: string;
};

/**
 * Ranked horizontal bars — the form for "compare magnitude, low → high".
 * Single sequential hue: these are one measure, not distinct series, so a
 * categorical palette here would imply an identity that does not exist.
 *
 * Every bar carries a hover/focus detail (value first, then the row's
 * `detail` and the chart-wide `note`). It enhances, never gates: the value
 * is also printed at the bar's tip.
 */
export function MagnitudeBars({
  data,
  variant = "ticker",
  note,
}: {
  data: MagnitudeDatum[];
  /** "name" widens the label column and drops the mono face used for symbols. */
  variant?: "ticker" | "name";
  /** What every value is, for the detail: "estimate — sum of bracket
   *  midpoints" for congressional volume, "shares × reported price" for
   *  insider values. */
  note?: string;
}) {
  const uid = useId();
  if (!data.length) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), 1);
  const isName = variant === "name";

  return (
    <ol className="space-y-0.5">
      {data.map((d, i) => {
        const pct = Math.max((d.value / max) * 100, 0.8);
        const tipId = `${uid}-${i}`;
        const row = (
          <div
            className={cn(
              // [rank][label][bar][value]. Narrower label column on a phone
              // so the bar keeps enough width to compare; the label
              // truncates with its full text in the title. The value column
              // is fixed so figures right-align down the list.
              "grid items-center gap-x-2.5 sm:gap-x-3",
              isName
                ? "grid-cols-[1rem_8rem_minmax(0,1fr)_4rem] sm:grid-cols-[1.25rem_11rem_minmax(0,1fr)_5rem]"
                : "grid-cols-[1rem_6.5rem_minmax(0,1fr)_4rem] sm:grid-cols-[1.25rem_7.5rem_minmax(0,1fr)_5rem]"
            )}
          >
            <div aria-hidden className="tabular text-right text-[12px] text-muted-foreground">
              {i + 1}
            </div>
            <div className="min-w-0">
              <div
                title={d.label}
                className={cn(
                  "truncate text-[14px] leading-5 tracking-[-0.01em]",
                  isName ? "font-medium" : "font-semibold"
                )}
              >
                {d.label}
              </div>
              {d.sublabel ? (
                <div title={d.title ?? d.sublabel} className="truncate text-[12px] leading-4 text-muted-foreground">
                  {d.sublabel}
                </div>
              ) : null}
            </div>
            <div
              className="relative h-2 rounded-full"
              style={{ background: "var(--viz-track)" }}
              role="img"
              aria-label={`${d.label}: ${d.valueLabel}`}
            >
              {/* Rounded data-end, square at the baseline. */}
              <div
                className="viz-grow-x viz-bar h-2"
                style={{
                  width: `${pct}%`,
                  background: "var(--viz-seq)",
                  borderRadius: "999px",
                  "--viz-i": i,
                } as React.CSSProperties}
              />
              <BarTip
                id={tipId}
                at={pct}
                value={d.valueLabel}
                name={d.title ?? d.label}
                lines={[d.detail, note]}
              />
            </div>
            <div className="tabular whitespace-nowrap text-right text-[14px] font-semibold text-foreground">
              <Figure value={d.valueLabel} />
            </div>
          </div>
        );
        return (
          <li key={d.key}>
            {d.href ? (
              <a href={d.href} aria-describedby={tipId} className={cn("group/bar", BAR_ROW)}>
                {row}
              </a>
            ) : (
              // Focusable so the detail is reachable by keyboard, not hover only.
              <div tabIndex={0} aria-describedby={tipId} className={cn("group/bar", BAR_ROW)}>
                {row}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The detail line for any congressional volume bar: the value is a sum of
 *  bracket midpoints, never a reported figure. */
export const VOLUME_NOTE = "estimate: sum of bracket midpoints";

/** Keyboard focus on any chart hit target: the 2px ring, offset off the card. */
export const VIZ_FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--card-solid)]";

/**
 * Every chart tooltip wears this: the popover surface, a hairline and a
 * small shadow — the one popover elevation. Value first at 13px, the rest at
 * the 12px meta size.
 */
export const TIP_SURFACE =
  "rounded-xl bg-popover px-3 py-2 text-left text-[12px] leading-snug text-popover-foreground shadow-popover";

/** A bar row: the hit target is the whole row, washed on hover, with a visible focus ring. */
export const BAR_ROW = cn(
  "block rounded-[10px] px-2 py-1.5 transition-colors duration-(--dur) ease-(--ease-out) motion-reduce:transition-none hover:bg-foreground/[0.04]",
  VIZ_FOCUS
);

/**
 * Hover/focus detail for one bar, anchored at the bar's end. CSS only: shown
 * while the row (`group/bar`) is hovered or keyboard-focused. Value leads,
 * name and notes follow. Kept out of the accessibility tree and referenced
 * by the row's aria-describedby, so a screen reader hears it once.
 */
export function BarTip({
  id,
  at,
  value,
  name,
  lines,
}: {
  id: string;
  /** The bar's end, as a percentage of the track. */
  at: number;
  value: string;
  name: string;
  lines: (string | undefined)[];
}) {
  // Anchor so the panel never hangs off the short end of the track.
  const align = at > 66 ? "-translate-x-full" : at < 20 ? "-translate-x-3" : "-translate-x-1/2";
  return (
    <div
      id={id}
      aria-hidden
      className={cn(
        "viz-tip pointer-events-none absolute bottom-full z-20 mb-2 w-max max-w-[16rem]",
        TIP_SURFACE,
        align,
        // A hidden panel still counts toward the page's scroll width, so on a
        // phone it is not laid out at all until its row is hovered or
        // focused; and once shown it hangs leftward from the track's right
        // end, which always sits inside the screen, rather than from the bar.
        "max-sm:hidden max-sm:group-hover/bar:block max-sm:group-focus-visible/bar:block",
        "max-sm:left-auto! max-sm:right-0 max-sm:translate-x-0"
      )}
      // Inline: `.viz-tip` (globals.css) sets the card surface; tooltips use the popover step.
      style={{ left: `${at}%`, background: "var(--popover)" }}
    >
      <div className="tabular text-[13px] font-semibold text-foreground">{value}</div>
      <div className="text-ink-2">{name}</div>
      {lines.filter(Boolean).map((l) => (
        <div key={l} className="text-muted-foreground">
          {l}
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------- buy / sell split */

export type SplitDatum = {
  key: string;
  label: string;
  sublabel?: string;
  buy: number;
  sell: number;
  note?: string;
  href?: string;
};

/**
 * Diverging bars centred on a shared baseline: buys extend left, sells right.
 * This is a polarity encoding, so both arms share one scale and the midpoint
 * is neutral surface — the reader compares direction, not just size. Ink and
 * silver are only the echo: the side of the axis, the "← Bought" / "Sold →"
 * captions and the legend carry the direction, and every bar has its count
 * printed at the tip (silver is 2.2:1 on white, so it is never unlabelled).
 */
export function DivergingSplit({ data, unit }: { data: SplitDatum[]; unit: string }) {
  const uid = useId();
  if (!data.length) return <Empty />;
  const maxBuy = Math.max(0, ...data.map((d) => d.buy));
  const maxSell = Math.max(0, ...data.map((d) => d.sell));
  if (!maxBuy && !maxSell) return <Empty />;
  // [buy count gutter][buy arm][axis][sell arm][sell count gutter]. The fr
  // tracks are proportional to each arm's maximum, so one unit is the same
  // width on both sides; minmax(0, …) so a caption wider than its arm can
  // never stretch the track and pull the axis out of line. The 5px axis
  // track leaves a 2px surface gap either side of the 1px baseline.
  const plotCols = [
    maxBuy ? "1.75rem" : "0px",
    `minmax(0,${maxBuy}fr)`,
    "5px",
    `minmax(0,${maxSell}fr)`,
    maxSell ? "1.75rem" : "0px",
  ].join(" ");
  // Where the axis falls across the plot, near enough to anchor the row
  // detail on it without the panel hanging off the card.
  const axisAt = (maxBuy / (maxBuy + maxSell)) * 100;
  // The label column is one aligned track. Narrow containers (a phone, a
  // half-width card) stack ticker over name; wider ones set them on one line.
  const rowCols =
    "grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 @md:grid-cols-[13rem_minmax(0,1fr)] @3xl:grid-cols-[17rem_minmax(0,1fr)]";

  return (
    <div className="@container">
      <Legend
        items={[
          { color: "var(--viz-buy)", label: "Bought" },
          { color: "var(--viz-sell)", label: "Sold" },
        ]}
        // One-sided lists say so in words: the collapsed arm alone is easy
        // to misread as a rendering fault.
        note={[unit, !maxBuy && "no buys in this list", !maxSell && "no sales in this list"]
          .filter(Boolean)
          .join(" · ")}
      />
      <div className="relative mt-3">
        {/* Direction captions either side of the baseline, in words. */}
        <div aria-hidden className={cn(rowCols, "px-2 pb-0.5")}>
          <div />
          <div
            className="grid text-[12px] leading-5 text-muted-foreground"
            style={{ gridTemplateColumns: plotCols }}
          >
            <div />
            {/* flex-end so a caption wider than a short arm spills into the
                gutter on its left rather than across the axis. */}
            <div className="flex justify-end whitespace-nowrap pr-2">{maxBuy ? "← Bought" : null}</div>
            <div />
            <div className="whitespace-nowrap pl-2">{maxSell ? "Sold →" : null}</div>
            <div />
          </div>
        </div>
        <ol className="space-y-px">
          {data.map((d, i) => {
            const words = `${d.buy} bought, ${d.sell} sold`;
            const tipId = `${uid}-${i}`;
            const name = [d.label, d.sublabel].filter(Boolean).join(" · ");
            const row = (
              <div className={cn(rowCols, "items-center")}>
                <div
                  title={name}
                  className="flex min-w-0 flex-col @md:flex-row @md:items-baseline @md:gap-2"
                >
                  <span className="truncate text-[14px] font-semibold leading-5 tracking-[-0.01em] @md:w-[3.75rem] @md:shrink-0">
                    {d.label}
                  </span>
                  {d.sublabel ? (
                    <span className="truncate text-[12px] leading-4 text-muted-foreground @md:leading-5">
                      {d.sublabel}
                    </span>
                  ) : null}
                </div>
                <div
                  className="relative grid h-6 items-center"
                  style={{ gridTemplateColumns: plotCols }}
                  role="img"
                  aria-label={`${d.label}: ${words}`}
                >
                  <div />
                  {/* Buy arm, growing out from the baseline to the left. */}
                  <div className="flex justify-end">
                    {d.buy > 0 ? (
                      <SplitBar value={d.buy} pct={(d.buy / maxBuy) * 100} side="buy" i={i} />
                    ) : null}
                  </div>
                  <div />
                  <div className="flex">
                    {d.sell > 0 ? (
                      <SplitBar value={d.sell} pct={(d.sell / maxSell) * 100} side="sell" i={i} />
                    ) : null}
                  </div>
                  <div />
                  <BarTip
                    id={tipId}
                    at={axisAt}
                    value={`${d.buy} bought · ${d.sell} sold`}
                    name={name}
                    lines={[d.note, unit]}
                  />
                </div>
              </div>
            );
            return (
              <li key={d.key}>
                {d.href ? (
                  <a href={d.href} aria-describedby={tipId} className={cn("group/bar", BAR_ROW)}>
                    {row}
                  </a>
                ) : (
                  // Focusable so the detail is reachable by keyboard, not hover only.
                  <div tabIndex={0} aria-describedby={tipId} className={cn("group/bar", BAR_ROW)}>
                    {row}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {/* One continuous hairline baseline through every row. Drawn last so
            a row's hover wash never hides it; it sits in the axis track,
            clear of every bar. */}
        <div aria-hidden className={cn(rowCols, "pointer-events-none absolute inset-0 px-2")}>
          <div />
          <div className="grid" style={{ gridTemplateColumns: plotCols }}>
            <div />
            <div />
            <div className="mx-auto h-full w-px" style={{ background: "var(--viz-axis)", opacity: 0.45 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One arm's bar with its count at the tip. The count always sits OUTSIDE the
 * bar, in the gutter reserved for it, never inside: a 12px numeral on the
 * silver fill misses 4.5:1, and a count that moved in and out of its bar
 * with the bar's length would not scan down the column. The count is in the
 * muted text ink (5.1:1 light, 5.9:1 dark), not the bar's grey.
 */
function SplitBar({ value, pct, side, i }: { value: number; pct: number; side: "buy" | "sell"; i: number }) {
  const buy = side === "buy";
  return (
    <div className="relative h-2.5 shrink-0" style={{ width: `max(${pct}%, 3px)` }}>
      <div
        className={cn("viz-bar h-2.5", buy ? "viz-grow-x-end" : "viz-grow-x")}
        style={{
          background: buy ? "var(--viz-buy)" : "var(--viz-sell)",
          // Rounded data-end, square at the baseline.
          borderRadius: buy ? "999px 2px 2px 999px" : "2px 999px 999px 2px",
          "--viz-i": i,
        } as React.CSSProperties}
      />
      <span
        className={cn(
          "viz-fade tabular absolute top-1/2 -translate-y-1/2 text-[12px] leading-none text-muted-foreground transition-colors duration-(--dur) group-hover/bar:text-foreground group-focus-visible/bar:text-foreground motion-reduce:transition-none",
          buy ? "right-full pr-1.5" : "left-full pl-1.5"
        )}
        style={{ "--viz-i": i } as React.CSSProperties}
      >
        {value}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------- range meter */

/**
 * A single disclosed volume as what it actually is: an interval with an
 * estimated midpoint. Rendering only the midpoint would present a bracket as
 * a measurement.
 */
export function VolumeRange({
  min,
  max,
  mid,
  scaleMax,
}: {
  min: number;
  max: number | null;
  mid: number;
  scaleMax: number;
}) {
  const pct = (v: number) => Math.max(0, Math.min((v / (scaleMax || 1)) * 100, 100));
  const openEnded = max == null;
  const lo = pct(min);
  const hi = openEnded ? 100 : pct(max);
  const at = pct(mid);
  // Floor and ceiling get their own labels only when far enough apart not to
  // collide on a phone; otherwise one label names both.
  const apart = hi - lo >= 42;
  const term = (t: string) => <span className="text-muted-foreground">{t}</span>;
  const ceiling = openEnded ? (
    term("no ceiling →")
  ) : (
    <>
      {term("ceiling")} {usd(max)}
    </>
  );
  const floor = (
    <>
      {term("floor")} {usd(min)}
    </>
  );
  const described = openEnded
    ? `Disclosed at least ${usd(min)}, no upper bound (open-ended bracket); midpoint estimate ${usd(mid)}`
    : `Disclosed ${usd(min)} to ${usd(max)}; midpoint estimate ${usd(mid)}`;
  const band = "color-mix(in oklab, var(--viz-seq) 30%, transparent)";

  return (
    <div role="img" aria-label={described} className="relative select-none pb-6 pt-7">
      {/* The estimate, above its tick: the figure leads, its kind follows. */}
      <AxisLabel at={at} className="top-0 text-[13px] font-semibold text-foreground">
        est. {usd(mid)}{" "}
        <span className="text-[12px] font-normal text-muted-foreground">
          {openEnded ? "open brackets at floor" : "midpoint"}
        </span>
      </AxisLabel>
      <div className="relative h-3 rounded-full" style={{ background: "var(--viz-track)" }}>
        {/* The disclosed band, floor to ceiling. An open-ended ceiling fades
            out to the edge instead of stopping at an invented bound. */}
        <div
          className="viz-grow-x absolute inset-y-0"
          style={{
            left: `${lo}%`,
            width: `${Math.max(hi - lo, 0.8)}%`,
            background: openEnded ? `linear-gradient(to right, ${band}, transparent)` : band,
          }}
        />
        {/* Floor and ceiling as solid edges; an open ceiling has none. */}
        {[lo, ...(openEnded ? [] : [hi])].map((p, i) => (
          <div
            key={i}
            className={cn("absolute inset-y-0 w-0.5", i ? "-translate-x-full" : "")}
            style={{ left: `${p}%`, background: "var(--viz-seq)" }}
          />
        ))}
        {/* Midpoint tick — an estimate, marked as a line rather than a fill.
            The 2px surface ring keeps it distinct where it crosses the band. */}
        <div
          className="viz-fade absolute -inset-y-[5px] w-0.5 -translate-x-1/2 rounded-full"
          style={{
            left: `${at}%`,
            background: "var(--foreground)",
            boxShadow: "0 0 0 2px var(--card-solid)",
          }}
        />
      </div>
      {/* Axis: hairline ticks at zero, floor and ceiling. */}
      <div className="relative h-1.5">
        {[0, lo, ...(openEnded ? [] : [hi])].map((p, i) => (
          <div
            key={i}
            className={cn("absolute top-0 h-1.5 w-px", i === 2 ? "-translate-x-full" : "")}
            style={{ left: `${p}%`, background: "var(--viz-axis)", opacity: 0.5 }}
          />
        ))}
      </div>
      {lo >= 18 ? <AxisLabel at={0} className="bottom-0 text-muted-foreground">$0</AxisLabel> : null}
      {apart ? (
        <>
          <AxisLabel at={lo} className="bottom-0 text-foreground">
            {floor}
          </AxisLabel>
          <AxisLabel at={hi} className="bottom-0 text-foreground">
            {ceiling}
          </AxisLabel>
        </>
      ) : (
        <AxisLabel at={hi} className="bottom-0 text-foreground">
          {floor} {term("·")} {ceiling}
        </AxisLabel>
      )}
    </div>
  );
}

/** A label pinned to a point on a 0–100% axis, turned inward at the ends. */
function AxisLabel({
  at,
  className,
  children,
}: {
  at: number;
  className?: string;
  children: React.ReactNode;
}) {
  const align = at > 85 ? "-translate-x-full" : at < 12 ? "" : "-translate-x-1/2";
  return (
    <div
      aria-hidden
      className={cn("tabular absolute whitespace-nowrap text-[12px] leading-5", align, className)}
      style={{ left: `${at}%` }}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------- misc */

export function Legend({
  items,
  note,
}: {
  items: { color: string; label: string }[];
  note?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] leading-4 text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 font-medium text-ink-2">
          {/* The key mirrors the mark: a short rounded bar. */}
          <span aria-hidden className="h-2 w-3.5 shrink-0 rounded-full" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
      {note ? <span className="ml-auto text-right">{note}</span> : null}
    </div>
  );
}

/** A quiet one-line state: muted text, no box of its own. */
export function Empty({ children }: { children?: React.ReactNode }) {
  return (
    <div className="max-w-[68ch] py-1 text-[14px] leading-relaxed text-muted-foreground">
      {children ?? "No data yet."}
    </div>
  );
}

/**
 * A section head, the way Apple sets one over a group of tiles: a bold
 * display-face heading on the canvas, sentence case, no rule — the tile
 * under it is the container. `right` is muted meta (a window, a count) or
 * a small control; `kicker` an optional grey line above the heading.
 */
export function SectionTitle({
  children,
  right,
  kicker,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  kicker?: React.ReactNode;
}) {
  return (
    <div className="mb-3 sm:mb-4">
      {kicker ? <div className="kicker mb-0.5">{kicker}</div> : null}
      <div className="flex min-h-8 flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <h2 className="font-display text-[22px] font-bold leading-tight tracking-[-0.022em] text-foreground sm:text-[24px]">
          {children}
        </h2>
        {right ? (
          <div className="flex min-w-0 items-center text-[13px] text-muted-foreground [&>span]:text-[13px]">
            {right}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Where a section's content sits.
 *
 * - `tile` (the default): the white (dark: iOS grey) rounded surface on the
 *   canvas, 20px corners, a shadow you only notice when it is missing.
 *   Charts, lists, tables and forms all sit in one.
 * - `panel`: the same tile (kept as a name for forms and link cards).
 * - `open`: no surface at all, for content that sits on the canvas.
 */
export function Card({
  className,
  children,
  variant = "tile",
}: {
  className?: string;
  children: React.ReactNode;
  variant?: "tile" | "open" | "panel";
}) {
  return (
    <div
      className={cn(
        variant === "open" ? "min-w-0" : "min-w-0 rounded-tile bg-card p-4 shadow-card sm:p-6",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * The quiet alternative to a row of StatTiles: figures inline, label after
 * value, one line on a wide screen — "6,208 trades · 135 members · …". Use
 * it where the counts are context for what follows rather than the news.
 */
export function FactStrip({
  items,
  className,
}: {
  items: { label: string; value: string; title?: string }[];
  className?: string;
}) {
  return (
    <dl className={cn("flex flex-wrap items-baseline gap-x-7 gap-y-2", className)}>
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5" title={it.title}>
          {/* dt first, as <dl> requires; the value is drawn first. */}
          <dt className="order-2 text-[13px] text-muted-foreground">{it.label}</dt>
          <dd className="figure order-1 text-[22px] leading-none text-foreground">
            <Figure value={it.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------ column series */

export type ColumnSeriesDatum = {
  key: string;
  label: string;
  value: number;
  valueLabel: string;
  /** Hover detail — the counts behind a share, say. */
  detail?: string;
};

/**
 * One measure over time as columns from a shared baseline — the form for a
 * monthly share. A single sequential hue, so no legend: the section title
 * names the series. Labels are selective (the peak and the latest column);
 * every column's slot is a hover and keyboard-focus target carrying its
 * value and detail, and the caller keeps a table beside the chart so nothing
 * is colour- or hover-gated.
 */
export function ColumnSeries({ data, height = 128 }: { data: ColumnSeriesDatum[]; height?: number }) {
  if (!data.length) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), Number.EPSILON);
  const peak = data.reduce((best, d) => (d.value > best.value ? d : best), data[0]);
  const latest = data[data.length - 1];
  const n = data.length;

  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map((d, i) => {
          const labelled = d === peak || d === latest;
          // 15% of the plot is kept for the cap label, so the tallest column
          // never pushes its own label out of the box.
          const pct = (d.value / max) * 85;
          return (
            <div
              key={d.key}
              tabIndex={0}
              aria-label={`${d.label}: ${d.valueLabel}${d.detail ? ` — ${d.detail}` : ""}`}
              className={cn(
                "group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end rounded-md transition-colors duration-(--dur) ease-(--ease-out) hover:bg-raised focus-visible:bg-raised motion-reduce:transition-none",
                VIZ_FOCUS
              )}
            >
              {labelled ? (
                <span className="tabular mb-1 text-[12px] leading-4 text-muted-foreground">
                  <Figure value={d.valueLabel} />
                </span>
              ) : null}
              {/* ≤24px wide; 4px rounded cap, square at the baseline. */}
              <div
                aria-hidden
                className="viz-grow-y w-full max-w-6 transition-opacity duration-(--dur) group-hover:opacity-80 motion-reduce:transition-none"
                style={{
                  height: `${pct}%`,
                  minHeight: d.value > 0 ? 2 : 0,
                  background: "var(--viz-seq)",
                  borderRadius: "4px 4px 1px 1px",
                  "--viz-i": i,
                } as React.CSSProperties}
              />
              <Tip
                title={d.label}
                lines={[d.valueLabel, d.detail].filter((l): l is string => !!l)}
                index={i}
                count={n}
              />
            </div>
          );
        })}
      </div>
      {/* Hairline baseline. */}
      <div className="h-px w-full" style={{ background: "var(--viz-axis)", opacity: 0.5 }} />
      <div className="flex gap-1.5">
        {data.map((d, i) => (
          <div key={d.key} className="min-w-0 flex-1">
            <AxisTick label={d.label} index={i} count={n} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- monthly series */

/**
 * Change over time — the forms /trends introduced. Two conventions:
 *
 * - Columns grow from a shared baseline, bought up (ink) and sold down
 *   (silver): the same polarity as `DivergingSplit`, turned vertical for a
 *   time axis, so position carries direction. Lines share one y-axis,
 *   always — two measures of different scale get two charts, never a
 *   second axis.
 * - A second identity inside a direction (party within "bought") is carried
 *   by TEXTURE, not a hue: the page has no party colours, and a hue would
 *   be the only colour in the chart. Texture is the backup identity
 *   channel: 45° and its 135° mirror only (horizontal or vertical reads as
 *   gridlines), always tone-on-tone with the fill it sits in.
 *
 * Every value is in text three ways: a selective cap label, a per-period
 * tooltip listing every series at that x (hover and keyboard focus — the
 * whole slot is the hit target, never the mark), and the `DataTable` twin a
 * page renders beneath each chart. Colour never carries meaning alone.
 */

export type Texture = "solid" | "hatch" | "hatch-mirror";

/** The fill of a mark or a legend swatch: a `--viz-*` role, optionally hatched. */
export function textureStyle(fill: string, texture: Texture = "solid"): React.CSSProperties {
  if (texture === "solid") return { background: fill };
  const angle = texture === "hatch" ? "45deg" : "135deg";
  return {
    backgroundColor: `color-mix(in oklab, ${fill} 28%, transparent)`,
    backgroundImage: `repeating-linear-gradient(${angle}, ${fill} 0 2px, transparent 2px 6px)`,
  };
}

export type ColumnSegment = {
  key: string;
  label: string;
  value: number;
  /** A `--viz-*` role. */
  fill: string;
  texture?: Texture;
};

export type ColumnDatum = {
  key: string;
  /** The x-axis tick ("Sep"). */
  label: string;
  /** The full name for the tooltip and assistive text ("September 2026"). */
  name: string;
  /** Segments from the baseline outward. */
  up: ColumnSegment[];
  down?: ColumnSegment[];
  /** The one direct label per stack, on its cap. Empty string to skip. */
  upLabel?: string;
  downLabel?: string;
  /** Every series at this x, one line each, for the tooltip. */
  tip: string[];
};

/** The cap-label band inside each half of the plot. */
const CAP_PX = 14;

/**
 * Stacked columns on a time axis: one slot per period, growing up and
 * (when any datum has `down` segments) down from a shared baseline on one
 * shared scale. Columns are ≤24px and the slot's leftover is air; the slot
 * itself is the hover and focus target.
 */
export function MonthlyColumns({ data, height = 112 }: { data: ColumnDatum[]; height?: number }) {
  if (!data.length) return <Empty />;
  const sum = (s: ColumnSegment[] | undefined) => (s ?? []).reduce((a, x) => a + x.value, 0);
  const max = Math.max(...data.map((d) => Math.max(sum(d.up), sum(d.down))), 1);
  const hasDown = data.some((d) => d.down?.some((s) => s.value > 0));
  // A present-but-tiny value keeps one pixel: the tooltip and table carry
  // its size, and a column that vanished would read as "nothing happened".
  const px = (v: number) => (v > 0 ? Math.max((v / max) * (height - CAP_PX), 1) : 0);
  const n = data.length;
  // Cap labels are the one direct label per stack. They need a desktop slot
  // and no more than ~14 of them; past that (or on a phone) the tooltip and
  // the table carry the values and the caps stay empty rather than collide.
  // The slot must also be wide enough: in a half-width tile twelve "$1.5M"
  // caps ran into each other, so they need ~3rem a slot (a container query
  // on the chart, not the viewport).
  const cap = cn(
    "tabular hidden text-[11px] leading-[14px] text-muted-foreground",
    n <= 6 ? "@min-[18rem]:block" : n <= 12 ? "@min-[36rem]:block" : n <= 14 && "@min-[42rem]:block"
  );
  const stack =
    "flex w-full max-w-6 flex-col gap-[2px] transition-opacity duration-(--dur) ease-(--ease-out) group-hover:opacity-80 group-focus-visible:opacity-80 motion-reduce:transition-none";

  return (
    <div className="@container">
    <div className="flex gap-[2px]">
      {data.map((d, i) => {
        const up = d.up.filter((s) => s.value > 0);
        const down = (d.down ?? []).filter((s) => s.value > 0);
        return (
          <div
            key={d.key}
            tabIndex={0}
            aria-label={`${d.name}: ${d.tip.join("; ")}`}
            // The whole slot is the target; a faint wash marks the period under the pointer.
            className={cn(
              "group relative flex min-w-0 flex-1 flex-col rounded-md transition-colors duration-(--dur) ease-(--ease-out) hover:bg-raised focus-visible:bg-raised motion-reduce:transition-none",
              VIZ_FOCUS
            )}
          >
            <div className="flex flex-col items-center justify-end" style={{ height }}>
              <span className={cap}>{d.upLabel ?? ""}</span>
              <div className={stack}>
                {/* Tip first in the DOM: the column stacks top-down, the data grows bottom-up. */}
                {[...up].reverse().map((s, j) => (
                  <div
                    key={s.key}
                    style={{
                      height: px(s.value),
                      borderRadius: j === 0 ? "4px 4px 0 0" : 0,
                      ...textureStyle(s.fill, s.texture),
                    }}
                  />
                ))}
              </div>
            </div>
            {/* The zero line. -mx-px bridges the 2px gap between slots so it reads as one axis. */}
            <div className="-mx-px h-px" style={{ background: "var(--viz-axis)", opacity: 0.7 }} />
            {hasDown ? (
              <div className="flex flex-col items-center" style={{ height }}>
                <div className={stack}>
                  {down.map((s, j) => (
                    <div
                      key={s.key}
                      style={{
                        height: px(s.value),
                        borderRadius: j === down.length - 1 ? "0 0 4px 4px" : 0,
                        ...textureStyle(s.fill, s.texture),
                      }}
                    />
                  ))}
                </div>
                <span className={cap}>{d.downLabel ?? ""}</span>
              </div>
            ) : null}
            <AxisTick label={d.label} index={i} count={n} />
            <Tip title={d.name} lines={d.tip} index={i} count={n} />
          </div>
        );
      })}
    </div>
    </div>
  );
}

export type LineSeries = {
  key: string;
  label: string;
  /** A `--viz-*` role. */
  stroke: string;
  /** One value per period. null is a gap in the line, never a zero. */
  values: (number | null)[];
};

const LINE_GUTTERS = "grid-cols-[2.25rem_1fr_3.25rem]";

/**
 * Lines on a time axis with one shared y-axis. The paths are SVG stretched
 * to the plot (`preserveAspectRatio="none"` with non-scaling 2px strokes),
 * everything else — ticks, gridlines, markers, labels, the hover layer — is
 * HTML positioned in percent, so text keeps its size at every width.
 * Series are named at their right-hand end, nudged apart when they meet.
 */
export function MonthlyLines({
  labels,
  names,
  series,
  reference,
  tips,
  height = 160,
}: {
  labels: string[];
  names: string[];
  series: LineSeries[];
  /** A horizontal rule with its own label — a deadline, a target. */
  reference?: { value: number; label: string };
  /** Per period: every series at that x, one line each. */
  tips: string[][];
  height?: number;
}) {
  const n = labels.length;
  if (!n) return <Empty />;
  const present = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const ticks = niceTicks(Math.max(...present, reference?.value ?? 0, 1));
  const yMax = ticks[ticks.length - 1];
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const y = (v: number) => 100 - (v / yMax) * 100;
  const path = (values: (number | null)[]) => {
    let d = "";
    let open = false;
    values.forEach((v, i) => {
      if (v == null) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${x(i).toFixed(2)} ${y(v).toFixed(2)} `;
      open = true;
    });
    return d.trim();
  };
  const ends = series
    .flatMap((s) => {
      for (let i = s.values.length - 1; i >= 0; i--) {
        const v = s.values[i];
        if (v != null) return [{ key: s.key, label: s.label, top: (y(v) / 100) * height }];
      }
      return [];
    })
    .sort((a, b) => a.top - b.top);
  for (let i = 1; i < ends.length; i++) ends[i].top = Math.max(ends[i].top, ends[i - 1].top + 14);

  return (
    <div>
      <div className={cn("grid", LINE_GUTTERS)}>
        <div className="relative" style={{ height }}>
          {ticks.map((t) => (
            <span
              key={t}
              className="tabular absolute right-2 -translate-y-1/2 text-[12px] leading-none text-muted-foreground"
              style={{ top: `${y(t)}%` }}
            >
              {compact(t)}
            </span>
          ))}
        </div>
        <div className="relative" style={{ height }}>
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute inset-x-0 h-px"
              style={{ top: `${y(t)}%`, background: "var(--viz-grid)" }}
            />
          ))}
          {reference ? (
            <>
              <div
                className="absolute inset-x-0 h-px"
                style={{ top: `${y(reference.value)}%`, background: "var(--viz-axis)" }}
              />
              <span
                className="absolute left-1 -translate-y-full pb-0.5 text-[12px] leading-4 text-muted-foreground"
                style={{ top: `${y(reference.value)}%` }}
              >
                {reference.label}
              </span>
            </>
          ) : null}
          <svg
            className="absolute inset-0 h-full w-full overflow-visible"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
          >
            {series.map((s) => (
              <path
                key={s.key}
                d={path(s.values)}
                fill="none"
                stroke={s.stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {series.map((s) =>
            s.values.map((v, i) =>
              v == null ? null : (
                <span
                  key={`${s.key}-${i}`}
                  className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: `${x(i)}%`,
                    top: `${y(v)}%`,
                    background: s.stroke,
                    // The 2px surface ring that keeps a marker legible on a line.
                    boxShadow: "0 0 0 2px var(--card-solid)",
                  }}
                />
              )
            )
          )}
          <div className="absolute inset-0 flex">
            {labels.map((_, i) => (
              <div
                key={i}
                tabIndex={0}
                aria-label={`${names[i]}: ${tips[i].join("; ")}`}
                className={cn("group relative flex-1 rounded-md", VIZ_FOCUS)}
              >
                {/* Crosshair: snaps to the period, so the reader aims at a month, not a 2px line. */}
                <div
                  className="absolute inset-y-0 left-1/2 w-px opacity-0 transition-opacity duration-(--dur) ease-(--ease-out) group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
                  style={{ background: "var(--viz-axis)" }}
                />
                <Tip title={names[i]} lines={tips[i]} index={i} count={n} />
              </div>
            ))}
          </div>
        </div>
        <div className="relative" style={{ height }}>
          {ends.map((e) => (
            <span
              key={e.key}
              className="absolute left-1.5 -translate-y-1/2 whitespace-nowrap text-[12px] leading-none text-muted-foreground"
              style={{ top: e.top }}
            >
              {e.label}
            </span>
          ))}
        </div>
      </div>
      <div className={cn("grid", LINE_GUTTERS)}>
        <div />
        <div className="flex">
          {labels.map((l, i) => (
            <div key={i} className="min-w-0 flex-1">
              <AxisTick label={l} index={i} count={n} />
            </div>
          ))}
        </div>
        <div />
      </div>
    </div>
  );
}

/** A legend whose swatches can carry a texture, and a line key for lines. */
export function ChartLegend({
  items,
  note,
}: {
  items: { label: string; style: React.CSSProperties; kind?: "rect" | "line" }[];
  note?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {/* The key mirrors the mark: a 2px stroke for a line, a small block for a column. */}
          <span
            className={cn("shrink-0", i.kind === "line" ? "h-0.5 w-3.5 rounded-full" : "h-2.5 w-3 rounded-[2px]")}
            style={i.style}
          />
          {i.label}
        </span>
      ))}
      {note ? <span className="ml-auto text-right">{note}</span> : null}
    </div>
  );
}

function AxisTick({ label, index, count }: { label: string; index: number; count: number }) {
  // On a phone a slot is ~25px: the year suffix ("Nov '25") goes, and past
  // eight slots every other tick steps aside as well.
  const short = label.replace(/\s'\d\d$/, "");
  // nowrap, not truncate: a tick may spill into its hidden neighbour's slot.
  return (
    <div
      className={cn(
        "tabular mt-1.5 whitespace-nowrap text-center text-[11px] leading-4 text-muted-foreground sm:text-[12px]",
        count > 8 && index % 2 === 1 && "max-sm:invisible"
      )}
    >
      <span className="sm:hidden">{short}</span>
      <span className="max-sm:hidden">{label}</span>
    </div>
  );
}

/** One tooltip, every series at this x. Hidden from the tree: the slot's aria-label says the same. */
function Tip({ title, lines, index, count }: { title: string; lines: string[]; index: number; count: number }) {
  // Turn inward by where the slot sits across the chart, not by a fixed
  // count of slots, so the panel stays on the card at every width.
  const at = (index + 0.5) / count;
  const align = at < 0.3 ? "left-0" : at > 0.7 ? "right-0" : "left-1/2 -translate-x-1/2";
  return (
    <div
      aria-hidden
      className={cn(
        // Not laid out on a phone until hovered or focused: a hidden panel
        // still counts toward the page's scroll width.
        "max-sm:hidden max-sm:max-w-[16rem] max-sm:group-hover:block max-sm:group-focus-visible:block",
        "pointer-events-none absolute bottom-full z-20 mb-2 w-max max-w-[18rem] translate-y-0.5 opacity-0 transition-[opacity,translate] duration-(--dur) ease-(--ease-out) group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 motion-reduce:transition-none",
        TIP_SURFACE,
        align
      )}
    >
      <div className="text-[13px] font-semibold text-foreground">{title}</div>
      {lines.map((l, i) => (
        <div key={i} className="tabular text-ink-2">
          {l}
        </div>
      ))}
    </div>
  );
}

/** 0 … a round number at or above `top`, in 1/2/5 steps, about four of them. */
function niceTicks(top: number): number[] {
  const raw = top / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let k = 0; k * step < top + step; k++) ticks.push(k * step);
  return ticks;
}

function compact(v: number): string {
  if (v >= 1_000_000) return `${v / 1_000_000}M`;
  if (v >= 1_000) return `${v / 1_000}k`;
  return String(v);
}
