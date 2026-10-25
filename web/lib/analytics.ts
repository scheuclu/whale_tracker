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

export function trackEvent(name: string, properties?: EventProperties): void {
  if (typeof window === "undefined") return;

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
