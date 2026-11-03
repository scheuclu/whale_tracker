/**
 * Safe custom event tracking for Vercel Web Analytics (@vercel/analytics).
 *
 * Guidelines (see CLAUDE.md):
 * - Whenever adding or updating user-facing features, consider instrumenting
 *   meaningful user interactions (search queries, filter toggles, sorts, clicks).
 * - Never track personally identifiable information (PII).
 * - Safe across SSR, test suites, and client environments with ad blockers.
 */

export type EventProperties = Record<string, string | number | boolean | null | undefined>;

type VaWindow = { va?: (...params: unknown[]) => void; vaq?: unknown[][] };

/**
 * The SDK's own queue (`initQueue` in @vercel/analytics), defined here too.
 * `track()` drops an event outright when `window.va` does not exist yet, and
 * `<Analytics />` only defines it in an effect. An event sent while the page
 * is still starting up was lost: `sign_in_complete` fires on the landing page
 * after the sign-in redirect, and production recorded none at all while
 * `sign_in_start` came through (traced 2026-11-03: the flag was read at
 * 273 ms, `window.va` appeared at 327 ms). The analytics script drains
 * `window.vaq` when it loads, and `initQueue` keeps a `va` that already
 * exists, so the two agree. Behind an ad blocker the queue is never drained,
 * which is harmless.
 */
function ensureQueue(w: VaWindow): void {
  if (w.va) return;
  w.va = function va(...params: unknown[]) {
    (w.vaq ??= []).push(params);
  };
}

export function trackEvent(name: string, properties?: EventProperties): void {
  if (typeof window === "undefined") return;
  ensureQueue(window as unknown as VaWindow);

  const cleanProps: Record<string, string | number | boolean | null> = {};
  if (properties) {
    for (const [k, v] of Object.entries(properties)) {
      if (v !== undefined) {
        cleanProps[k] = v;
      }
    }
  }

  import("@vercel/analytics")
    .then(({ track }) => {
      track(name, cleanProps);
    })
    .catch(() => {
      // Safely ignore ad-blocker or network issues
    });
}
