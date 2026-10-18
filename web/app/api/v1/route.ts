import type { NextRequest } from "next/server";
import { optionsResponse } from "@/lib/api-format";
import { sendJson } from "@/lib/api-route";
import { buildIndex } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

/** The API's index: endpoints, live coverage and the rules for quoting. */
export async function GET(request: NextRequest) {
  return sendJson(request, buildIndex);
}

export function OPTIONS() {
  return optionsResponse();
}
