/**
 * Pure CSS/SVG charts — no chart library, matching the sibling
 * youtube_finance_bro dashboard.
 *
 * Mark specs: bars ≤24px thick with a 4px rounded data-end squared at the
 * baseline, hairline recessive axes, 2px surface gaps between touching fills,
 * and selective direct labels (the value at the bar tip, never on every mark).
 *
 * Colour roles come from `--viz-*` in globals.css. Buy/sell is a diverging
 * blue↔red pair rather than the finance-convention green/red, which fails
 * colour-vision-deficiency separation — see the note in globals.css.
 */

import { useId } from "react";
import { cn } from "@/lib/utils";
import { usd } from "@/lib/format";

/* ---------------------------------------------------------------- stat tile */

/** A change against a named earlier period. `text` must name the period
 *  ("+8% vs prior 12 wk"); colour stays neutral — more trades is neither
 *  good nor bad, and blue/red is reserved for buy/sell. */
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
  return (
    <div className="viz-rise glass flex h-full flex-col rounded-2xl border border-border bg-card px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
          {label}
        </div>
        {trend?.length && trendCaption ? (
          <div className="truncate text-[10px] text-muted-foreground/80">{trendCaption}</div>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-3">
        <div className="text-[1.375rem] font-semibold leading-none tracking-tight sm:text-[1.625rem]">
          {value}
        </div>
        {trend?.length ? (
          <Sparkbars values={trend} label={trendLabel ?? label} names={trendLabels} />
        ) : null}
      </div>
      {hint ? <div className="mt-2 text-xs leading-snug text-muted-foreground">{hint}</div> : null}
      {delta ? (
        <div className="mt-1 text-xs text-foreground/75" title={delta.title}>
          <span aria-hidden className="mr-1 text-[10px]">
            {delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "■"}
          </span>
          {delta.text}
        </div>
      ) : null}
    </div>
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
  const w = 5;
  const gap = 2;
  const h = 26;
  const width = values.length * (w + gap) - gap;
  return (
    <svg
      viewBox={`0 0 ${width} ${h}`}
      width={width}
      height={h}
      role="img"
      aria-label={`${label}: ${values.join(", ")}`}
      className="mb-0.5 h-[26px] w-auto max-w-[45%] shrink-0 overflow-visible"
      preserveAspectRatio="none"
    >
      {values.map((v, i) => {
        const bh = v > 0 ? Math.max((v / max) * h, 2) : 1;
        const current = i === values.length - 1;
        return (
          <g key={i} className="viz-spark">
            <title>{`${names?.[i] ?? `period ${i + 1}`}: ${v.toLocaleString("en-US")}`}</title>
            <rect x={i * (w + gap) - gap / 2} y={0} width={w + gap} height={h} fill="transparent" />
            <rect
              x={i * (w + gap)}
              y={h - bh}
              width={w}
              height={bh}
              rx={1}
              fill={current ? "var(--viz-seq)" : "var(--viz-axis)"}
              opacity={current ? 1 : v > 0 ? 0.5 : 0.25}
              className="viz-grow-y"
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
    <ol className="space-y-1.5">
      {data.map((d, i) => {
        const pct = Math.max((d.value / max) * 100, 0.8);
        const tipId = `${uid}-${i}`;
        const row = (
          <div
            className={cn(
              // Narrower label column on a phone so the bar keeps enough
              // width to compare; the label truncates with its full text in
              // the title.
              "grid items-center gap-3",
              isName
                ? "grid-cols-[8rem_1fr_auto] sm:grid-cols-[11rem_1fr_auto]"
                : "grid-cols-[5.5rem_1fr_auto] sm:grid-cols-[7rem_1fr_auto]"
            )}
          >
            <div className="min-w-0">
              <div
                title={d.label}
                className={cn(
                  "truncate text-[13px] font-semibold tracking-tight",
                  !isName && "font-mono"
                )}
              >
                {d.label}
              </div>
              {d.sublabel ? (
                <div className="truncate text-[11px] text-muted-foreground">{d.sublabel}</div>
              ) : null}
            </div>
            <div
              className="relative h-3 rounded-sm"
              style={{ background: "var(--viz-track)" }}
              role="img"
              aria-label={`${d.label}: ${d.valueLabel}`}
            >
              {/* 4px rounded data-end, square at the baseline. */}
              <div
                className="viz-grow-x viz-bar h-3"
                style={{
                  width: `${pct}%`,
                  background: "var(--viz-seq)",
                  borderRadius: "2px 4px 4px 2px",
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
            <div className="tabular w-16 text-right text-[13px] text-muted-foreground sm:w-20">
              {d.valueLabel}
            </div>
          </div>
        );
        return (
          <li key={d.key}>
            {d.href ? (
              <a href={d.href} aria-describedby={tipId} className={cn("group/bar", BAR_ROW, "hover:bg-muted")}>
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

/** A bar row: the hit target is the whole row, with a visible focus ring. */
const BAR_ROW =
  "block rounded-lg px-1 py-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-foreground/50 focus-visible:ring-offset-1 focus-visible:ring-offset-card";

/**
 * Hover/focus detail for one bar, anchored at the bar's end. CSS only: shown
 * while the row (`group/bar`) is hovered or keyboard-focused. Value leads,
 * name and notes follow. Kept out of the accessibility tree and referenced
 * by the row's aria-describedby, so a screen reader hears it once.
 */
function BarTip({
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
        "viz-tip pointer-events-none absolute bottom-full z-20 mb-2 w-max max-w-[16rem] rounded-lg border border-border px-2.5 py-1.5 text-left shadow-lg",
        align
      )}
      style={{ left: `${at}%` }}
    >
      <div className="tabular text-[13px] font-semibold text-foreground">{value}</div>
      <div className="text-[11px] text-foreground/80">{name}</div>
      {lines.filter(Boolean).map((l) => (
        <div key={l} className="text-[11px] leading-snug text-muted-foreground">
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
 * is neutral surface — the reader compares direction, not just size.
 */
export function DivergingSplit({ data, unit }: { data: SplitDatum[]; unit: string }) {
  if (!data.length) return <Empty />;
  const maxBuy = Math.max(0, ...data.map((d) => d.buy));
  const maxSell = Math.max(0, ...data.map((d) => d.sell));
  if (!maxBuy && !maxSell) return <Empty />;
  // [buy label room][buy arm][axis][sell arm][sell label room]. The fr
  // tracks are proportional to each arm's maximum, so one unit is the same
  // width on both sides. The 6px axis track leaves a 2px surface gap either
  // side of the 2px baseline.
  const plotCols = [
    maxBuy ? "1.75rem" : "0px",
    `${maxBuy}fr`,
    "6px",
    `${maxSell}fr`,
    maxSell ? "1.75rem" : "0px",
  ].join(" ");
  const rowCols = "grid grid-cols-[7.25rem_1fr] gap-3 sm:grid-cols-[10.5rem_1fr]";

  return (
    <div>
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
        {/* Direction captions at the baseline, in words. */}
        <div aria-hidden className={cn(rowCols, "px-1 pb-1")}>
          <div />
          <div
            className="grid text-[10px] uppercase tracking-[0.06em] text-muted-foreground"
            style={{ gridTemplateColumns: plotCols }}
          >
            <div />
            {/* flex-end so a caption wider than a short arm spills into the
                label room on its left rather than being clipped. */}
            <div className="flex justify-end whitespace-nowrap pr-1">{maxBuy ? "← bought" : null}</div>
            <div />
            <div className="whitespace-nowrap pl-1">
              {maxSell ? "sold →" : null}
            </div>
            <div />
          </div>
        </div>
        <ol className="space-y-1">
          {data.map((d, i) => {
            const words = `${d.buy} bought, ${d.sell} sold`;
            const row = (
              <div className={cn(rowCols, "items-center")}>
                <div className="min-w-0">
                  <div className="truncate font-mono text-[13px] font-semibold tracking-tight">
                    {d.label}
                  </div>
                  {d.sublabel ? (
                    <div className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                      {d.sublabel}
                    </div>
                  ) : null}
                </div>
                <div
                  className="grid h-5 items-center"
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
                </div>
              </div>
            );
            const title =
              [d.label, d.sublabel, d.note].filter(Boolean).join(" · ") + ` — ${words} (${unit})`;
            return (
              <li key={d.key}>
                {d.href ? (
                  <a href={d.href} title={title} className={cn(BAR_ROW, "hover:bg-muted")}>
                    {row}
                  </a>
                ) : (
                  <div title={title} className="px-1 py-1">
                    {row}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {/* One continuous baseline through every row. Drawn last so a row's
            hover wash never hides it; it sits in the axis track, clear of
            every bar. */}
        <div aria-hidden className={cn(rowCols, "pointer-events-none absolute inset-0 px-1")}>
          <div />
          <div className="grid" style={{ gridTemplateColumns: plotCols }}>
            <div />
            <div />
            <div className="mx-auto h-full w-0.5 rounded-full" style={{ background: "var(--viz-axis)", opacity: 0.5 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** One arm's bar with its count at the tip, outside the bar. */
function SplitBar({ value, pct, side, i }: { value: number; pct: number; side: "buy" | "sell"; i: number }) {
  const buy = side === "buy";
  return (
    <div className="relative h-3 shrink-0" style={{ width: `max(${pct}%, 3px)` }}>
      <div
        className={cn("h-3", buy ? "viz-grow-x-end" : "viz-grow-x")}
        style={{
          background: buy ? "var(--viz-buy)" : "var(--viz-sell)",
          // 4px rounded data-end, square at the baseline.
          borderRadius: buy ? "4px 2px 2px 4px" : "2px 4px 4px 2px",
          "--viz-i": i,
        } as React.CSSProperties}
      />
      <span
        className={cn(
          "viz-fade tabular absolute top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground",
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
  const ceiling = openEnded ? "no ceiling →" : `ceiling ${usd(max)}`;
  const described = openEnded
    ? `Disclosed at least ${usd(min)}, no upper bound (open-ended bracket); midpoint estimate ${usd(mid)}`
    : `Disclosed ${usd(min)} to ${usd(max)}; midpoint estimate ${usd(mid)}`;
  const band = "color-mix(in oklab, var(--viz-seq) 34%, transparent)";

  return (
    <div role="img" aria-label={described} className="relative select-none pb-6 pt-6">
      {/* The estimate, above its tick. */}
      <AxisLabel at={at} className="top-0 font-medium text-foreground">
        est. {usd(mid)}{" "}
        <span className="font-normal text-muted-foreground">
          {openEnded ? "open brackets at floor" : "midpoint"}
        </span>
      </AxisLabel>
      <div className="relative h-3.5 rounded-sm" style={{ background: "var(--viz-track)" }}>
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
        {/* Midpoint tick — an estimate, marked as a line rather than a fill. */}
        <div
          className="viz-fade absolute -inset-y-1.5 w-0.5 -translate-x-1/2 rounded-full"
          style={{ left: `${at}%`, background: "var(--foreground)" }}
        />
      </div>
      {/* Axis: hairline ticks at zero, floor and ceiling. */}
      <div className="relative h-1.5">
        {[0, lo, ...(openEnded ? [] : [hi])].map((p, i) => (
          <div
            key={i}
            className="absolute top-0 h-1.5 w-px"
            style={{ left: `${p}%`, background: "var(--viz-axis)", opacity: 0.6 }}
          />
        ))}
      </div>
      {lo >= 18 ? <AxisLabel at={0} className="bottom-0 text-muted-foreground">$0</AxisLabel> : null}
      {apart ? (
        <>
          <AxisLabel at={lo} className="bottom-0 text-muted-foreground">
            floor {usd(min)}
          </AxisLabel>
          <AxisLabel at={hi} className="bottom-0 text-muted-foreground">
            {ceiling}
          </AxisLabel>
        </>
      ) : (
        <AxisLabel at={hi} className="bottom-0 text-muted-foreground">
          floor {usd(min)} · {ceiling}
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
      className={cn("tabular absolute whitespace-nowrap text-[11px] leading-5", align, className)}
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {/* The key mirrors the mark: a short bar, not a dot. */}
          <span className="h-2 w-3 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
      {note ? <span className="ml-auto text-right">{note}</span> : null}
    </div>
  );
}

export function Empty({ children }: { children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children ?? "No data yet."}
    </div>
  );
}

export function SectionTitle({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1.5">
      <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-foreground/70">
        {children}
      </h2>
      <div className="rule-fade min-w-6 flex-1" />
      {right ? (
        <div className="flex shrink-0 items-center text-[11px] text-muted-foreground">{right}</div>
      ) : null}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("glass rounded-2xl border border-border bg-card p-4 sm:p-5", className)}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------ column series */

export type ColumnDatum = {
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
 * every column carries its value in its hover title, and the caller keeps a
 * table beside the chart so nothing is colour- or hover-gated.
 */
export function ColumnSeries({ data, height = 128 }: { data: ColumnDatum[]; height?: number }) {
  if (!data.length) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), Number.EPSILON);
  const peak = data.reduce((best, d) => (d.value > best.value ? d : best), data[0]);
  const latest = data[data.length - 1];

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
              className="flex h-full flex-1 flex-col items-center justify-end"
              title={`${d.label}: ${d.valueLabel}${d.detail ? ` — ${d.detail}` : ""}`}
            >
              {labelled ? (
                <span className="tabular mb-1 text-[11px] text-muted-foreground">{d.valueLabel}</span>
              ) : null}
              {/* ≤24px wide; 4px rounded cap, square at the baseline. */}
              <div
                role="img"
                aria-label={`${d.label}: ${d.valueLabel}`}
                className="viz-grow-y w-full max-w-6"
                style={{
                  height: `${pct}%`,
                  minHeight: d.value > 0 ? 2 : 0,
                  background: "var(--viz-seq)",
                  borderRadius: "4px 4px 2px 2px",
                  "--viz-i": i,
                } as React.CSSProperties}
              />
            </div>
          );
        })}
      </div>
      {/* Hairline baseline, recessive. */}
      <div className="h-px w-full" style={{ background: "var(--viz-grid)" }} />
      <div className="mt-1.5 flex gap-1.5">
        {data.map((d) => (
          <div
            key={d.key}
            className="flex-1 truncate text-center text-[10px] text-muted-foreground"
          >
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
