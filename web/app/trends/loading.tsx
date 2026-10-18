import {
  BarsSkeleton,
  ColumnsSkeleton,
  PillsSkeleton,
  SectionTitleSkeleton,
  SkeletonPage,
  TilesSkeleton,
} from "../skeletons";

/** Trends: window pills, four tiles, two monthly charts, then rising tickers beside insiders. */
export default function Loading() {
  return (
    <SkeletonPage label="trends">
      <PillsSkeleton count={3} />
      <TilesSkeleton cols="lg:grid-cols-4" />
      <section>
        <SectionTitleSkeleton width="w-48" right />
        <ColumnsSkeleton />
      </section>
      <section>
        <SectionTitleSkeleton width="w-32" right />
        <ColumnsSkeleton />
      </section>
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitleSkeleton width="w-28" right />
          <BarsSkeleton rows={8} />
        </div>
        <div>
          <SectionTitleSkeleton width="w-32" right />
          <ColumnsSkeleton />
        </div>
      </section>
    </SkeletonPage>
  );
}
