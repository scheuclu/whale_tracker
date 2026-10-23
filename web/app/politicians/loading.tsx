"use client";

import { useSearchParams } from "next/navigation";
import {
  BarsSkeleton,
  GlanceSkeleton,
  HeroSkeleton,
  TimelineSkeleton,
  RangeSkeleton,
  SectionTitleSkeleton,
  SkeletonPage,
  SplitSkeleton,
  TableSkeleton,
  TilesSkeleton,
  TradeRowsSkeleton,
} from "../skeletons";

/**
 * Members has two shapes on one route: the leaderboards, and one member
 * (`?m=`). A client component so the placeholder can follow the URL it is
 * loading.
 */
export default function Loading() {
  return useSearchParams().get("m") ? <MemberLoading /> : <MembersLoading />;
}

/** The leaderboards: four tiles, volume and trade-count bars, the table. */
function MembersLoading() {
  return (
    <SkeletonPage label="members" head>
      <TilesSkeleton />
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitleSkeleton width="w-36" />
          <BarsSkeleton rows={10} names />
        </div>
        <div>
          <SectionTitleSkeleton width="w-36" />
          <BarsSkeleton rows={10} names />
        </div>
      </section>
      <section>
        <SectionTitleSkeleton width="w-24" right />
        <TableSkeleton rows={8} cols={8} />
      </section>
    </SkeletonPage>
  );
}

/** One member: the contact-card hero, tiles and the glance tile, timeline, volume range, bars beside the buy/sell split, every trade. */
export function MemberLoading() {
  return (
    <SkeletonPage label="the member">
      <HeroSkeleton />
      <div className="space-y-3 sm:space-y-4">
        <TilesSkeleton />
        <GlanceSkeleton />
      </div>
      <section>
        <SectionTitleSkeleton width="w-36" right />
        <TimelineSkeleton />
      </section>
      <section>
        <SectionTitleSkeleton width="w-44" />
        <RangeSkeleton />
      </section>
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitleSkeleton width="w-40" />
          <BarsSkeleton rows={8} />
        </div>
        <div>
          <SectionTitleSkeleton width="w-36" />
          <SplitSkeleton rows={8} />
        </div>
      </section>
      <section>
        <SectionTitleSkeleton width="w-40" right />
        <TradeRowsSkeleton rows={6} />
      </section>
    </SkeletonPage>
  );
}
