/**
 * The bracket ladder: which STOCK Act value bracket a trade falls in, drawn
 * as ten rungs rising left to right ($1,001–$15,000 … Over $50,000,000), so
 * magnitude is scannable down a column without reading digits.
 *
 * The glyph never replaces the figures — `BracketAmount` always prints the
 * disclosed range next to it — and it encodes only what was filed:
 *
 *   range        rungs below the bracket filled lightly, the bracket's own
 *                rung(s) in full ink, rungs above it empty.
 *   open-ended   every rung from the floor up is drawn full-height with a
 *                fade toward the top: possible, not asserted. No ceiling is
 *                invented ("≥$50M" in the text).
 *   exact        a dot on the rung the printed figure falls in (at the foot
 *                of the ladder when below $1,001), labelled "exact".
 *   transcribed  the same geometry in amber, matching ScanTag: the bracket
 *                is a box ticked on a scan, and the row is in no total.
 *   unknown      empty rungs, "—".
 *
 * Neutral ink rather than a hue: blue↔red is reserved for buy/sell, and the
 * action badge beside it already carries direction. Colours live in
 * `--viz-rung-*` (globals.css), validated as two-step ordinal ramps.
 */

import { useId } from "react";
import { cn } from "@/lib/utils";
import { BRACKETS, bracketSpan } from "@/lib/feed";
import { range } from "@/lib/format";

const RUNG_W = 3;
const RUNG_GAP = 1;
const H = 14;
const MIN_H = 4;
const OPEN_OVERSHOOT = 5;
const N = BRACKETS.length;
export const GLYPH_WIDTH = N * (RUNG_W + RUNG_GAP) - RUNG_GAP;

function rungHeight(i: number) {
  return MIN_H + ((H - MIN_H) * i) / (N - 1);
}

export function BracketGlyph({
  min,
  max,
  exact,
  transcribed,
  className,
}: {
  min: number | null;
  max: number | null;
  exact?: number | null;
  transcribed?: number | boolean | null;
  className?: string;
}) {
  const span = bracketSpan(min, max, exact);
  const fadeId = useId();
  const on = transcribed ? "var(--viz-rung-scan)" : "var(--viz-rung-on)";
  const below = transcribed ? "var(--viz-rung-scan-below)" : "var(--viz-rung-below)";

  return (
    <svg
      width={GLYPH_WIDTH}
      height={H}
      viewBox={`0 0 ${GLYPH_WIDTH} ${H}`}
      aria-hidden
      className={cn("shrink-0 overflow-visible", className)}
      data-bracket-kind={span.kind}
      data-bracket-lo={span.lo}
    >
      {span.kind === "open" ? (
        <defs>
          <linearGradient id={fadeId} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor={on} stopOpacity="1" />
            <stop offset="0.3" stopColor={on} stopOpacity="0.9" />
            <stop offset="1" stopColor={on} stopOpacity="0" />
          </linearGradient>
        </defs>
      ) : null}
      {BRACKETS.map((_, i) => {
        const x = i * (RUNG_W + RUNG_GAP);
        let h = rungHeight(i);
        let fill = "var(--viz-rung-off)";
        if (span.kind === "range") {
          if (i < span.lo) fill = below;
          else if (i <= span.hi) fill = on;
        } else if (span.kind === "open") {
          if (i < span.lo) fill = below;
          else {
            // Taller than the ladder and fading out: no ceiling is drawn
            // because none was disclosed.
            fill = `url(#${fadeId})`;
            h = H + OPEN_OVERSHOOT;
          }
        } else if (span.kind === "exact") {
          if (i < span.lo) fill = below;
        }
        // Open rungs are square-topped: a rounded cap would read as an end.
        const rx = span.kind === "open" && i >= span.lo ? 0 : 1;
        return <rect key={i} x={x} y={H - h} width={RUNG_W} height={h} rx={rx} fill={fill} />;
      })}
      {span.kind === "exact" ? (
        <circle
          cx={Math.max(span.lo, 0) * (RUNG_W + RUNG_GAP) + RUNG_W / 2}
          cy={span.lo < 0 ? H - 2.5 : H - rungHeight(span.lo) + 2.5}
          r={2.5}
          fill={on}
          stroke="var(--card-solid)"
          strokeWidth={1}
        />
      ) : null}
    </svg>
  );
}

function bracketTitle(
  min: number | null,
  max: number | null,
  exact: number | null,
  transcribed: boolean
): string {
  const span = bracketSpan(min, max, exact);
  let t: string;
  if (span.kind === "exact") {
    t = `Exact amount printed on the filing: ${range(min, max, exact)}`;
    if (span.lo < 0) t += " (below the lowest STOCK Act bracket)";
  } else if (span.kind === "open") {
    t = `Open-ended bracket: over ${range(min, null)} — no upper bound is disclosed`;
  } else if (span.kind === "range") {
    t =
      span.lo === span.hi
        ? `Disclosed bracket ${span.lo + 1} of ${N}: ${range(min, max)}`
        : `Disclosed range ${range(min, max)} (brackets ${span.lo + 1}–${span.hi + 1} of ${N})`;
  } else {
    t = "No amount was read from the filing";
  }
  if (transcribed) t += ". Read off a scanned paper filing; excluded from every total.";
  return t;
}

/**
 * Glyph + disclosed range text. The text is the record; the glyph is the
 * scanning aid. An exact figure is labelled "exact" so it never reads as an
 * estimate or a bracket.
 */
export function BracketAmount({
  min,
  max,
  exact,
  transcribed,
  className,
}: {
  min: number | null;
  max: number | null;
  exact: number | null;
  transcribed?: number | boolean | null;
  className?: string;
}) {
  const scan = !!transcribed;
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-2 whitespace-nowrap", className)}
      title={bracketTitle(min, max, exact, scan)}
    >
      <BracketGlyph min={min} max={max} exact={exact} transcribed={scan} />
      <span className={cn("tabular text-[13px]", scan && "text-amber-800 dark:text-amber-200")}>
        {range(min, max, exact)}
      </span>
      {exact != null ? (
        <span className="rounded-[4px] border border-border px-1 text-[10px] font-medium uppercase leading-4 tracking-wide text-muted-foreground">
          exact
        </span>
      ) : null}
    </span>
  );
}

/**
 * A key for the ladder: the empty ten rungs labelled at both ends, for the
 * list header. Says once what every glyph below means.
 */
export function BracketLegend({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-[12px] text-muted-foreground", className)}
      title={`STOCK Act value brackets, lowest to highest: ${BRACKETS.map((b) => b.label).join(", ")}`}
    >
      <span className="tabular">$1k</span>
      <svg width={GLYPH_WIDTH} height={H} viewBox={`0 0 ${GLYPH_WIDTH} ${H}`} aria-hidden className="shrink-0">
        {BRACKETS.map((_, i) => {
          const h = rungHeight(i);
          return (
            <rect
              key={i}
              x={i * (RUNG_W + RUNG_GAP)}
              y={H - h}
              width={RUNG_W}
              height={h}
              rx={1}
              fill="var(--viz-rung-below)"
            />
          );
        })}
      </svg>
      <span className="tabular">$50M+</span>
      <span className="sr-only">
        Each trade&apos;s bracket is drawn on a ladder of the ten STOCK Act brackets.
      </span>
    </span>
  );
}
