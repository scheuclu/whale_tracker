import { Bone, PillsSkeleton, SectionTitleSkeleton, SkeletonPage, TilesSkeleton } from "../skeletons";

/** Alerts: intro, six tiles, then the alert log cards. */
export default function Loading() {
  return (
    <SkeletonPage label="alerts">
      <div className="max-w-3xl space-y-2">
        <Bone className="h-3 w-full" />
        <Bone className="h-3 w-11/12" />
        <Bone className="h-3 w-2/3" />
      </div>
      <TilesSkeleton count={6} cols="sm:grid-cols-3 lg:grid-cols-6" />
      <section>
        <SectionTitleSkeleton width="w-20" right />
        <PillsSkeleton count={5} note={false} />
        <div className="mt-3 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="glass space-y-3 rounded-2xl border border-border bg-card px-5 py-4">
              <div className="flex items-center gap-2">
                <Bone className="h-5 w-24 rounded-full" />
                <Bone className="h-5 w-12 rounded-full" />
                <Bone className="h-5 w-12 rounded-md" />
                <Bone className="h-3.5 w-16" />
                <div className="flex-1" />
                <Bone className="h-3 w-12" />
              </div>
              <Bone className="h-3 w-48" />
              <Bone className="h-2.5 w-64 max-w-full" />
            </div>
          ))}
        </div>
      </section>
    </SkeletonPage>
  );
}
