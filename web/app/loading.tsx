import {
  FeedSkeleton,
  SectionTitleSkeleton,
  SkeletonPage,
  SplitSkeleton,
  TilesSkeleton,
} from "./skeletons";

/** Feed: four tiles, "where members agree", then the toolbar (Filter pill) and the day-grouped feed. */
export default function Loading() {
  return (
    <SkeletonPage label="the feed" head>
      <TilesSkeleton tall trend cols="lg:grid-cols-4" />
      <section>
        <SectionTitleSkeleton width="w-40" right />
        <SplitSkeleton rows={6} />
      </section>
      <section>
        <SectionTitleSkeleton width="w-28" right />
        <FeedSkeleton days={5} />
      </section>
    </SkeletonPage>
  );
}
