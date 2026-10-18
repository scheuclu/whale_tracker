import {
  BarsSkeleton,
  PillsSkeleton,
  SectionTitleSkeleton,
  SkeletonPage,
  SplitSkeleton,
  TableSkeleton,
} from "../skeletons";

/** Tickers: window pills, volume and members charts side by side, the table. */
export default function Loading() {
  return (
    <SkeletonPage label="tickers">
      <PillsSkeleton />
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitleSkeleton width="w-40" />
          <BarsSkeleton rows={10} />
        </div>
        <div>
          <SectionTitleSkeleton width="w-40" />
          <SplitSkeleton rows={10} />
        </div>
      </section>
      <section>
        <SectionTitleSkeleton width="w-24" />
        <TableSkeleton rows={8} cols={7} />
      </section>
    </SkeletonPage>
  );
}
