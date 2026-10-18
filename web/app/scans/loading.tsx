import { SectionTitleSkeleton, SkeletonPage, TableSkeleton, TilesSkeleton } from "../skeletons";

/** Scans: four tiles, then the scanned-filings table. */
export default function Loading() {
  return (
    <SkeletonPage label="scanned filings">
      <TilesSkeleton />
      <section>
        <SectionTitleSkeleton width="w-32" right />
        <TableSkeleton rows={10} cols={9} />
      </section>
    </SkeletonPage>
  );
}
