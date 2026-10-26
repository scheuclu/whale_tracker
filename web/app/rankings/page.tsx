import { Fragment } from "react";
import type { Metadata } from "next";
import { pageCard, pageMetadata } from "@/lib/seo";
import { parseTrackHorizon } from "@/lib/track-queries";
import { Segmented } from "../ui";
import { TRACK_PATH, TrackView } from "./track-view";
import { ACTIVE_PATH, ActiveView } from "./active-view";
import { LATE_PATH, LateView } from "./late-view";
import { TRENDS_PATH, TrendsView } from "./trends-view";

export const dynamic = "force-dynamic";

/**
 * Rankings: the hub for rating and comparing filers. Four views of one route,
 * each canonical to itself with only the parameter that defines it:
 *
 *   /rankings                track record (the default; `?h=30|180` is a view of it)
 *   /rankings?view=active    most active
 *   /rankings?view=late      late filers
 *   /rankings?view=trends    trends by month (`?w=`, `?t=` are views of it)
 *
 * `/politicians?view=track|late` and `/trends` answer with a 308 here
 * (next.config.ts).
 */

type Params = { view?: string; h?: string; w?: string; t?: string };
type View = "track" | "active" | "late" | "trends";

const VIEWS: { key: View; label: string; href: string }[] = [
  { key: "track", label: "Track record", href: TRACK_PATH },
  { key: "active", label: "Most active", href: ACTIVE_PATH },
  { key: "late", label: "Late filers", href: LATE_PATH },
  { key: "trends", label: "Trends", href: TRENDS_PATH },
];

function parseView(raw: string | undefined): View {
  return VIEWS.some((v) => v.key === raw) ? (raw as View) : "track";
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<Params> }): Promise<Metadata> {
  const view = parseView((await searchParams).view);
  if (view === "active") {
    return pageMetadata({
      title: "Most active members of Congress in the stock market",
      description:
        "Members of Congress ranked by the estimated volume and the number of stock trades they disclosed under the STOCK Act. Amounts are disclosed brackets; every volume is an estimate.",
      path: ACTIVE_PATH,
    });
  }
  if (view === "late") {
    return pageMetadata({
      title: "Late STOCK Act disclosures by member of Congress",
      description:
        "Members of Congress ranked by trades disclosed more than 45 days after the trade, the STOCK Act deadline, with the filings behind each count. A reporting fact, not an allegation.",
      path: LATE_PATH,
      card: pageCard("/cards/late", "Late STOCK Act disclosures: late trades, their share of all disclosed trades, members late and filings"),
    });
  }
  if (view === "trends") {
    return pageMetadata({
      title: "Congressional trading trends by month",
      description:
        "Monthly trades disclosed by members of Congress, disclosure delay against the 45-day STOCK Act deadline, rising tickers and scanned paper filings, beside SEC Form 4 insider activity.",
      path: TRENDS_PATH,
      card: pageCard("/trends", "Congressional stock trades by month: purchases above the line, sales below, last 12 months by trade date"),
    });
  }
  return pageMetadata({
    title: "Track record: whose stock trades beat the market",
    description:
      "Members of Congress ranked by how the stocks they traded moved afterwards against the S&P 500, from the trade date and from the disclosure, with intervals and a luck check. A stock's move, not anyone's profit; not advice.",
    path: TRACK_PATH,
    card: pageCard("/cards/track", "Track record: members of Congress whose trades were followed by the biggest market-beating moves, against the S&P 500"),
  });
}

export default async function RankingsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const view = parseView(params.view);
  const horizon = parseTrackHorizon(params.h);
  // The view switcher sits in each view's header, on the share row.
  const nav = (
    <nav aria-label="Rankings" className="scrollbar-none -m-1 max-w-full overflow-x-auto p-1">
      <Segmented
        label="Ranking"
        items={VIEWS.map((v) => ({ key: v.key, label: v.label, href: v.href, active: v.key === view }))}
      />
    </nav>
  );
  // Keyed so switching views remounts instead of morphing one view's DOM into another's.
  return (
    <Fragment key={view === "track" ? `track:${horizon}` : view}>
      {view === "active" ? (
        <ActiveView nav={nav} />
      ) : view === "late" ? (
        <LateView nav={nav} />
      ) : view === "trends" ? (
        <TrendsView params={{ w: params.w, t: params.t }} nav={nav} />
      ) : (
        <TrackView horizon={horizon} nav={nav} />
      )}
    </Fragment>
  );
}
