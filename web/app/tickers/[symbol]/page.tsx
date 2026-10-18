import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { range, tickerHref } from "@/lib/format";
import { getTickerDetail } from "@/lib/queries";
import { clip, entityCard, pageMetadata } from "@/lib/seo";
import { plural } from "@/lib/site";
import { breadcrumbLd } from "@/lib/structured-data";
import { JsonLd } from "../../json-ld";
import { TickerDetail } from "./ticker-detail";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ symbol: string }> };

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The all-time aggregate, once per request for metadata and page. */
const load = cache((symbol: string) => getTickerDetail(symbol));

/**
 * Symbols are stored upper case; `/tickers/msft` moves to `/tickers/MSFT`. A
 * symbol with no counted congressional trade is a 404. As on the member
 * page, streaming means these go out as a 0-second meta refresh and a
 * noindexed page rather than as status codes (see app/members/[slug]/page.tsx);
 * links on the site and the legacy `?t=` redirect always produce the
 * canonical upper-case form.
 */
async function canonicalOrRedirect(props: Props) {
  const raw = decode((await props.params).symbol);
  const symbol = raw.toUpperCase();
  if (raw !== symbol) permanentRedirect(tickerHref(symbol));
  const stat = await load(symbol);
  if (!stat) notFound();
  return stat;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const stat = await canonicalOrRedirect(props);
  const name = stat.asset_name ? ` (${stat.asset_name})` : "";
  // Asset names run long ("… New Common Stock"); the title keeps the head of it.
  const short = stat.asset_name ? ` (${clip(stat.asset_name, 36)})` : "";
  const disclosed = stat.trades > stat.transcribed ? ` Disclosed range ${range(stat.volume_min, stat.volume_max)}.` : "";
  return pageMetadata({
    title: `${stat.ticker}${short} trades by members of Congress`,
    description: clip(
      `${plural(stat.politicians, "member")} of Congress disclosed ${plural(stat.trades, "trade")} in ${stat.ticker}${name}: ` +
        `${stat.buys} buys and ${stat.sells} sells${stat.last_tx_date ? `, last traded ${stat.last_tx_date}` : ""}.${disclosed}`,
      200
    ),
    path: tickerHref(stat.ticker),
    card: entityCard(
      tickerHref(stat.ticker),
      `${stat.ticker}: ${plural(stat.politicians, "member")} of Congress trading, ${plural(stat.trades, "disclosed trade")}, ${stat.buys} buys and ${stat.sells} sells`
    ),
  });
}

export default async function TickerPage(props: Props) {
  const stat = await canonicalOrRedirect(props);
  return (
    <>
      <JsonLd
        data={breadcrumbLd([
          { name: "FatCat Watch", path: "/" },
          { name: "Tickers", path: "/tickers" },
          { name: stat.ticker, path: tickerHref(stat.ticker) },
        ])}
      />
      <TickerDetail stat={stat} />
    </>
  );
}
