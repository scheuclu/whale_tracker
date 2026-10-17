import { getScanPagePng } from "@/lib/scan-queries";
import { parsePageParams, pngHeaders } from "@/lib/scan-image";

export const dynamic = "force-dynamic";

/** One captured page of a scanned filing, as the stored 1-bit PNG. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ filingId: string; page: string }> }
) {
  const params = parsePageParams(await ctx.params);
  if (!params) return new Response("bad request", { status: 400 });
  let png: Buffer | null;
  try {
    png = await getScanPagePng(params.filingId, params.page);
  } catch (err) {
    return new Response((err as Error).message, { status: 503 });
  }
  if (!png) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(png), { headers: pngHeaders(png.byteLength) });
}
