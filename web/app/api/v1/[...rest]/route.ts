import type { NextRequest } from "next/server";
import { apiError, jsonResponse, optionsResponse } from "@/lib/api-format";
import { originOf } from "@/lib/api-route";

export const dynamic = "force-dynamic";

/** Any other `/api/v1/…` path: a JSON 404 pointing at the index, not the site's HTML 404 page. */
export async function GET(request: NextRequest) {
  const origin = originOf(request);
  return jsonResponse(
    apiError(origin, 404, `no such endpoint: ${request.nextUrl.pathname.slice(0, 120)}; see ${origin}/api/v1 or ${origin}/openapi.json`),
    origin
  );
}

export function OPTIONS() {
  return optionsResponse();
}
