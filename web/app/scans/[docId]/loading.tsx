import {
  Bone,
  HeadingSkeleton,
  PillsSkeleton,
  SectionTitleSkeleton,
  SkeletonPage,
  TableSkeleton,
  TilesSkeleton,
} from "../../skeletons";

/** One scan: heading, four tiles, page picker, then the page image beside its rows. */
export default function Loading() {
  return (
    <SkeletonPage label="the scan">
      <HeadingSkeleton />
      <TilesSkeleton />
      <PillsSkeleton count={8} note={false} />
      <section>
        <SectionTitleSkeleton width="w-36" right />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
          <div className="tile p-2">
            <Bone className="aspect-[1210/933] w-full rounded-xl" />
          </div>
          <TableSkeleton rows={6} cols={5} />
        </div>
      </section>
    </SkeletonPage>
  );
}
