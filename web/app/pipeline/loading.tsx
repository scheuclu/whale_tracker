import { Bone, ListSkeleton, SectionTitleSkeleton, SkeletonPage, TilesSkeleton } from "../skeletons";

/** Pipeline: four tiles, the coverage card, status and read-method lists. */
export default function Loading() {
  return (
    <SkeletonPage label="pipeline status" head>
      <TilesSkeleton wrap={false} />
      <section>
        <SectionTitleSkeleton width="w-20" />
        <div className="tile inset-rows py-1 [--sep-inset:1rem] sm:[--sep-inset:1.5rem]">
          {/* Three sources: a line of prose each, then the run's status lines. */}
          {[1, 2, 4].map((lines, i) => (
            <div key={i} className="flex gap-3 px-4 py-4 sm:px-6">
              <div className="flex-1">
                <span className="flex h-[22px] items-center">
                  <Bone className={["h-3.5 w-44", "h-3.5 w-32", "h-3.5 w-48"][i]} />
                </span>
                {Array.from({ length: lines }, (_, l) => (
                  <span key={l} className="flex h-5 items-center">
                    <Bone className={l === 0 ? "h-2.5 w-full max-w-3xl" : "h-2.5 w-56 max-w-full"} />
                  </span>
                ))}
                {/* The prose wraps further on a phone. */}
                {Array.from({ length: i ? 1 : 0 }, (_, l) => (
                  <span key={l} className="flex h-5 items-center sm:hidden">
                    <Bone className="h-2.5 w-3/4" />
                  </span>
                ))}
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
