"use client";

import { useEffect } from "react";
import { trackEvent } from "@/lib/analytics";

export function SearchAnalytics({
  query,
  membersCount,
  tickersCount,
  issuersCount,
}: {
  query: string;
  membersCount: number;
  tickersCount: number;
  issuersCount: number;
}) {
  useEffect(() => {
    if (!query) return;
    trackEvent("search_query", {
      query,
      members: membersCount,
      tickers: tickersCount,
      issuers: issuersCount,
      total_hits: membersCount + tickersCount + issuersCount,
    });
  }, [query, membersCount, tickersCount, issuersCount]);

  return null;
}
