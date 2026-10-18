import type { NextRequest } from "next/server";
import { optionsResponse } from "@/lib/api-format";
import { sendJson } from "@/lib/api-route";
import { buildTrades } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

/** Congressional trades with the feed's filters and whole-match totals. */
export async function GET(request: NextRequest) {
  return sendJson(request, buildTrades);
}

export function OPTIONS() {
  return optionsResponse();
}
