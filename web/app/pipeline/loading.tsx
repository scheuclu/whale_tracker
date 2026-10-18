import { Bone, ListSkeleton, SectionTitleSkeleton, SkeletonPage, TilesSkeleton } from "../skeletons";

/** Pipeline: four tiles, the coverage card, status and read-method lists. */
export default function Loading() {
  return (
    <SkeletonPage label="pipeline status">
      <TilesSkeleton />
      <section>
        <SectionTitleSkeleton width="w-20" />
        <div className="glass space-y-5 rounded-2xl border border-border bg-card p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Bone className="mt-1 size-2 rounded-full" />
              <div className="flex-1 space-y-2">
                <Bone className="h-3.5 w-44" />
                <Bone className="h-2.5 w-full max-w-2xl" />
                {i ? <Bone className="h-2.5 w-2/3 max-w-xl" /> : null}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitleSkeleton width="w-28" />
          <ListSkeleton rows={8} />
        </div>
        <div>
          <SectionTitleSkeleton width="w-36" />
          <ListSkeleton rows={7} />
        </div>
      </section>
    </SkeletonPage>
  );
}
