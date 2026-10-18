import type { NextRequest } from "next/server";
import { optionsResponse, splitFormat } from "@/lib/api-format";
import { sendJson, sendMarkdown } from "@/lib/api-route";
import { tickerMarkdown } from "@/lib/api-markdown";
import { buildTicker, type TickerResult } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

/** One ticker's congressional record; `NVDA.md` is the same response as Markdown. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ symbol: string }> }) {
  const { id, markdown } = splitFormat((await params).symbol);
  const build = (origin: string, search: URLSearchParams) => buildTicker(origin, id, search);
  return markdown ? sendMarkdown<TickerResult>(request, build, tickerMarkdown) : sendJson(request, build);
}

export function OPTIONS() {
  return optionsResponse();
}
