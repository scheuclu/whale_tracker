/**
 * The scan-page image route's pure parts, kept out of the handler so they
 * can be tested without Next: parameter parsing and the response headers.
 */

export type PageParams = { filingId: number; page: number };

/** Positive integers only; anything else is a 400, never a query. */
export function parsePageParams(raw: { filingId?: string; page?: string }): PageParams | null {
  const filingId = Number(raw.filingId);
  const page = Number(raw.page);
  if (!Number.isInteger(filingId) || filingId <= 0) return null;
  if (!Number.isInteger(page) || page <= 0) return null;
  return { filingId, page };
}

/**
 * A captured page can be replaced by a re-capture, so the cache is long but
 * not immutable: a week, public, which is how long a stale page might show.
 */
export const PNG_CACHE_SECONDS = 7 * 24 * 3600;

export function pngHeaders(byteLength: number): Record<string, string> {
  return {
    "Content-Type": "image/png",
    "Content-Length": String(byteLength),
    "Cache-Control": `public, max-age=${PNG_CACHE_SECONDS}`,
  };
}
