import type { FullConfig } from "@playwright/test";
import { siteOrigin } from "./routes";

/**
 * Fails fast, with the fix spelled out, when the build was made for another
 * origin: canonicals and the sitemap are baked in at `next build`, so a
 * build without `NEXT_PUBLIC_SITE_URL` names http://localhost:3000 and every
 * SEO check would fail with a less helpful message.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  const expected = siteOrigin(baseURL);
  const res = await fetch(`${baseURL}/robots.txt`);
  if (!res.ok) throw new Error(`${baseURL}/robots.txt answered ${res.status}; is the server up?`);
  const line = (await res.text()).split("\n").find((l) => l.startsWith("Sitemap:"));
  const origin = line ? new URL(line.slice("Sitemap:".length).trim()).origin : null;
  if (origin !== expected) {
    throw new Error(
      `The build names ${origin ?? "no sitemap"} as the site origin, but the tests run against ${expected}. ` +
        `Rebuild with NEXT_PUBLIC_SITE_URL=${expected} npm run build (it is inlined at build time).`
    );
  }
}
