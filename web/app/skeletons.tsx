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
export function SkeletonPage({
  label,
  head = false,
  children,
}: {
  label: string;
  /** Lead with a `PageHeader` (kicker, serif headline, dek), as the index pages do. */
  head?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="min-h-[calc(100svh-8rem)] space-y-8">
      <span className="sr-only">Loading {label}…</span>
      {head ? <PageHeadSkeleton /> : null}
      {children}
    </div>
  );
}

/** `PageHeader` (page-header.tsx): the kicker, the 46px serif headline, a two-line dek. */
export function PageHeadSkeleton() {
  return (
    <div>
      <Line h="h-4" bone="h-2.5 w-28" className="mb-2" />
      <Bone className="h-9 w-64 max-w-full sm:h-12 sm:w-80" />
      <div className="mt-2.5 max-w-[60ch] space-y-1">
        <Line h="h-[25px] sm:h-[27px]" bone="h-3.5 w-full" />
        <Line h="h-[25px] sm:h-[27px]" bone="h-3.5 w-2/3" />
      </div>
    </div>
  );
}

/** One `StatTile` (charts.tsx): label, figure, hint line. */
export function TileSkeleton({
  tall = false,
  trend = false,
  wrap = true,
}: {
  tall?: boolean;
  trend?: boolean;
  /** On a phone the tile is half the screen wide and its hint wraps to two lines. */
  wrap?: boolean;
}) {
  return (
    <div className="flex h-full flex-col rounded-tile bg-card p-4 shadow-card sm:px-5 sm:pb-5 sm:pt-4">
      <Line h="h-5" bone="h-3 w-16" />
      <div className="mt-1.5 flex items-end justify-between gap-3">
        <Bone className="h-7 w-16 sm:h-[34px] sm:w-24" />
        {trend ? <Bone className="hidden h-6 w-20 rounded-sm sm:block" /> : null}
      </div>
      <Line h="h-[16.5px]" bone="h-2.5 w-28 max-w-full" className="mt-2" />
      {wrap ? <Line h="h-[16.5px]" bone="h-2.5 w-16" className="sm:hidden" /> : null}
      {tall ? <Line h="h-[16.5px]" bone="h-2.5 w-20" className="mt-1" /> : null}
    </div>
  );
}

/** A row of `StatTile`s. `cols` mirrors the page's own grid classes. */
export function TilesSkeleton({
  count = 4,
  cols = "sm:grid-cols-4",
  tall = false,
  trend = false,
  wrap = true,
}: {
  count?: number;
  cols?: string;
  /** One tile carries a second hint line (a change, a wrapped hint); the row stretches to it. */
  tall?: boolean;
  /** The first and last tiles carry a sparkline (the feed). */
  trend?: boolean;
  /** Hints wrap to a second line on a phone (off for tiles with short or no hints). */
  wrap?: boolean;
}) {
  return (
    <section className={cn("grid grid-cols-2 gap-3 sm:gap-4", cols)}>
      {Array.from({ length: count }, (_, i) => (
        <TileSkeleton key={i} tall={tall && i === 0} trend={trend && (i === 0 || i === count - 1)} wrap={wrap} />
      ))}
    </section>
  );
}

/** `SectionTitle` (charts.tsx): the bold heading on the canvas, its meta on the right. */
export function SectionTitleSkeleton({ width = "w-32", right = false }: { width?: string; right?: boolean }) {
  return (
    <div className="mb-3 sm:mb-4">
      <div className="flex min-h-7 items-center justify-between gap-x-4">
        <Bone className={cn("h-4", width)} />
        {right ? <Bone className="h-2.5 w-24" /> : null}
      </div>
    </div>
  );
}

/** A `MagnitudeBars` card (charts.tsx): rank, symbol over name, an 8px bar on its track, the value. */
export function BarsSkeleton({ rows = 8, names = false }: { rows?: number; names?: boolean }) {
  return (
    <Card>
      <ol className="space-y-0.5">
        {Array.from({ length: rows }, (_, i) => (
          <li
            key={i}
            className={cn(
              "grid items-center gap-x-2.5 px-1.5 py-1 sm:gap-x-3",
              names
                ? "grid-cols-[1rem_8rem_minmax(0,1fr)_4rem] sm:grid-cols-[1.25rem_11rem_minmax(0,1fr)_5rem]"
                : "grid-cols-[1rem_6.5rem_minmax(0,1fr)_4rem] sm:grid-cols-[1.25rem_7.5rem_minmax(0,1fr)_5rem]"
            )}
          >
            <div className="flex justify-end">
              <Bone className="h-2.5 w-2" />
            </div>
            <div className="min-w-0">
              <Line h="h-5" bone={cn("h-3", names ? "w-28" : LABEL_WIDTHS[i % LABEL_WIDTHS.length])} />
              <Line h="h-4" bone={cn("h-2 max-w-full", SUB_WIDTHS[i % SUB_WIDTHS.length])} />
            </div>
            <div className="h-2 overflow-hidden rounded-[2px] bg-[var(--viz-track)]">
              <Bone className="h-full rounded-[2px]" style={{ width: `${BAR_WIDTHS[i % BAR_WIDTHS.length]}%` }} />
            </div>
            <div className="flex justify-end">
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
    <div className="flex h-4 items-center gap-4">
      <Bone className="h-2 w-14" />
      <Bone className="h-2 w-12" />
      <div className="flex-1" />
      {note ? <Bone className="hidden h-2 w-36 sm:block" /> : null}
    </div>
  );
}

/**
 * A `DivergingSplit` card (charts.tsx): legend, direction captions, 10px
 * bars either side of a hairline axis. Same container queries as the chart:
 * a narrow card stacks symbol over name, a wide one sets them on one line.
 */
export function SplitSkeleton({ rows = 6 }: { rows?: number }) {
  const rowCols =
    "grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 @md:grid-cols-[13rem_minmax(0,1fr)] @3xl:grid-cols-[17rem_minmax(0,1fr)]";
  return (
    <Card>
      <div className="@container">
        <LegendSkeleton />
        <div className="relative mt-3">
          <div className={cn(rowCols, "h-[22px] px-1.5 pb-0.5")} />
          <ol className="space-y-px">
            {Array.from({ length: rows }, (_, i) => {
              const left = [42, 30, 30, 18, 18, 30, 12, 24, 18, 12][i % 10];
              const right = [70, 56, 38, 46, 30, 30, 22, 16, 24, 14][i % 10];
              return (
                <li key={i} className={cn(rowCols, "items-center px-1.5 py-1")}>
                  <div className="flex min-w-0 flex-col @md:flex-row @md:items-center @md:gap-2">
                    <Line h="h-5" bone={cn("h-3", LABEL_WIDTHS[i % LABEL_WIDTHS.length])} className="@md:w-[3.75rem] @md:shrink-0" />
                    <Line h="h-4 @md:h-5" bone={cn("h-2 max-w-full", SUB_WIDTHS[i % SUB_WIDTHS.length])} className="min-w-0" />
                  </div>
                  <div className="flex h-6 items-center px-7">
                    <div className="flex flex-1 justify-end pr-0.5">
                      <Bone className="h-2.5 rounded-[2px]" style={{ width: `${left}%` }} />
                    </div>
                    <span className="h-6 w-px bg-[var(--viz-axis)] opacity-30" />
                    <div className="flex flex-1 pl-0.5">
                      <Bone className="h-2.5 rounded-[2px]" style={{ width: `${right}%` }} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
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
    <div>
      <div className="flex h-[55px] items-center gap-3">
        <Bone className="h-7 w-44 rounded-lg" />
        <Bone className="hidden h-7 w-16 rounded-full sm:block" />
        <Bone className="hidden h-2.5 w-96 max-w-[40%] md:block" />
        <div className="flex-1" />
        <Bone className="hidden h-3 w-28 md:block" />
      </div>
      {Array.from({ length: days }, (_, d) => (
        <div key={d}>
          <div className="flex h-12 items-end gap-3 px-1 pb-2.5">
            <Bone className="h-3 w-24" />
            <Bone className="h-2.5 w-10" />
            <div className="flex-1" />
            <Bone className="h-2.5 w-24" />
          </div>
          <div className="tile inset-rows mb-2 [--sep-inset:3.25rem]">
          {Array.from({ length: d % 2 ? 2 : 1 }, (_, b) => (
            <div key={b} className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
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
        </div>
      ))}
    </div>
  );
}

/** The feed's filter card (`FeedFilters`, feed-controls.tsx): labelled selects and Apply. */
export function FiltersSkeleton({ fields = 7 }: { fields?: number }) {
  const widths = ["w-20", "w-28", "w-36", "w-28", "w-32", "w-32", "w-40"];
  return (
    <Card variant="panel" className="mb-5 px-4 py-3">
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
    <div className="tile inset-rows py-1">
      {Array.from({ length: rows }, (_, i) => (
        <Card key={i} variant="open" className="px-3 py-2.5 sm:px-4">
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

/**
 * A monthly column chart card (Trends, `MonthlyColumns`): legend, bought
 * columns rising from a centre baseline and sold columns falling from it,
 * month labels, the two-line caption and the "Show as table" toggle.
 */
export function ColumnsSkeleton({ months = 12 }: { months?: number }) {
  const up = [6, 40, 44, 60, 100, 52, 64, 54, 72, 40, 24, 6];
  const down = [8, 52, 32, 56, 46, 48, 62, 52, 70, 52, 34, 4];
  return (
    <Card>
      <LegendSkeleton />
      <div className="relative mt-3 h-[232px]">
        <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
        <div className="absolute inset-0 flex gap-3 px-2 sm:gap-6 sm:px-6">
          {Array.from({ length: months }, (_, i) => (
            <div key={i} className="flex min-w-0 flex-1 flex-col items-center">
              <div className="flex h-1/2 w-full max-w-9 items-end justify-center pb-px">
                <Bone className="w-full rounded-b-none rounded-t-[3px]" style={{ height: `${up[i % up.length]}%` }} />
              </div>
              <div className="flex h-1/2 w-full max-w-9 items-start justify-center pt-px">
                <Bone className="w-full rounded-b-[3px] rounded-t-none" style={{ height: `${down[i % down.length] * 0.6}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1 flex h-5 gap-3 px-2 sm:gap-6 sm:px-6">
        {Array.from({ length: months }, (_, i) => (
          <div key={i} className="flex min-w-0 flex-1 items-center justify-center">
            <Bone className="h-2 w-7 max-w-full" />
          </div>
        ))}
      </div>
      <div className="mt-3">
        <Line h="h-[17px]" bone="h-2.5 w-full" />
        <Line h="h-[17px]" bone="h-2.5 w-2/3" />
      </div>
      <Line h="h-5" bone="h-2.5 w-24" className="mt-3" />
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
      <div className="relative mt-2 h-[155px]">
        <span className="absolute inset-x-6 top-[64px] h-px bg-border" />
        {marks.map((x, i) => (
          <Bone
            key={i}
            className="absolute size-2.5 rounded-full"
            style={{ left: `${x}%`, top: i % 3 === 0 ? 74 : i % 2 ? 48 : 56 }}
          />
        ))}
        <div className="absolute inset-x-6 bottom-2 flex justify-between">
          {Array.from({ length: 9 }, (_, i) => (
            <Bone key={i} className="h-2 w-7" />
          ))}
        </div>
      </div>
      <div className="mt-2 px-1">
        <Line h="h-[18px]" bone="h-2.5 w-full max-w-3xl" />
        <Line h="h-[18px]" bone="h-2.5 w-full max-w-3xl" />
        <Line h="h-[18px]" bone="h-2.5 w-16" />
      </div>
    </Card>
  );
}

/** A `VolumeRange` card (charts.tsx): the midpoint label, the band on its track, ticks, three labels, the note. */
export function RangeSkeleton() {
  return (
    <Card>
      <div className="relative pb-6 pt-7">
        <div className="absolute left-1/2 top-0 flex h-5 -translate-x-1/2 items-center">
          <Bone className="h-3 w-24" />
        </div>
        <div className="relative h-3 overflow-hidden rounded-[3px] bg-[var(--viz-track)]">
          <Bone className="absolute inset-y-0 left-[22%] right-[2%] rounded-none" />
        </div>
        <div className="h-1.5" />
        <div className="absolute inset-x-0 bottom-0 flex h-5 items-center justify-between">
          <Bone className="h-2.5 w-6" />
          <Bone className="h-2.5 w-16" />
          <Bone className="h-2.5 w-20" />
        </div>
      </div>
      <Line h="h-[18px]" bone="h-2.5 w-2/3" className="mt-3" />
      {/* The note wraps on a phone. */}
      <Line h="h-[18px]" bone="h-2.5 w-1/2" className="sm:hidden" />
      <Line h="h-[18px]" bone="h-2.5 w-1/3" className="sm:hidden" />
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

/** `TickerMembers` (tickers/ticker-members.tsx): one card per member. */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-card border border-border bg-card px-3.5 py-3">
          <Bone className="size-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <Line h="h-5" bone={cn("h-3", ["w-32", "w-40", "w-28"][i % 3])} />
            <Line h="h-4" bone="h-2.5 w-36 max-w-full" />
            <Line h="h-4" bone="h-2.5 w-24" className="mt-1" />
          </div>
          <Bone className="h-3 w-16 shrink-0 self-start" />
        </div>
      ))}
    </div>
  );
}

/** A detail page's heading: back link, title and subtitle, and (tickers) the bought/sold balance. */
export function HeadingSkeleton({ split = false }: { split?: boolean }) {
  return (
    <div>
      <Line h="h-6" bone="h-2.5 w-20" />
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div className="min-w-0">
          <Bone className="h-9 w-36 sm:h-12 sm:w-44" />
          <Line h="h-7" bone="h-4 w-72 max-w-full" className="mt-2.5" />
        </div>
        {split ? (
          <div className="w-full sm:w-72">
            <div className="flex h-5 items-center justify-between">
              <Bone className="h-3 w-20" />
              <Bone className="h-3 w-16" />
            </div>
            <Bone className="mt-2 h-2 w-full rounded-full" />
            <div className="mt-2 flex h-4 items-center justify-between">
              <Bone className="h-2.5 w-20" />
              <Bone className="h-2.5 w-20" />
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
    <div>
      <Line h="h-6" bone="h-2.5 w-24" />
      <div className="flex h-[345px] flex-col gap-5 border-y border-border py-5 sm:h-[270px] sm:flex-row sm:items-start sm:py-6">
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
