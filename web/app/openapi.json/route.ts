import type { NextRequest } from "next/server";
import { optionsResponse, textResponse } from "@/lib/api-format";
import { originOf } from "@/lib/api-route";
import { openApiDocument } from "@/lib/openapi";

export const dynamic = "force-dynamic";

/** OpenAPI 3.1 description of /api/v1, generated from the handlers' own parameter whitelist. */
export function GET(request: NextRequest) {
  const origin = originOf(request);
  return textResponse(
    JSON.stringify(openApiDocument(origin), null, 2),
    "application/json; charset=utf-8",
    200,
    origin
  );
}

export function OPTIONS() {
  return optionsResponse();
}
