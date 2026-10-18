import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { StatusScreen, primaryAction } from "./status-screen";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <StatusScreen
      code="404 · not found"
      title="Nothing surfaced here"
      actions={
        <Link href="/" className={primaryAction}>
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to the feed
        </Link>
      }
    >
      There is no page at this address. If you followed a link to a filing, ticker or member, it may
      be mistyped — every trade the pipeline has read is reachable from the sections below.
    </StatusScreen>
  );
}
