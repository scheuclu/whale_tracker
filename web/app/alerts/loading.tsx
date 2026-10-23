import { Bone, PillsSkeleton, SectionTitleSkeleton, SkeletonPage, TilesSkeleton } from "../skeletons";

/** Alerts: intro, six tiles, the price-move note, then the alert log cards. */
export default function Loading() {
  return (
    <SkeletonPage label="alerts" head>
      <div className="max-w-[68ch]">
        {["w-full", "w-full", "w-full", "w-2/3"].map((w, i) => (
          <span key={i} className="flex h-5 items-center">
            <Bone className={`h-3 ${w}`} />
          </span>
        ))}
      </div>
      <TilesSkeleton count={4} trend />
      <section>
        <SectionTitleSkeleton width="w-44" />
        <div className="max-w-[68ch]">
          {["w-full", "w-full", "w-full", "w-1/2"].map((w, i) => (
            <span key={i} className="flex h-[18px] items-center">
              <Bone className={`h-2.5 ${w}`} />
            </span>
          ))}
        </div>
        <div className="tile mt-3 inset-rows [--sep-inset:1rem]">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex h-11 items-center gap-6 px-4">
              <Bone className="h-3 w-24" />
              <Bone className="h-3 w-40 max-w-[30%]" />
              <Bone className="h-3 w-40 max-w-[30%]" />
            </div>
          ))}
        </div>
      </section>
      <section>
        <SectionTitleSkeleton width="w-20" right />
        <PillsSkeleton count={5} note={false} />
        <div className="tile mt-3 inset-rows py-1 [--sep-inset:1rem] sm:[--sep-inset:1.25rem]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-3 px-4 py-3.5 sm:px-5">
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
