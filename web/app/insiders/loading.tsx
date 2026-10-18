import {
  BarsSkeleton,
  PillsSkeleton,
  SectionTitleSkeleton,
  SkeletonPage,
  SplitSkeleton,
  TilesSkeleton,
} from "../skeletons";

/** Insiders: six tiles, the convergence chart, window pills, bought/sold bars. */
export default function Loading() {
  return (
    <SkeletonPage label="insiders">
      <TilesSkeleton count={6} cols="sm:grid-cols-3 lg:grid-cols-6" />
      <section>
        <SectionTitleSkeleton width="w-36" right />
        <SplitSkeleton rows={8} />
      </section>
      <PillsSkeleton />
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitleSkeleton width="w-24" />
          <BarsSkeleton rows={8} />
        </div>
        <div>
          <SectionTitleSkeleton width="w-24" />
          <BarsSkeleton rows={8} />
        </div>
      </section>
    </SkeletonPage>
  );
}
