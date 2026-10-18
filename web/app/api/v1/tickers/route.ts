import type { NextRequest } from "next/server";
import { optionsResponse } from "@/lib/api-format";
import { sendJson } from "@/lib/api-route";
import { buildTickers } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

/** Tickers members traded, sorted in SQL before the limit. */
export async function GET(request: NextRequest) {
  return sendJson(request, buildTickers);
}

export function OPTIONS() {
  return optionsResponse();
}
