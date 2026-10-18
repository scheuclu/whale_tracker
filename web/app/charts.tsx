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

import { cn } from "@/lib/utils";
import { usd } from "@/lib/format";

/* ---------------------------------------------------------------- stat tile */

export function StatTile({
  label,
  value,
  hint,
  trend,
  trendLabel,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Per-period counts, oldest → newest; the last entry is the period `value` reports. */
  trend?: number[];
  /** Accessible description of the trend, e.g. "cluster alerts per week, last 8 weeks". */
  trendLabel?: string;
}) {
  return (
    <div className="glass rounded-2xl border border-border bg-card px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-end justify-between gap-3">
        <div className="text-xl font-semibold tracking-tight sm:text-2xl">{value}</div>
        {trend?.length ? <Sparkbars values={trend} label={trendLabel ?? label} /> : null}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/**
 * The stat tile's trend: one thin column per period, the current period in
 * the accent and the rest de-emphasised. Columns rather than a line because
 * the series are small integer counts where most periods may be zero — a
 * zero is drawn as a hairline at the baseline so "nothing" is visibly
 * nothing, not missing. 2px surface gaps between fills; no per-mark labels
 * (the tile's value carries the current figure).
 */
function Sparkbars({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(...values, 1);
  const w = 4;
  const gap = 2;
  const h = 18;
  return (
    <svg
      width={values.length * (w + gap) - gap}
      height={h}
      role="img"
      aria-label={`${label}: ${values.join(", ")}`}
      className="mb-1 shrink-0"
    >
      {values.map((v, i) => {
        const bh = v > 0 ? Math.max((v / max) * h, 2) : 1;
        const current = i === values.length - 1;
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={h - bh}
            width={w}
            height={bh}
            rx={1}
            fill={current ? "var(--viz-seq)" : "var(--viz-axis)"}
            opacity={current ? 1 : v > 0 ? 0.45 : 0.25}
          />
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
};

/**
 * Ranked horizontal bars — the form for "compare magnitude, low → high".
 * Single sequential hue: these are one measure, not distinct series, so a
 * categorical palette here would imply an identity that does not exist.
 */
export function MagnitudeBars({
  data,
  variant = "ticker",
}: {
  data: MagnitudeDatum[];
  /** "name" widens the label column and drops the mono face used for symbols. */
  variant?: "ticker" | "name";
}) {
  if (!data.length) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), 1);
  const isName = variant === "name";

  return (
    <ol className="space-y-1.5">
      {data.map((d) => {
        const pct = Math.max((d.value / max) * 100, 0.8);
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
              className="h-3 rounded-sm"
              style={{ background: "var(--viz-track)" }}
              role="img"
              aria-label={`${d.label}: ${d.valueLabel}`}
            >
              {/* 4px rounded data-end, square at the baseline. */}
              <div
                className="h-3"
                style={{
                  width: `${pct}%`,
                  background: "var(--viz-seq)",
                  borderRadius: "2px 4px 4px 2px",
                }}
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
              <a href={d.href} className="block rounded-lg px-1 py-1 transition-colors hover:bg-muted">
                {row}
              </a>
            ) : (
              <div className="px-1 py-1">{row}</div>
            )}
          </li>
        );
      })}
    </ol>
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
  const max = Math.max(...data.flatMap((d) => [d.buy, d.sell]), 1);

  return (
    <div>
      <Legend
        items={[
          { color: "var(--viz-buy)", label: "Bought" },
          { color: "var(--viz-sell)", label: "Sold" },
        ]}
        note={unit}
      />
      <ol className="mt-3 space-y-1.5">
        {data.map((d) => {
          const row = (
            <div className="grid grid-cols-[5.5rem_1fr] items-center gap-3 sm:grid-cols-[7rem_1fr]">
              <div className="min-w-0">
                <div className="truncate font-mono text-[13px] font-semibold tracking-tight">
                  {d.label}
                </div>
                {d.sublabel ? (
                  <div className="truncate text-[11px] text-muted-foreground">{d.sublabel}</div>
                ) : null}
              </div>
              <div className="flex items-center gap-0.5">
                {/* Left arm: buys. Value labelled at the tip, outside the bar. */}
                <div className="flex flex-1 items-center justify-end gap-1.5">
                  {d.buy > 0 ? (
                    <span className="tabular text-[11px] text-muted-foreground">{d.buy}</span>
                  ) : null}
                  <div
                    className="h-3"
                    style={{
                      width: `${(d.buy / max) * 100}%`,
                      background: "var(--viz-buy)",
                      borderRadius: "4px 2px 2px 4px",
                    }}
                  />
                </div>
                {/* 2px surface gap at the shared baseline. */}
                <div className="h-4 w-0.5 shrink-0 rounded-full bg-border" />
                <div className="flex flex-1 items-center gap-1.5">
                  <div
                    className="h-3"
                    style={{
                      width: `${(d.sell / max) * 100}%`,
                      background: "var(--viz-sell)",
                      borderRadius: "2px 4px 4px 2px",
                    }}
                  />
                  {d.sell > 0 ? (
                    <span className="tabular text-[11px] text-muted-foreground">{d.sell}</span>
                  ) : null}
                </div>
              </div>
            </div>
          );
          return (
            <li key={d.key}>
              {d.href ? (
                <a href={d.href} className="block rounded-lg px-1 py-1 transition-colors hover:bg-muted">
                  {row}
                </a>
              ) : (
                <div className="px-1 py-1">{row}</div>
              )}
            </li>
          );
        })}
      </ol>
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
  const pct = (v: number) => Math.min((v / scaleMax) * 100, 100);
  const openEnded = max == null;
  const right = openEnded ? 100 : pct(max);

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-3 flex-1 rounded-sm" style={{ background: "var(--viz-track)" }}>
        <div
          className="absolute inset-y-0 rounded-sm opacity-40"
          style={{
            left: `${pct(min)}%`,
            width: `${Math.max(right - pct(min), 0.8)}%`,
            background: "var(--viz-seq)",
          }}
        />
        {/* Midpoint tick — an estimate, marked as a line rather than a fill. */}
        <div
          className="absolute inset-y-0 w-0.5"
          style={{ left: `${pct(mid)}%`, background: "var(--viz-seq)" }}
        />
      </div>
      <span className="tabular w-28 text-right text-xs text-muted-foreground">
        {openEnded ? `≥${usd(min)}` : `${usd(min)}–${usd(max)}`}
      </span>
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
          <span className="size-2 rounded-full" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
      {note ? <span className="ml-auto">{note}</span> : null}
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
    <div className="mb-3 flex items-center gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {children}
      </h2>
      <div className="rule-fade flex-1" />
      {right}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("glass rounded-2xl border border-border bg-card p-5", className)}>
      {children}
    </div>
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
 * every column carries its value in its hover title, and the caller keeps a
 * table beside the chart so nothing is colour- or hover-gated.
 */
export function ColumnSeries({ data, height = 128 }: { data: ColumnSeriesDatum[]; height?: number }) {
  if (!data.length) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), Number.EPSILON);
  const peak = data.reduce((best, d) => (d.value > best.value ? d : best), data[0]);
  const latest = data[data.length - 1];

  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map((d) => {
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
                className="w-full max-w-6"
                style={{
                  height: `${pct}%`,
                  minHeight: d.value > 0 ? 2 : 0,
                  background: "var(--viz-seq)",
                  borderRadius: "4px 4px 2px 2px",
                }}
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

/* ------------------------------------------------------- monthly series */

/**
 * Change over time — the forms /trends introduced. Two conventions:
 *
 * - Columns grow from a shared baseline, bought up and sold down: the same
 *   diverging blue/red polarity as `DivergingSplit`, turned vertical for a
 *   time axis. Lines share one y-axis, always — two measures of different
 *   scale get two charts, never a second axis.
 * - A second identity inside a direction (party within "bought") is carried
 *   by TEXTURE, not a third hue. There are two direction colours, and the
 *   party badges already use the same blue and red, so a hue per party
 *   would collide with both readings. Texture is the backup identity
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
  const cap = cn("tabular hidden text-[10px] leading-[14px] text-muted-foreground", n <= 14 && "sm:block");

  return (
    <div className="flex gap-[2px]">
      {data.map((d, i) => {
        const up = d.up.filter((s) => s.value > 0);
        const down = (d.down ?? []).filter((s) => s.value > 0);
        return (
          <div
            key={d.key}
            tabIndex={0}
            aria-label={`${d.name}: ${d.tip.join("; ")}`}
            className="group relative flex min-w-0 flex-1 flex-col rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex flex-col items-center justify-end" style={{ height }}>
              <span className={cap}>{d.upLabel ?? ""}</span>
              <div className="flex w-full max-w-6 flex-col gap-[2px] transition-opacity group-hover:opacity-80">
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
            <div className="h-px w-full" style={{ background: "var(--viz-axis)" }} />
            {hasDown ? (
              <div className="flex flex-col items-center" style={{ height }}>
                <div className="flex w-full max-w-6 flex-col gap-[2px] transition-opacity group-hover:opacity-80">
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
  for (let i = 1; i < ends.length; i++) ends[i].top = Math.max(ends[i].top, ends[i - 1].top + 12);

  return (
    <div>
      <div className={cn("grid", LINE_GUTTERS)}>
        <div className="relative" style={{ height }}>
          {ticks.map((t) => (
            <span
              key={t}
              className="tabular absolute right-2 -translate-y-1/2 text-[10px] text-muted-foreground"
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
                className="absolute left-1 -translate-y-full pb-0.5 text-[10px] text-muted-foreground"
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
                    boxShadow: "0 0 0 2px var(--background)",
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
                className="group relative flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {/* Crosshair: snaps to the period, so the reader aims at a month, not a 2px line. */}
                <div
                  className="absolute inset-y-0 left-1/2 w-px opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
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
              className="absolute left-1.5 -translate-y-1/2 whitespace-nowrap text-[10px] text-muted-foreground"
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className={i.kind === "line" ? "h-0.5 w-4 rounded-full" : "h-3 w-4 rounded-[3px]"} style={i.style} />
          {i.label}
        </span>
      ))}
      {note ? <span className="ml-auto">{note}</span> : null}
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
        "mt-1.5 whitespace-nowrap text-center text-[10px] text-muted-foreground",
        count > 8 && index % 2 === 1 && "max-sm:invisible"
      )}
    >
      <span className="sm:hidden">{short}</span>
      <span className="max-sm:hidden">{label}</span>
    </div>
  );
}

/**
 * One tooltip, every series at this x. Hidden from the tree: the slot's
 * aria-label says the same. Not rendered at all until the slot is hovered or
 * focused: an invisible box is still laid out, and one centred on a slot near
 * the right edge reached 17px past a 390px viewport, which gave the page a
 * horizontal scroll (#49's guarantee).
 */
function Tip({ title, lines, index, count }: { title: string; lines: string[]; index: number; count: number }) {
  const align = index < 2 ? "left-0" : index > count - 3 ? "right-0" : "left-1/2 -translate-x-1/2";
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute bottom-full z-20 mb-1 hidden w-max max-w-[18rem] rounded-lg border border-border bg-popover px-2.5 py-1.5 text-left text-[11px] leading-snug text-popover-foreground shadow-lg group-hover:block group-focus-visible:block",
        align
      )}
    >
      <div className="font-medium">{title}</div>
      {lines.map((l, i) => (
        <div key={i} className="tabular text-muted-foreground">
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
