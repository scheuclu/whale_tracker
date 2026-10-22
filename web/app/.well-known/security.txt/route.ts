import { securityTxt } from "@/lib/security-txt";
import { siteUrl } from "@/lib/site";

// Per request, so `Expires` is always in the future: lib/security-txt.ts.
export const dynamic = "force-dynamic";

export function GET() {
  return new Response(securityTxt(siteUrl()), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
