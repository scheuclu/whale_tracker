"use client";

import { useSearchParams } from "next/navigation";
import {
  BarsSkeleton,
  CardGridSkeleton,
  HeadingSkeleton,
  PillsSkeleton,
  RangeSkeleton,
  SectionTitleSkeleton,
  SkeletonPage,
  SplitSkeleton,
  TableSkeleton,
  TilesSkeleton,
  TimelineSkeleton,
  TradeRowsSkeleton,
} from "../skeletons";

/**
 * Tickers has two shapes on one route: the list, and one ticker (`?t=`).
 * A client component so the placeholder can follow the URL it is loading.
 */
export default function Loading() {
  return useSearchParams().get("t") ? <TickerLoading /> : <TickersLoading />;
}

/** The list: window pills, volume and members charts side by side, the table. */
function TickersLoading() {
  return (
    <SkeletonPage label="tickers">
      <PillsSkeleton />
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitleSkeleton width="w-40" />
          <BarsSkeleton rows={10} />
        </div>
        <div>
          <SectionTitleSkeleton width="w-40" />
          <SplitSkeleton rows={10} />
        </div>
      </section>
      <section>
        <SectionTitleSkeleton width="w-24" />
        <TableSkeleton rows={8} cols={7} />
      </section>
    </SkeletonPage>
  );
}

/** One ticker: heading with the buy/sell balance, tiles, timeline, range, who traded it, every trade. */
function TickerLoading() {
  return (
    <SkeletonPage label="the ticker">
      <HeadingSkeleton split />
      <TilesSkeleton wrap={false} />
      <section>
        <SectionTitleSkeleton width="w-32" right />
        <TimelineSkeleton />
      </section>
      <section>
        <SectionTitleSkeleton width="w-44" />
        <RangeSkeleton />
      </section>
      <section>
        <SectionTitleSkeleton width="w-36" right />
        <CardGridSkeleton count={9} />
      </section>
      <section>
        <SectionTitleSkeleton width="w-40" right />
        <TradeRowsSkeleton rows={6} />
      </section>
    </SkeletonPage>
  );
}
