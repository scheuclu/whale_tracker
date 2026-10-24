import type { NextRequest } from "next/server";
import { optionsResponse } from "@/lib/api-format";
import { sendJson } from "@/lib/api-route";
import { buildTrackRecord } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

/** The members' track record at one horizon (30, 90 or 180 trading days). */
export async function GET(request: NextRequest) {
  return sendJson(request, buildTrackRecord);
}

export function OPTIONS() {
  return optionsResponse();
}
