import { cn } from "@/lib/utils";
import { Card } from "./charts";

/**
 * Loading skeletons for the route `loading.tsx` files. Every page is a
 * server render against the trade database, so a tab click used to sit on
 * the old page with no feedback; these stream instantly (Next prefetches a
 * route's loading state) and are built to the real page's measurements —
 * same card (`Card` itself), same tile and section-title boxes, same row
 * heights — so nothing jumps when the data arrives.
 *
 * Where a piece mirrors a component rather than reusing it, the comment
 * names the component: change one, change the other.
 *
 * Bones are neutral grey on purpose: blue and red mean buy and sell here, and
 * a placeholder must not look like either. The bone colour and shimmer live
 * in globals.css / motion.css (`.skeleton`) and stop under
 * `prefers-reduced-motion`.
 */

/** Deterministic widths so a skeleton looks like data, not a grid of equal bars. */
const BAR_WIDTHS = [100, 64, 52, 44, 38, 33, 29, 26, 23, 21, 19, 17];
const LABEL_WIDTHS = ["w-12", "w-10", "w-14", "w-9", "w-12", "w-11", "w-10", "w-14", "w-9", "w-12", "w-10", "w-11"];
const SUB_WIDTHS = ["w-28", "w-20", "w-24", "w-16", "w-24", "w-20", "w-28", "w-16"];

export function Bone({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={cn("skeleton block rounded-md", className)} style={{ ...style }} />;
}

/** A bone vertically centred in a line box of the real text's height. */
function Line({ h, bone, className }: { h: string; bone: string; className?: string }) {
  return (
    <span aria-hidden className={cn("flex items-center", h, className)}>
      <Bone className={bone} />
    </span>
  );
}

/**
 * The page frame: announces the load once, then lays out like the page
 * (`space-y-8`, as every page root). Tall enough that the footer stays
 * below the fold until the content arrives, so it never jumps down.
 */
export function SkeletonPage({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="min-h-[calc(100svh-8rem)] space-y-8">
      <span className="sr-only">Loading {label}…</span>
      {children}
    </div>
  );
}

/** One `StatTile` (charts.tsx): caps label, value, hint line. */
export function TileSkeleton({ tall = false, trend = false }: { tall?: boolean; trend?: boolean }) {
  return (
    <div className="glass flex h-full flex-col rounded-2xl border border-border bg-card px-4 py-3.5">
      <Line h="h-[17px]" bone="h-2.5 w-16" />
      <div className="mt-1.5 flex items-end justify-between gap-3">
        <Bone className="h-[22px] w-16 sm:h-[26px] sm:w-20" />
        {trend ? <Bone className="hidden h-6 w-20 rounded sm:block" /> : null}
      </div>
      <Line h="h-[17px]" bone="h-2.5 w-28 max-w-full" className="mt-2" />
      {tall ? <Line h="h-[17px]" bone="h-2.5 w-20" className="mt-1" /> : null}
    </div>
  );
}

/** A row of `StatTile`s. `cols` mirrors the page's own grid classes. */
export function TilesSkeleton({
  count = 4,
  cols = "sm:grid-cols-4",
  tall = false,
}: {
  count?: number;
  cols?: string;
  /** The feed's tiles carry a sparkline and a change line. */
  tall?: boolean;
}) {
  return (
    <section className={cn("grid grid-cols-2 gap-3", cols)}>
      {Array.from({ length: count }, (_, i) => (
        <TileSkeleton key={i} tall={tall && i === 0} trend={tall && (i === 0 || i === count - 1)} />
      ))}
    </section>
  );
}

/** `SectionTitle` (charts.tsx): the heading, the fading rule, the meta. */
export function SectionTitleSkeleton({ width = "w-32", right = false }: { width?: string; right?: boolean }) {
  return (
    <div className="mb-3 flex min-h-7 items-center gap-x-3">
      <Bone className={cn("h-3", width)} />
      <div className="rule-fade min-w-6 flex-1" />
      {right ? <Bone className="h-2.5 w-20" /> : null}
    </div>
  );
}

/** Two-line row label: symbol and company, as the bar charts print them. */
function RowLabel({ i, className }: { i: number; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <Line h="h-[19px]" bone={cn("h-3", LABEL_WIDTHS[i % LABEL_WIDTHS.length])} />
      <Line h="h-4" bone={cn("h-2 max-w-full", SUB_WIDTHS[i % SUB_WIDTHS.length])} />
    </div>
  );
}

/** A `MagnitudeBars` card: label pair, bar on its track, value. */
export function BarsSkeleton({ rows = 8, names = false }: { rows?: number; names?: boolean }) {
  return (
    <Card>
      <ol className="space-y-1.5">
        {Array.from({ length: rows }, (_, i) => (
          <li
            key={i}
            className={cn(
              "grid items-center gap-3 px-1 py-1",
              names ? "grid-cols-[8rem_1fr_auto] sm:grid-cols-[11rem_1fr_auto]" : "grid-cols-[5.5rem_1fr_auto] sm:grid-cols-[7rem_1fr_auto]"
            )}
          >
            <RowLabel i={i} />
            <div className="relative h-3 overflow-hidden rounded-sm bg-[var(--viz-track)]">
              <Bone className="h-full rounded-sm" style={{ width: `${BAR_WIDTHS[i % BAR_WIDTHS.length]}%` }} />
            </div>
            <div className="flex w-16 justify-end sm:w-20">
              <Bone className="h-3 w-12" />
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** The chart legend row (`Legend`): two keys and a right-aligned note. */
function LegendSkeleton({ note = true }: { note?: boolean }) {
  return (
    <div className="flex h-[17px] items-center gap-3">
      <Bone className="h-2 w-14" />
      <Bone className="h-2 w-12" />
      <div className="flex-1" />
      {note ? <Bone className="hidden h-2 w-36 sm:block" /> : null}
    </div>
  );
}

/** A `DivergingSplit` card: legend, direction captions, bars either side of a centre axis. */
export function SplitSkeleton({ rows = 6 }: { rows?: number }) {
  const rowCols = "grid grid-cols-[7.25rem_1fr] gap-3 sm:grid-cols-[10.5rem_1fr]";
  return (
    <Card>
      <LegendSkeleton />
      <div className="relative mt-3">
        <div className={cn(rowCols, "h-5 px-1 pb-1")} />
        <ol className="space-y-1">
          {Array.from({ length: rows }, (_, i) => {
            const left = [42, 30, 30, 18, 18, 30, 12, 24, 18, 12][i % 10];
            const right = [70, 56, 38, 46, 30, 30, 22, 16, 24, 14][i % 10];
            return (
              <li key={i} className={cn(rowCols, "items-center px-1 py-1")}>
                {/* Company names wrap to two lines in the real chart. */}
                <div className="min-w-0">
                  <Line h="h-[19px]" bone={cn("h-3", LABEL_WIDTHS[i % LABEL_WIDTHS.length])} />
                  <Line h="h-4" bone={cn("h-2 max-w-full", SUB_WIDTHS[i % SUB_WIDTHS.length])} />
                  {i % 2 === 0 ? <Line h="h-4" bone="h-2 w-10" /> : null}
                </div>
                <div className="flex h-5 items-center">
                  <div className="flex flex-1 justify-end pr-0.5">
                    <Bone className="h-3 rounded-sm" style={{ width: `${left}%` }} />
                  </div>
                  <span className="h-5 w-0.5 rounded-full bg-[var(--viz-axis)] opacity-30" />
                  <div className="flex flex-1 pl-0.5">
                    <Bone className="h-3 rounded-sm" style={{ width: `${right}%` }} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </Card>
  );
}

/** A `ResponsiveTable`: header row, then hairline-separated rows. */
export function TableSkeleton({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  const cells = (row: number) =>
    Array.from({ length: cols }, (_, c) => (
      <Bone
        key={c}
        className={cn(
          row < 0 ? "h-2.5" : "h-3",
          c === 0 ? "w-14 shrink-0" : c === 1 ? "hidden w-40 flex-[2] sm:block" : "ml-auto w-10 shrink-0",
          c > 3 && "hidden md:block"
        )}
      />
    ));
  return (
    <Card className="p-0 sm:p-0">
      <div className="flex h-10 items-center gap-6 border-b border-border px-4">{cells(-1)}</div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-11 items-center gap-6 border-b border-border/60 px-4 last:border-0">
          {cells(r)}
        </div>
      ))}
    </Card>
  );
}

/**
 * The feed (`FeedList`, feed-list.tsx): a toolbar row, then days — each a
 * header line over member blocks of trade rows.
 */
export function FeedSkeleton({ days = 4 }: { days?: number }) {
  return (
    <div className="glass overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex h-[55px] items-center gap-3 border-b border-border px-3 sm:px-4">
        <Bone className="h-7 w-44 rounded-lg" />
        <Bone className="hidden h-7 w-16 rounded-full sm:block" />
        <Bone className="hidden h-2.5 w-96 max-w-[40%] md:block" />
        <div className="flex-1" />
        <Bone className="hidden h-3 w-28 md:block" />
      </div>
      {Array.from({ length: days }, (_, d) => (
        <div key={d} className="border-b border-border last:border-0">
          <div className="flex h-[42px] items-center gap-3 border-b border-border px-3 sm:px-4">
            <Bone className="h-3 w-24" />
            <Bone className="h-2.5 w-10" />
            <div className="flex-1" />
            <Bone className="h-2.5 w-24" />
          </div>
          {Array.from({ length: d % 2 ? 2 : 1 }, (_, b) => (
            <div key={b} className="border-b border-border/60 last:border-0 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
              <div className="space-y-1.5 px-3 pt-2 sm:px-4 lg:py-2.5 lg:pr-2">
                <div className="flex items-center gap-1.5">
                  <Bone className="size-5 rounded" />
                  <Bone className={cn("h-3.5", ["w-36", "w-40", "w-32"][(d + b) % 3])} />
                </div>
                <Bone className="h-2.5 w-24" />
              </div>
              <div className="space-y-2 px-3 py-2.5 sm:px-4 lg:pl-0">
                {Array.from({ length: (d + b) % 3 === 2 ? 2 : 1 }, (_, r) => (
                  <div key={r} className="flex h-6 items-center gap-3">
                    <Bone className="h-5 w-12 rounded-full" />
                    <Bone className="h-5 w-12 rounded-md" />
                    <Bone className="h-3.5 w-24" />
                    <Bone className={cn("hidden h-3 sm:block", ["w-56", "w-44", "w-64"][(d + r) % 3])} />
                    <div className="flex-1" />
                    <Bone className="hidden h-3 w-8 sm:block" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The feed's filter card (`FeedFilters`, feed-controls.tsx): labelled selects and Apply. */
export function FiltersSkeleton({ fields = 7 }: { fields?: number }) {
  const widths = ["w-20", "w-28", "w-36", "w-28", "w-32", "w-32", "w-40"];
  return (
    <Card className="mb-4 px-4 py-3">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="space-y-1">
            <Line h="h-[16px]" bone="h-2 w-12" />
            <Bone className={cn("h-8 rounded-lg", widths[i % widths.length])} />
          </div>
        ))}
        <Bone className="h-8 w-16 rounded-full" />
      </div>
    </Card>
  );
}

/** One `Card` per trade (ticker and member pages): pill, chips, amount, member; date at the end. */
export function TradeRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: rows }, (_, i) => (
        <Card key={i} className="px-4 py-3">
          <div className="flex h-6 items-center gap-3">
            <Bone className="h-5 w-12 rounded-full" />
            <Bone className="h-3.5 w-24" />
            <Bone className="hidden h-5 w-20 rounded-md sm:block" />
            <Bone className="size-5 rounded-full" />
            <Bone className={cn("h-3.5", ["w-36", "w-28", "w-40", "w-32"][i % 4])} />
            <div className="flex-1" />
            <Bone className="h-3 w-14" />
            <Bone className="hidden h-3 w-8 sm:block" />
          </div>
        </Card>
      ))}
    </div>
  );
}

/** A monthly column chart card (Trends): legend, columns above and below a baseline. */
export function ColumnsSkeleton({ months = 12 }: { months?: number }) {
  const up = [38, 52, 44, 61, 70, 48, 57, 80, 66, 73, 58, 30];
  const down = [22, 30, 18, 34, 28, 40, 26, 36, 31, 24, 29, 12];
  return (
    <Card>
      <LegendSkeleton />
      {/* Columns standing on a baseline, in fixed pixels (160px tall). */}
      <div className="mt-4 flex h-40 items-end gap-1.5 border-b border-border sm:gap-3">
        {Array.from({ length: months }, (_, i) => (
          <Bone
            key={i}
            className="min-w-0 flex-1 rounded-b-none"
            style={{ height: Math.round(((up[i % up.length] + down[i % down.length]) / 120) * 160) }}
          />
        ))}
      </div>
      <div className="mt-2 flex gap-1.5 sm:gap-3">
        {Array.from({ length: months }, (_, i) => (
          <div key={i} className="flex min-w-0 flex-1 justify-center">
            {i % 3 === 0 ? <Bone className="h-2 w-6" /> : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * The trade timeline card (timeline.tsx): legend, a strip of marks either
 * side of the axis, month ticks, the caption.
 */
export function TimelineSkeleton() {
  const marks = [8, 22, 31, 47, 55, 58, 61, 64, 67, 70, 72, 74, 77, 80, 83, 86, 90];
  return (
    <Card>
      <LegendSkeleton />
      <div className="relative mt-2 h-[137px]">
        <span className="absolute inset-x-6 top-[60px] h-px bg-border" />
        {marks.map((x, i) => (
          <Bone
            key={i}
            className="absolute size-2.5 rounded-full"
            style={{ left: `${x}%`, top: i % 3 === 0 ? 70 : i % 2 ? 44 : 52 }}
          />
        ))}
        <div className="absolute inset-x-6 bottom-2 flex justify-between">
          {Array.from({ length: 9 }, (_, i) => (
            <Bone key={i} className="h-2 w-7" />
          ))}
        </div>
      </div>
      <div className="mt-2 space-y-1.5 px-1">
        <Bone className="h-2.5 w-full max-w-3xl" />
        <Bone className="h-2.5 w-1/3" />
      </div>
    </Card>
  );
}

/** A `VolumeRange` card: the band on its track, three labels under it, the note. */
export function RangeSkeleton() {
  return (
    <Card>
      <div className="relative pb-6 pt-6">
        <div className="relative h-3 rounded-full bg-[var(--viz-track)]">
          <Bone className="absolute inset-y-0 left-[22%] right-[2%] rounded-full" />
        </div>
        <div className="absolute inset-x-0 bottom-0 flex justify-between">
          <Bone className="h-2.5 w-6" />
          <Bone className="h-2.5 w-16" />
          <Bone className="h-2.5 w-20" />
        </div>
      </div>
      <Bone className="mt-4 h-2.5 w-2/3" />
    </Card>
  );
}

/** A row of window / filter pills. */
export function PillsSkeleton({ count = 4, note = true }: { count?: number; note?: boolean }) {
  return (
    <div className="flex h-[27px] items-center gap-1">
      {Array.from({ length: count }, (_, i) => (
        <Bone key={i} className="h-[27px] w-10 rounded-full" />
      ))}
      {note ? <Bone className="ml-2 h-2.5 w-36" /> : null}
    </div>
  );
}

/** A card of short text lines (coverage notes, status lists). */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <Card className={cn("space-y-3.5", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Bone className="h-5 w-16 rounded-full" />
          <Bone className={cn("h-3", ["w-24", "w-16", "w-28", "w-20", "w-24"][i % 5])} />
          <div className="flex-1" />
          <Bone className="h-3 w-8" />
        </div>
      ))}
    </Card>
  );
}

/** A grid of small cards (the members trading one ticker). */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="flex h-[83px] items-center gap-3 px-4 py-3 sm:px-4 sm:py-3">
          <Bone className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Bone className={cn("h-3.5", ["w-32", "w-40", "w-28"][i % 3])} />
            <Bone className="h-2.5 w-24" />
          </div>
          <Bone className="h-3 w-10" />
        </Card>
      ))}
    </div>
  );
}

/** A page heading block: back link, title, meta line (detail views). */
export function HeadingSkeleton({ split = false }: { split?: boolean }) {
  return (
    <div>
      <Line h="h-[26px]" bone="h-2.5 w-20" className="pt-[5px]" />
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-3">
          <Bone className="h-10 w-40 sm:h-12" />
          <Bone className="h-3.5 w-72 max-w-full" />
        </div>
        {/* The bought/sold balance bar beside a ticker's name. */}
        {split ? (
          <div className="w-full space-y-2 sm:w-72">
            <div className="flex justify-between">
              <Bone className="h-3 w-16" />
              <Bone className="h-3 w-12" />
            </div>
            <Bone className="h-2 w-full rounded-full" />
            <div className="flex justify-between">
              <Bone className="h-2.5 w-16" />
              <Bone className="h-2.5 w-16" />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The member page's header card: portrait, name, office, committee chips. */
export function ProfileSkeleton() {
  return (
    <div className="space-y-3">
      <Line h="h-[16px]" bone="h-2.5 w-24" className="mt-[5px]" />
      <div className="glass flex h-[270px] flex-col gap-5 rounded-3xl border border-border bg-card p-5 sm:flex-row sm:items-start sm:p-6">
        <Bone className="size-20 shrink-0 rounded-full sm:size-24" />
        <div className="min-w-0 flex-1 space-y-3">
          <Bone className="h-8 w-64 max-w-full" />
          <Bone className="h-3.5 w-56 max-w-full" />
          <div className="flex flex-wrap gap-1.5 pt-2">
            {["w-28", "w-36", "w-24", "w-32", "w-20"].map((w) => (
              <Bone key={w} className={cn("h-6 rounded-full", w)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
