import type { NextRequest } from "next/server";
import { optionsResponse } from "@/lib/api-format";
import { sendJson } from "@/lib/api-route";
import { buildMembers } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

/** Members who have disclosed trades, sorted in SQL before the limit. */
export async function GET(request: NextRequest) {
  return sendJson(request, buildMembers);
}

export function OPTIONS() {
  return optionsResponse();
}
