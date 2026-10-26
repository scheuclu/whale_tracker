import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";
import { range, tickerHref } from "@/lib/format";
import { getTickerDetail } from "@/lib/queries";
import { getInsiderIssuer } from "@/lib/insider-queries";
import { clip, entityCard, pageCard, pageMetadata } from "@/lib/seo";
import { plural } from "@/lib/site";
import { breadcrumbLd } from "@/lib/structured-data";
import { JsonLd } from "../../json-ld";
import { StockDetail } from "./ticker-detail";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ symbol: string }> };

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Both all-time aggregates, once per request for metadata and page: the
 * congressional one and the Form 4 one. Set side by side, never added.
 */
const load = cache(async (symbol: string) => {
  const [stat, issuer] = await Promise.all([
    getTickerDetail(symbol),
    // A database without the insider tables, or a fault in them, leaves the congressional page standing.
    getInsiderIssuer(symbol).catch(() => null),
  ]);
  return { symbol, stat, issuer };
});

/**
 * One page per stock: congressional trades and corporate insider trades in
 * it (the insider issuer page, `/insiders?t=X`, now 308s here). Symbols are
 * stored upper case; `/tickers/msft` moves to `/tickers/MSFT`. A symbol with
 * neither a counted congressional trade nor a stored Form 4 is a 404. As on the member
 * page, streaming means these go out as a 0-second meta refresh and a
 * noindexed page rather than as status codes (see app/members/[slug]/page.tsx);
 * links on the site and the legacy `?t=` redirect always produce the
 * canonical upper-case form.
 */
async function canonicalOrRedirect(props: Props) {
  const raw = decode((await props.params).symbol);
  const symbol = raw.toUpperCase();
  if (raw !== symbol) permanentRedirect(tickerHref(symbol));
  const loaded = await load(symbol);
  if (!loaded.stat && !loaded.issuer) notFound();
  return loaded;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { symbol, stat, issuer } = await canonicalOrRedirect(props);
  const company = stat?.asset_name ?? issuer?.issuer_name ?? null;
  const name = company ? ` (${company})` : "";
  // Asset names run long ("… New Common Stock"); the title keeps the head of it.
  const short = company ? ` (${clip(company, 36)})` : "";
  const parts = [
    stat
      ? `${plural(stat.politicians, "member")} of Congress disclosed ${plural(stat.trades, "trade")} (${stat.buys} buys, ${stat.sells} sells` +
        `${stat.trades > stat.transcribed ? `, disclosed range ${range(stat.volume_min, stat.volume_max)}` : ""})`
      : null,
    issuer ? `${plural(issuer.insiders, "corporate insider")} filed ${plural(issuer.trades, "open-market trade")} on SEC Form 4` : null,
  ].filter(Boolean);
  const who = stat && issuer ? "members of Congress and insiders" : stat ? "members of Congress" : "corporate insiders";
  return pageMetadata({
    title: `${symbol}${short} trades by ${who}`,
    description: clip(`${symbol}${name}: ${parts.join("; ")}.`, 200),
    path: tickerHref(symbol),
    card: stat
      ? entityCard(
          tickerHref(symbol),
          `${symbol}: ${plural(stat.politicians, "member")} of Congress trading, ${plural(stat.trades, "disclosed trade")}, ${stat.buys} buys and ${stat.sells} sells`
        )
      : pageCard(`/cards/issuer/${encodeURIComponent(symbol)}`, `${symbol}: corporate insider trades from SEC Form 4`),
  });
}

export default async function TickerPage(props: Props) {
  const { symbol, stat, issuer } = await canonicalOrRedirect(props);
  return (
    <>
      <JsonLd
        data={breadcrumbLd([
          { name: "FatCat Watch", path: "/" },
          { name: "Stocks", path: "/tickers" },
          { name: symbol, path: tickerHref(symbol) },
        ])}
      />
      <StockDetail symbol={symbol} stat={stat} issuer={issuer} />
    </>
  );
}
