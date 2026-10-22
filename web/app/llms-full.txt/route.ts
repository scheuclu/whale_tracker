import type { NextRequest } from "next/server";
import { optionsResponse, textResponse } from "@/lib/api-format";
import { getCoverage } from "@/lib/api-queries";
import { originOf } from "@/lib/api-route";
import { llmsFullTxt } from "@/lib/methodology";
import { publicErrorMessage } from "@/lib/public-error";

export const dynamic = "force-dynamic";

/** Self-contained context for language models, with live coverage from the database. */
export async function GET(request: NextRequest) {
  const origin = originOf(request);
  try {
    return textResponse(llmsFullTxt(origin, await getCoverage()), "text/plain; charset=utf-8", 200, origin);
  } catch (err) {
    return textResponse(`llms-full.txt unavailable: ${publicErrorMessage(err)}`, "text/plain; charset=utf-8", 503, origin);
  }
}

export function OPTIONS() {
  return optionsResponse();
}
