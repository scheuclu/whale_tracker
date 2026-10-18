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
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="glass rounded-2xl border border-border bg-card px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
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
              "grid items-center gap-3",
              isName ? "grid-cols-[11rem_1fr_auto]" : "grid-cols-[7rem_1fr_auto]"
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
            <div className="tabular w-20 text-right text-[13px] text-muted-foreground">
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
            <div className="grid grid-cols-[7rem_1fr] items-center gap-3">
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
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
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
