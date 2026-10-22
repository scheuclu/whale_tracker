import { test as base, expect, type Page } from "@playwright/test";

/**
 * `test` with a page that fails the test on anything the browser reports as
 * broken: an uncaught exception, a `console.error` (hydration mismatches,
 * React errors), or a same-origin subresource answering 4xx/5xx (a missing
 * JS/CSS chunk, a failing route handler).
 *
 * Allowed, because they are not this app's failure:
 * - `/_vercel/*` — Web Analytics' script only exists on Vercel's edge.
 * - `/_next/image?url=https://…` — member portraits proxied from
 *   unitedstates.github.io; some members have none (404 upstream), and the
 *   avatar falls back to initials by design (app/avatar.tsx).
 * - The document itself when the test expects that status (the 404 page).
 *
 * The browser's own "Failed to load resource" console line is skipped in
 * favour of the response check, which knows the URL and the status.
 */
const ALLOWED_RESPONSE = [/\/_vercel\//, /\/_next\/image\?url=https?%3A/];

export type Problems = { list: string[]; allowDocumentStatus: (status: number) => void };

export const test = base.extend<{ problems: Problems }>({
  problems: [
    async ({ page, baseURL }, use) => {
      const list: string[] = [];
      let documentStatus: number | null = null;
      const origin = new URL(baseURL!).origin;
      page.on("pageerror", (e) => list.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        if (m.text().startsWith("Failed to load resource")) return;
        list.push(`console.error: ${m.text()} (${m.location().url})`);
      });
      page.on("response", (r) => {
        const url = r.url();
        if (r.status() < 400 || !url.startsWith(origin)) return;
        if (ALLOWED_RESPONSE.some((re) => re.test(url))) return;
        if (r.request().isNavigationRequest() && r.status() === documentStatus) return;
        list.push(`HTTP ${r.status()}: ${url}`);
      });
      await use({ list, allowDocumentStatus: (s) => (documentStatus = s) });
      expect(list, "browser errors on the page").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Load a page, wait for hydration to settle, and return the response. */
export async function visit(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: "load" });
  await page.waitForLoadState("networkidle");
  return res;
}
