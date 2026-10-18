import type { NextRequest } from "next/server";
import { optionsResponse, textResponse } from "@/lib/api-format";
import { originOf } from "@/lib/api-route";
import { llmsTxt } from "@/lib/methodology";

export const dynamic = "force-dynamic";

/** llmstxt.org index: what the site is, the key quoting rules, and where to read more. */
export function GET(request: NextRequest) {
  const origin = originOf(request);
  return textResponse(llmsTxt(origin), "text/plain; charset=utf-8", 200, origin);
}

export function OPTIONS() {
  return optionsResponse();
}
