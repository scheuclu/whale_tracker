import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { StatusScreen, primaryAction, secondaryAction } from "./status-screen";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <StatusScreen
      code="404 · Not found"
      title="Nothing surfaced here"
      action={
        <Link href="/" className={primaryAction}>
          Back to the feed
        </Link>
      }
      secondary={
        <Link href="/search" className={secondaryAction}>
          <Search className="size-3.5" aria-hidden />
          Search members and tickers
        </Link>
      }
    >
      There is no page at this address. If you followed a link to a filing, ticker or member, it may
      be mistyped — every trade the pipeline has read is reachable from the sections below.
    </StatusScreen>
  );
}
