"use client";

import { useSearchParams } from "next/navigation";
import {
  BarsSkeleton,
  Bone,
  PillsSkeleton,
  SectionTitleSkeleton,
  SkeletonPage,
  SplitSkeleton,
  TilesSkeleton,
  TradeRowsSkeleton,
} from "../skeletons";
import { Card } from "../charts";

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
      <TilesSkeleton count={6} cols="sm:grid-cols-3 lg:grid-cols-6" wrap={false} />
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

/** One issuer: symbol and name, five tiles, the member cross-link, then every trade. */
function IssuerLoading() {
  return (
    <SkeletonPage label="the issuer">
      <div>
        <span className="flex h-6 items-center">
          <Bone className="h-2.5 w-20" />
        </span>
        <Bone className="mt-2 h-9 w-28" />
        <span className="flex h-5 items-center">
          <Bone className="h-3 w-80 max-w-full" />
        </span>
      </div>
      <TilesSkeleton count={5} cols="sm:grid-cols-5" wrap={false} />
      <section>
        <SectionTitleSkeleton width="w-40" />
        <Card>
          <Bone className="h-3.5 w-96 max-w-full" />
        </Card>
      </section>
      <section>
        <SectionTitleSkeleton width="w-36" right />
        <div className="mb-3 space-y-1.5">
          <Bone className="h-2.5 w-full max-w-3xl" />
          <Bone className="h-2.5 w-1/2" />
        </div>
        <TradeRowsSkeleton rows={6} />
      </section>
    </SkeletonPage>
  );
}
