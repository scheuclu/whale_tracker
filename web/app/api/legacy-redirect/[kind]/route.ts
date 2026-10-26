import type { NextRequest } from "next/server";
import { resolveMemberName } from "@/lib/entities";
import { insiderHref, memberHref, tickerHref } from "@/lib/format";
import { getInsiderName } from "@/lib/insider-people";

/**
 * Permanent redirects for the query-string entity URLs the site used before
 * `/members/<slug>` and `/tickers/<SYMBOL>`:
 *
 *   /politicians?m=<name>[&action=buy]  → /members/<slug>[?action=buy]
 *   /?member=<name>[&action=buy]        → the same (the feed's older form)
 *   /tickers?t=<symbol>                 → /tickers/<SYMBOL>
 *   /insiders?t=<symbol>                → /tickers/<SYMBOL>#insiders
 *   /insiders?cik=<cik>                 → /insiders/<name>-<cik>
 *
 * Telegram alerts, bookmarks and other sites carry these, so they must keep
 * working, and a crawler must learn the move: a 308, not a page that
 * redirects after rendering. A page cannot do that here — every page streams
 * behind app/loading.tsx, and a redirect thrown after the shell is sent goes
 * out as a 200 with a meta refresh. So next.config.ts rewrites exactly these
 * URLs (matched on the query key) to this handler, which answers before any
 * rendering. The member lookup needs the database (the canonical slug
 * carries the bioguide id), which is why this is a route and not a config
 * redirect.
 */
export const dynamic = "force-dynamic";

function redirect(req: NextRequest, path: string): Response {
  return new Response(null, { status: 308, headers: { Location: new URL(path, req.nextUrl.origin).toString() } });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ kind: string }> }): Promise<Response> {
  // The rewrite carries the original query string; the kind is the path.
  const q = req.nextUrl.searchParams;
  const { kind } = await ctx.params;
  const action = q.get("action");
  const filter = action === "buy" || action === "sell" ? action : undefined;

  if (kind === "member" || kind === "feed-member") {
    const name = (kind === "member" ? q.get("m") : q.get("member"))?.trim();
    if (!name) return redirect(req, "/politicians");
    let ref = null;
    try {
      ref = await resolveMemberName(name);
    } catch {
      /* database unavailable: fall through to the name-only slug */
    }
    // An unknown name still moves to the new scheme; that page answers 404.
    return redirect(req, ref ? memberHref(ref.name, ref.bioguideId, filter) : memberHref(name, null, filter));
  }

  if (kind === "ticker") {
    const symbol = q.get("t")?.trim();
    return redirect(req, symbol ? tickerHref(symbol) : "/tickers");
  }

  // The insider filter (`/insiders?cik=`) became the insider's own page.
  if (kind === "insider") {
    const cik = q.get("cik")?.trim() ?? "";
    if (!/^\d{10}$/.test(cik)) return redirect(req, "/insiders");
    let name: string | null = null;
    try {
      name = await getInsiderName(cik);
    } catch {
      /* database unavailable: the slug's name part is cosmetic */
    }
    return redirect(req, insiderHref(name, cik));
  }

  // The insider issuer page became the stock page's insider section.
  if (kind === "issuer") {
    const symbol = q.get("t")?.trim().toUpperCase();
    return redirect(req, symbol ? `${tickerHref(symbol)}#insiders` : "/insiders");
  }

  return redirect(req, "/");
}
