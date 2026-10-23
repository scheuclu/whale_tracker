"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  BarsSkeleton,
  GlanceSkeleton,
  GroupedListSkeleton,
  HeroSkeleton,
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
 * Tickers has two shapes: the list, and one ticker (`/tickers/<SYMBOL>`, or
 * the legacy `?t=` on its way to a redirect). This boundary also wraps the
 * `[symbol]` route, so on a navigation into a ticker it is the one that
 * shows; a client component so the placeholder can follow the URL it is
 * loading.
 */
export default function Loading() {
  const onTicker = usePathname() !== "/tickers" || useSearchParams().get("t");
  return onTicker ? <TickerLoading /> : <TickersLoading />;
}

/** The list: window pills, volume and members charts side by side, the table. */
function TickersLoading() {
  return (
    <SkeletonPage label="tickers" head>
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

/** One ticker: the symbol hero, tiles and the buy/sell glance tile, price chart, timeline, range, who traded it, every trade. */
export function TickerLoading() {
  return (
    <SkeletonPage label="the ticker">
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
        <SectionTitleSkeleton width="w-32" right />
        <TimelineSkeleton />
      </section>
      <section>
        <SectionTitleSkeleton width="w-44" />
        <RangeSkeleton />
      </section>
      <section>
        <SectionTitleSkeleton width="w-36" right />
        <GroupedListSkeleton rows={6} />
      </section>
      <section>
        <SectionTitleSkeleton width="w-40" right />
        <TradeRowsSkeleton rows={6} />
      </section>
    </SkeletonPage>
  );
}
