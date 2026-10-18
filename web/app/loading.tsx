import {
  FeedSkeleton,
  FiltersSkeleton,
  SectionTitleSkeleton,
  SkeletonPage,
  SplitSkeleton,
  TilesSkeleton,
} from "./skeletons";

/** Feed: four tiles, "where members agree", then the filters and the day-grouped feed. */
export default function Loading() {
  return (
    <SkeletonPage label="the feed">
      <TilesSkeleton tall trend />
      <section>
        <SectionTitleSkeleton width="w-40" right />
        <SplitSkeleton rows={6} />
      </section>
      <section>
        <SectionTitleSkeleton width="w-28" right />
        <FiltersSkeleton />
        <FeedSkeleton days={5} />
      </section>
    </SkeletonPage>
  );
}
