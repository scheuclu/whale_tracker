/**
 * The site's canonical origin, for absolute URLs that leave the site
 * (llms.txt, llms-full.txt, openapi.json `servers`, API `url` fields).
 *
 * Never a per-deployment URL: those sit behind Vercel's deployment
 * protection, and a link an agent cannot open is worse than none. Order:
 * `NEXT_PUBLIC_SITE_URL` (explicit), then Vercel's production domain
 * (`VERCEL_PROJECT_PRODUCTION_URL`, set on every deployment, previews
 * included), then the request's own origin (local runs).
 */
export function siteUrl(requestOrigin?: string): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) return `https://${production.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  if (requestOrigin) return requestOrigin.replace(/\/+$/, "");
  return "http://localhost:3000";
}
