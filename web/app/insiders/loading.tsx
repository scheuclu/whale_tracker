"use client";

import { useSearchParams } from "next/navigation";
import {
  BarsSkeleton,
  Bone,
  GlanceSkeleton,
  HeroSkeleton,
  ListSkeleton,
  TimelineSkeleton,
  PillsSkeleton,
  SectionTitleSkeleton,
  SkeletonPage,
  SplitSkeleton,
  TilesSkeleton,
  TradeRowsSkeleton,
} from "../skeletons";

/**
 * Insiders has two shapes on one route: the overview, and one issuer
 * (`?t=`). A client component so the placeholder can follow the URL it is
 * loading.
 */
export default function Loading() {
  return useSearchParams().get("t") ? <IssuerLoading /> : <InsidersLoading />;
}

/** Overview: six tiles, the convergence chart, window pills, bought/sold bars. */
function InsidersLoading() {
  return (
    <SkeletonPage label="insiders" head>
      <TilesSkeleton count={6} cols="sm:grid-cols-3" wrap={false} />
      <section>
        <SectionTitleSkeleton width="w-36" right />
        <SplitSkeleton rows={8} />
      </section>
      <PillsSkeleton />
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitleSkeleton width="w-24" />
          <BarsSkeleton rows={8} names />
        </div>
        <div>
          <SectionTitleSkeleton width="w-24" />
          <BarsSkeleton rows={8} names />
        </div>
      </section>
    </SkeletonPage>
  );
}

/** One issuer: the symbol hero, tiles and the glance tile, the price chart, who traded, then every trade. */
function IssuerLoading() {
  return (
    <SkeletonPage label="the issuer">
      <HeroSkeleton square />
      <div className="space-y-3 sm:space-y-4">
        <TilesSkeleton />
        <GlanceSkeleton />
      </div>
      <section>
        <SectionTitleSkeleton width="w-56" right />
        <TimelineSkeleton />
      </section>
      <section>
        <SectionTitleSkeleton width="w-28" right />
        <ListSkeleton rows={5} />
      </section>
      <section>
        <SectionTitleSkeleton width="w-36" />
        <div className="mb-3 space-y-1.5 pl-1">
          <Bone className="h-2.5 w-full max-w-3xl" />
          <Bone className="h-2.5 w-1/2" />
        </div>
        <TradeRowsSkeleton rows={6} />
      </section>
    </SkeletonPage>
  );
}
