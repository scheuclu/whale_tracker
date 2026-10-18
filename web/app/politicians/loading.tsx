import { BarsSkeleton, SectionTitleSkeleton, SkeletonPage, TableSkeleton, TilesSkeleton } from "../skeletons";

/** Members: four tiles, volume and trade-count leaderboards, the table. */
export default function Loading() {
  return (
    <SkeletonPage label="members">
      <TilesSkeleton />
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitleSkeleton width="w-36" />
          <BarsSkeleton rows={10} />
        </div>
        <div>
          <SectionTitleSkeleton width="w-36" />
          <BarsSkeleton rows={10} />
        </div>
      </section>
      <section>
        <SectionTitleSkeleton width="w-24" right />
        <TableSkeleton rows={8} cols={8} />
      </section>
    </SkeletonPage>
  );
}
