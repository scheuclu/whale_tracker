import type { NextRequest } from "next/server";
import { apiError, jsonResponse, optionsResponse, parseParams, textResponse, type VolumeJson } from "@/lib/api-format";
import { feedMarkdown } from "@/lib/api-markdown";
import { getCoverage } from "@/lib/api-queries";
import { originOf } from "@/lib/api-route";
import { buildTickers, buildTrades, type TradeJson } from "@/lib/api-v1";
import { publicErrorMessage } from "@/lib/public-error";

export const dynamic = "force-dynamic";

type TickerJson = { symbol: string; asset_name: string | null; members: number; trades: number; volume: VolumeJson; url: string };

/** The home feed for agents: coverage, the 90-day ticker leaders and the latest trades, as Markdown. */
export async function GET(request: NextRequest) {
  const origin = originOf(request);
  const p = parseParams(request.nextUrl.searchParams, {});
  if (p.errors.length) return jsonResponse(apiError(origin, 400, "invalid query parameters", p.errors), origin);
  try {
    const [trades, tickers, coverage] = await Promise.all([
      buildTrades(origin, new URLSearchParams({ limit: "40" })),
      buildTickers(origin, new URLSearchParams({ days: "90", limit: "15" })),
      getCoverage(),
    ]);
    if (trades.status !== 200) return jsonResponse(trades, origin);
    if (tickers.status !== 200) return jsonResponse(tickers, origin);
    const t = trades.body as { data: TradeJson[]; meta: { total: { trades: number; volume: VolumeJson } } };
    const k = tickers.body as { data: TickerJson[] };
    return textResponse(
      feedMarkdown(origin, coverage, t.data, t.meta.total, k.data),
      "text/markdown; charset=utf-8",
      200,
      origin
    );
  } catch (err) {
    return jsonResponse(apiError(origin, 503, `data unavailable: ${publicErrorMessage(err)}`), origin);
  }
}

export function OPTIONS() {
  return optionsResponse();
}
