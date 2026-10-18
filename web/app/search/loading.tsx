import { Bone, SectionTitleSkeleton, SkeletonPage } from "../skeletons";

/** Search: heading and box, then members / tickers / issuers result lists. */
export default function Loading() {
  return (
    <SkeletonPage label="search results">
      <div>
        <Bone className="h-7 w-28" />
        <div className="mt-3 flex max-w-xl items-center gap-2">
          <Bone className="h-10 flex-1 rounded-full" />
          <Bone className="h-10 w-20 rounded-full" />
        </div>
      </div>
      <Bone className="h-3 w-72 max-w-full" />
      {["w-20", "w-16", "w-28"].map((w, s) => (
        <section key={w}>
          <SectionTitleSkeleton width={w} right />
          <div className="glass divide-y divide-border/50 rounded-2xl border border-border bg-card">
            {Array.from({ length: s === 0 ? 4 : 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <Bone className="size-5 rounded" />
                <Bone className={["h-3.5 w-40", "h-3.5 w-32", "h-3.5 w-48", "h-3.5 w-36"][i % 4]} />
                <div className="flex-1" />
                <Bone className="h-3 w-16" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </SkeletonPage>
  );
}
