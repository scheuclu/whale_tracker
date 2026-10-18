import type { NextRequest } from "next/server";
import { optionsResponse } from "@/lib/api-format";
import { sendJson } from "@/lib/api-route";
import { buildInsiders } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

/** One issuer's SEC Form 4 insider activity — never mixed with congressional data. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return sendJson(request, (origin, search) => buildInsiders(origin, decodeURIComponent(symbol), search));
}

export function OPTIONS() {
  return optionsResponse();
}
