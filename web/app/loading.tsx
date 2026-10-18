import { SectionTitleSkeleton, SkeletonPage, SplitSkeleton, TilesSkeleton, TradeRowsSkeleton } from "./skeletons";

/** Feed: four tiles, "where members agree", then trade cards. */
export default function Loading() {
  return (
    <SkeletonPage label="the feed">
      <TilesSkeleton />
      <section>
        <SectionTitleSkeleton width="w-40" right />
        <SplitSkeleton rows={6} />
      </section>
      <section>
        <SectionTitleSkeleton width="w-28" right />
        <TradeRowsSkeleton rows={5} />
      </section>
    </SkeletonPage>
  );
}
