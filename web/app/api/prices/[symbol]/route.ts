import { getDb } from "@/lib/db";
import { isHeldSymbol, storedCloses } from "@/lib/price-queries";
import {
  fetchYahooCloses,
  fromYear,
  normaliseSymbol,
  seriesHeaders,
  type Close,
  type PriceSeries,
} from "@/lib/prices";

export const dynamic = "force-dynamic";

/**
 * Daily closes for one symbol we hold, for the price overlay on the ticker
 * and insider-issuer pages: `GET /api/prices/NVDA?from=2025`.
 *
 * Fetched from the pipeline's source on demand rather than stored (see
 * lib/prices.ts for why), cached on the CDN for 12 h plus a 2-day
 * stale-while-revalidate window and in Next's data cache for the same 12 h.
 * One URL per symbol and start year, so every page that charts the symbol
 * shares the entry.
 *
 * Never an error page for a missing series: an unknown or delisted symbol is
 * `no_data`, a refusal or timeout at the source is `unavailable` (cached for
 * five minutes only), and either way the pipeline's stored closes are served
 * instead when it has any. A malformed symbol is a 400 and one we do not hold
 * a 404, both before any request goes out.
 */
export async function GET(request: Request, ctx: { params: Promise<{ symbol: string }> }) {
  const { symbol: raw } = await ctx.params;
  const symbol = normaliseSymbol(raw);
  if (!symbol) return json({ symbol: raw, source: null, status: "unsupported", closes: [] }, 400);

  const now = new Date();
  const year = fromYear(new URL(request.url).searchParams.get("from"), now);
  let db;
  try {
    db = await getDb();
  } catch {
    return json({ symbol, source: null, status: "unavailable", closes: [] }, 503);
  }
  if (!isHeldSymbol(db, symbol)) return json({ symbol, source: null, status: "unsupported", closes: [] }, 404);

  let closes: Close[] = [];
  let failed = false;
  try {
    closes = await fetchYahooCloses(symbol, year, now);
  } catch (err) {
    failed = true;
    console.warn(`prices: ${symbol} from ${year}: ${(err as Error).message}`);
  }
  if (closes.length) return json({ symbol, source: "yahoo", status: "ok", closes: compact(closes) });

  const stored = storedCloses(db, symbol, `${year}-01-01`);
  if (stored.length) {
    // The pipeline's rows answer, but only for a few weeks; cache them like a
    // failure so the full series replaces them as soon as the source answers.
    return json({ symbol, source: "stored", status: "ok", closes: compact(stored) }, 200, "unavailable");
  }
  return json({ symbol, source: null, status: failed ? "unavailable" : "no_data", closes: [] });
}

function compact(closes: Close[]): Close[] {
  return closes.map((c) => ({ date: c.date, close: Math.round(c.close * 10_000) / 10_000 }));
}

function json(body: PriceSeries, status = 200, cacheAs: PriceSeries["status"] = body.status): Response {
  return new Response(JSON.stringify(body), { status, headers: seriesHeaders(cacheAs) });
}
