import { points } from "@/lib/track-queries";
import { cn } from "@/lib/utils";

/*
 * Pieces shared by the track-record leaderboard and the member page's track
 * record section. A score is not a direction, so nothing here has a hue:
 * the interval is the neutral band (`--viz-seq`), the estimate a dark dot
 * (`--viz-price`), zero a hairline axis — the same neutral roles the volume
 * range meter uses (DESIGN.md, "Data-viz roles"). The figures are printed
 * beside every mark in text ink.
 */

/**
 * An estimate with its 90% interval on a symmetric axis around zero: a
 * forest-plot row. `scale` is the largest |value| the column shows, so
 * every row of a table shares one axis.
 */
export function IntervalBar({
  score,
  lo,
  hi,
  scale,
  label,
  className,
}: {
  score: number;
  lo: number | null;
  hi: number | null;
  scale: number;
  /** Accessible and hover description. */
  label: string;
  className?: string;
}) {
  const s = scale > 0 ? scale : 1;
  const at = (v: number) => Math.max(0, Math.min(100, 50 + (v / s) * 50));
  const left = lo == null ? null : at(lo);
  const right = hi == null ? null : at(hi);
  return (
    <div role="img" aria-label={label} title={label} className={cn("relative h-5 w-full min-w-24", className)}>
      {/* Recessed capsule track and zero axis. */}
      <div className="apple-inset-well absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full" />
      <div className="absolute inset-y-0.5 left-1/2 w-px -translate-x-1/2" style={{ background: "var(--viz-axis)", opacity: 0.7 }} />
      {left != null && right != null ? (
        <div
          className="viz-grow-x absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
          style={{
            left: `${left}%`,
            width: `${Math.max(right - left, 1.5)}%`,
            background: "color-mix(in oklab, var(--viz-seq) 55%, transparent)",
          }}
        />
      ) : null}
      <div
        className="viz-fade absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform duration-200 group-hover:scale-110"
        style={{
          left: `${at(score)}%`,
          background: "var(--foreground)",
          boxShadow: "0 0 0 2px var(--card-solid), 0 1px 3px rgba(0,0,0,0.22)",
        }}
      />
    </div>
  );
}

/** "+4.2 pts" with the unit at the figure's small size. */
export function Points({ value, className }: { value: number | null | undefined; className?: string }) {
  return (
    <span className={cn("tabular", className)}>
      {points(value)}
      <span className="ml-0.5 text-[0.75em] font-normal text-muted-foreground">pts</span>
    </span>
  );
}

/** "−1.0 to +9.3" — an interval in points. */
export function intervalText(lo: number | null, hi: number | null): string {
  return lo == null || hi == null ? "—" : `${points(lo)} to ${points(hi)}`;
}

/** "better than 87% of random picks on the same dates" — the luck check in words. */
export function luckText(luck: number | null): string {
  if (luck == null) return "—";
  const p = Math.round(luck * 100);
  return `beats ${p}%`;
}
