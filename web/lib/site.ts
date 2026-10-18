/**
 * The public origin every absolute URL is built on — canonicals, the
 * sitemap, robots.txt, Open Graph and JSON-LD.
 *
 * 1. `NEXT_PUBLIC_SITE_URL` — set this in production to the public domain
 *    (https://www.fatcatwatch.com). Explicit beats inferred.
 * 2. `VERCEL_PROJECT_PRODUCTION_URL` — Vercel's production domain for the
 *    project (a bare host, no scheme). Present on every deployment, previews
 *    included, so a preview's canonicals still name production and never the
 *    SSO-protected deployment URL a crawler cannot fetch.
 * 3. The request's own origin, when the caller has one (API route handlers
 *    on a local run), so a link printed by the API opens where it was read.
 * 4. localhost, for `next start` on a laptop.
 */
export function siteUrl(
  env: Record<string, string | undefined> = process.env,
  requestOrigin?: string
): string {
  const explicit = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  if (requestOrigin) return requestOrigin.replace(/\/+$/, "");
  return "http://localhost:3000";
}

/** An absolute URL for a site path. */
export function absoluteUrl(path: string, env?: Record<string, string | undefined>): string {
  return `${siteUrl(env)}${path.startsWith("/") ? path : `/${path}`}`;
}

export const SITE_NAME = "FatCat Watch";

export const SITE_DESCRIPTION =
  "US congressional and corporate-insider stock trades: tickers, volume, and who is trading";

/** "Rep." / "Sen." spelled out, for titles and structured data. */
export function chamberTitle(chamber: string | null | undefined): string | null {
  if (chamber === "senate") return "U.S. Senator";
  if (chamber === "house") return "U.S. Representative";
  return null;
}

/** "3 trades", "1 trade". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? word : many}`;
}
