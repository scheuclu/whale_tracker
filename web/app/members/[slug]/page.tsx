import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { resolveMemberSlug } from "@/lib/entities";
import { range } from "@/lib/format";
import { getPoliticianDetail } from "@/lib/queries";
import { clip, entityCard, pageMetadata } from "@/lib/seo";
import { chamberTitle, plural } from "@/lib/site";
import { breadcrumbLd, personLd } from "@/lib/structured-data";
import { Empty } from "../../charts";
import { JsonLd } from "../../json-ld";
import { MemberDetail } from "./member-detail";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ action?: string }>;
};

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Slug → member → whole record, once per request for metadata and page. */
const load = cache(async (slug: string) => {
  const ref = await resolveMemberSlug(decode(slug));
  if (!ref) return null;
  const detail = await getPoliticianDetail(ref.name);
  // The aggregate picks the id from an arbitrary row of the group; the
  // resolved one is the id the URL is built on.
  return { ref, detail: detail && { ...detail, bioguide_id: ref.bioguideId ?? detail.bioguide_id } };
});

/**
 * A non-canonical slug (a stale name part, or a name-only slug for a member
 * the roster knows) moves to the canonical one; an unknown slug is a 404.
 *
 * Every page streams behind app/loading.tsx, so the status line is sent
 * before this runs: the move goes out as a 0-second meta refresh (which
 * Google treats as a permanent redirect) and the 404 as a noindexed page,
 * not as a 308 / 404 status. Real 308s would need the database in proxy.ts.
 * Nothing on the site links a non-canonical slug — every link carries the
 * bioguide id — and the legacy `?m=` links get a true 308 from
 * app/api/legacy-redirect, so this only meets hand-typed or stale URLs.
 */
async function canonicalOrRedirect(props: Props) {
  const { slug } = await props.params;
  const data = await load(slug);
  if (!data) notFound();
  if (data.ref.slug !== decode(slug)) {
    const { action } = await props.searchParams;
    const filter = action === "buy" || action === "sell" ? `?action=${action}` : "";
    permanentRedirect(`/members/${data.ref.slug}${filter}`);
  }
  return data;
}

function party(detail: { party: string | null; state: string | null }): string {
  return [detail.party, detail.state].filter(Boolean).join("-");
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { ref, detail } = await canonicalOrRedirect(props);
  const path = `/members/${ref.slug}`;
  if (!detail) {
    return pageMetadata({
      title: `${ref.name}: no counted trades`,
      description: `${ref.name} has filings on record, but none with a trade the dashboard counts yet.`,
      path,
      noindex: true,
    });
  }
  const where = party(detail);
  const job = chamberTitle(detail.chamber);
  const span =
    detail.first_tx_date && detail.last_tx_date && detail.first_tx_date !== detail.last_tx_date
      ? `, traded ${detail.first_tx_date.slice(0, 7)} to ${detail.last_tx_date.slice(0, 7)}`
      : "";
  // The range is what the brackets disclose; no midpoint goes in a snippet.
  const disclosed = detail.trades > detail.transcribed ? ` Disclosed range ${range(detail.volume_min, detail.volume_max)}.` : "";
  return pageMetadata({
    title: `${ref.name}${where ? ` (${where})` : ""} stock trades`,
    description: clip(
      `${job ? `${job} ` : ""}${ref.name}${where ? ` (${where})` : ""}: ${plural(detail.trades, "disclosed trade")} across ${plural(detail.tickers, "ticker")} ` +
        `in ${plural(detail.filings, "STOCK Act filing")}${span} — ${detail.buys} buys, ${detail.sells} sells.${disclosed}`,
      200
    ),
    path,
    card: entityCard(
      path,
      `${ref.name}'s disclosed stock trades: ${plural(detail.trades, "trade")}, ${plural(detail.tickers, "ticker")}, ${detail.buys} buys and ${detail.sells} sells`
    ),
  });
}

export default async function MemberPage(props: Props) {
  const { ref, detail } = await canonicalOrRedirect(props);
  const { action } = await props.searchParams;
  const path = `/members/${ref.slug}`;
  const crumbs = breadcrumbLd([
    { name: "Whale Tracker", path: "/" },
    { name: "Politicians", path: "/politicians" },
    { name: ref.name, path },
  ]);

  if (!detail) {
    return (
      <div className="space-y-6">
        <JsonLd data={crumbs} />
        <a href="/politicians" className="text-xs text-muted-foreground hover:text-primary">
          ← all members
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">{ref.name}</h1>
        <Empty>
          No counted trades for {ref.name} yet.{" "}
          <a href={`/scans?m=${encodeURIComponent(ref.name)}`} className="underline underline-offset-2 hover:text-primary">
            Scanned filings
          </a>
        </Empty>
      </div>
    );
  }

  return (
    <>
      <JsonLd
        data={[
          crumbs,
          personLd({
            name: ref.name,
            bioguideId: ref.bioguideId,
            chamber: detail.chamber,
            party: detail.party,
            state: detail.state,
            path,
          }),
        ]}
      />
      <MemberDetail detail={detail} action={action} />
    </>
  );
}
