import { GroupedListSkeleton, SectionTitleSkeleton, SkeletonPage } from "./skeletons";

/**
 * The landing page's placeholder, and the fallback for any route without one
 * of its own: a heading, then two side-by-side lists.
 */
export default function Loading() {
  return (
    <SkeletonPage label="the page" head>
      <section className="grid gap-8 lg:grid-cols-2 lg:gap-5">
        <div>
          <SectionTitleSkeleton width="w-36" right />
          <GroupedListSkeleton rows={5} />
        </div>
        <div>
          <SectionTitleSkeleton width="w-36" right />
          <GroupedListSkeleton rows={5} />
        </div>
      </section>
    </SkeletonPage>
  );
}
