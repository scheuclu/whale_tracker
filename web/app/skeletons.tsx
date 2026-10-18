import { cn } from "@/lib/utils";

/**
 * Loading skeletons for the route `loading.tsx` files. Every page is a
 * server render against the trade database, so a tab click used to sit on
 * the old page with no feedback; these stream instantly (Next prefetches a
 * route's loading state) and are built from the same surfaces as the real
 * page — glass cards, stat tiles, bar lists, table rows — so the layout does
 * not jump when the data arrives.
 *
 * Bones are neutral grey on purpose: blue and red mean buy and sell here, and
 * a placeholder must not look like either. The shimmer lives in globals.css
 * (`.skeleton`) and stops under `prefers-reduced-motion`.
 */

/** Deterministic widths so a skeleton looks like data, not a grid of equal bars. */
const BAR_WIDTHS = [100, 64, 52, 44, 38, 33, 29, 26, 23, 21, 19, 17];
const LABEL_WIDTHS = ["w-12", "w-10", "w-14", "w-9", "w-12", "w-11", "w-10", "w-14", "w-9", "w-12", "w-10", "w-11"];

export function Bone({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={cn("skeleton block rounded-md", className)} style={style} />;
}

/** The page frame: announces the load once, then lays out like the page. */
export function SkeletonPage({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-8">
      <span className="sr-only">Loading {label}…</span>
      {children}
    </div>
  );
}

function Surface({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <div className={cn("glass rounded-2xl border border-border bg-card p-5", className)}>{children}</div>;
}

/** A row of `StatTile`s. `cols` mirrors the page's own grid classes. */
export function TilesSkeleton({ count = 4, cols = "sm:grid-cols-4" }: { count?: number; cols?: string }) {
  return (
    <section className={cn("grid grid-cols-2 gap-3", cols)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="glass rounded-2xl border border-border bg-card px-4 py-3.5">
          <Bone className="h-2.5 w-16" />
          <Bone className="mt-2.5 h-6 w-14 sm:h-7" />
          <Bone className="mt-2 h-2.5 w-24 max-w-full" />
        </div>
      ))}
    </section>
  );
}

/** `SectionTitle`: a short caps label and the fading rule. */
export function SectionTitleSkeleton({ width = "w-32", right = false }: { width?: string; right?: boolean }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <Bone className={cn("h-2.5", width)} />
      <div className="rule-fade flex-1" />
      {right ? <Bone className="h-2.5 w-16" /> : null}
    </div>
  );
}

/** A `MagnitudeBars` card: label pair, bar on a track, value. */
export function BarsSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <Surface>
      <div className="space-y-4">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4">
            <div className="w-24 shrink-0 space-y-1.5 sm:w-28">
              <Bone className={cn("h-3", LABEL_WIDTHS[i % LABEL_WIDTHS.length])} />
              <Bone className="h-2 w-20" />
            </div>
            <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--viz-track)]">
              <Bone className="h-full rounded-full" style={{ width: `${BAR_WIDTHS[i % BAR_WIDTHS.length]}%` }} />
            </div>
            <Bone className="h-3 w-10 shrink-0" />
          </div>
        ))}
      </div>
    </Surface>
  );
}

/** A `DivergingSplit` card: bars either side of a centre axis. */
export function SplitSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Surface>
      <div className="mb-4 flex items-center gap-3">
        <Bone className="h-2.5 w-14" />
        <Bone className="h-2.5 w-12" />
        <div className="flex-1" />
        <Bone className="hidden h-2.5 w-28 sm:block" />
      </div>
      <div className="space-y-4">
        {Array.from({ length: rows }, (_, i) => {
          const left = [42, 30, 30, 18, 18, 30, 12, 24][i % 8];
          const right = [70, 56, 38, 46, 30, 30, 22, 16][i % 8];
          return (
            <div key={i} className="flex items-center gap-4">
              <div className="w-24 shrink-0 space-y-1.5 sm:w-28">
                <Bone className={cn("h-3", LABEL_WIDTHS[i % LABEL_WIDTHS.length])} />
                <Bone className="h-2 w-16" />
              </div>
              <div className="flex flex-1 items-center">
                <div className="flex flex-1 justify-end pr-px">
                  <Bone className="h-2.5 rounded-full" style={{ width: `${left}%` }} />
                </div>
                <span className="h-5 w-px bg-border" />
                <div className="flex flex-1 pl-px">
                  <Bone className="h-2.5 rounded-full" style={{ width: `${right}%` }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Surface>
  );
}

/** A `ResponsiveTable`: header row, then hairline-separated rows. */
export function TableSkeleton({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  const cells = (row: number) =>
    Array.from({ length: cols }, (_, c) => (
      <Bone
        key={c}
        className={cn(
          "h-3",
          c === 0 ? "w-14" : c === 1 ? "hidden w-40 flex-[2] sm:block" : "ml-auto w-10",
          c > 3 && "hidden md:block",
          row < 0 && "h-2.5"
        )}
      />
    ));
  return (
    <div className="glass overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-6 border-b border-border px-4 py-3.5">{cells(-1)}</div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-6 border-b border-border/60 px-4 py-3.5 last:border-0">
          {cells(r)}
        </div>
      ))}
    </div>
  );
}

/** The feed's trade cards: direction pill, ticker, bracket, date; member line. */
export function TradeRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="glass rounded-2xl border border-border bg-card px-4 py-3">
          <div className="flex items-center gap-3">
            <Bone className="h-5 w-12 rounded-full" />
            <Bone className="h-5 w-14 rounded-md" />
            <Bone className="h-3.5 w-20" />
            <div className="flex-1" />
            <Bone className="h-3 w-14" />
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <Bone className="size-4 rounded" />
            <Bone className={cn("h-3", ["w-36", "w-28", "w-40", "w-32"][i % 4])} />
            <Bone className={cn("hidden h-3 sm:block", ["w-48", "w-56", "w-40", "w-52"][i % 4])} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A monthly column chart card (Trends): legend, columns above and below a baseline. */
export function ColumnsSkeleton({ months = 12 }: { months?: number }) {
  const up = [38, 52, 44, 61, 70, 48, 57, 80, 66, 73, 58, 30];
  const down = [22, 30, 18, 34, 28, 40, 26, 36, 31, 24, 29, 12];
  return (
    <Surface>
      <div className="mb-4 flex items-center gap-3">
        <Bone className="h-2.5 w-14" />
        <Bone className="h-2.5 w-12" />
        <Bone className="hidden h-2.5 w-20 sm:block" />
      </div>
      {/* Columns standing on a baseline, in fixed pixels (160px tall). */}
      <div className="flex h-40 items-end gap-1.5 border-b border-border sm:gap-3">
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
    </Surface>
  );
}

/** A row of window / filter pills. */
export function PillsSkeleton({ count = 4, note = true }: { count?: number; note?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: count }, (_, i) => (
        <Bone key={i} className="h-7 w-11 rounded-full" />
      ))}
      {note ? <Bone className="ml-2 h-2.5 w-36" /> : null}
    </div>
  );
}

/** A card of short text lines (coverage notes, status lists). */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <Surface className={cn("space-y-3.5", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Bone className="h-5 w-16 rounded-full" />
          <Bone className={cn("h-3", ["w-24", "w-16", "w-28", "w-20", "w-24"][i % 5])} />
          <div className="flex-1" />
          <Bone className="h-3 w-8" />
        </div>
      ))}
    </Surface>
  );
}

/** A page heading block: back link, title, meta line (detail views). */
export function HeadingSkeleton() {
  return (
    <div className="space-y-3">
      <Bone className="h-2.5 w-20" />
      <Bone className="h-8 w-48" />
      <Bone className="h-3 w-72 max-w-full" />
    </div>
  );
}
