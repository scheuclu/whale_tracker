import { PAGES, siteOrigin } from "./routes";
import { expect, test, visit } from "./fixtures";

/**
 * Every main route renders in a real browser without errors and carries the
 * SEO basics: one <h1>, a <title>, a meta description, and an absolute,
 * self-referential canonical (a sorted/filtered variant names its base page).
 */
test.describe.configure({ mode: "parallel" });

for (const route of PAGES) {
  test(`renders ${route.path}`, async ({ page, problems, baseURL }) => {
    const status = route.status ?? 200;
    problems.allowDocumentStatus(status);
    const res = await visit(page, route.path);
    expect(res?.status(), "HTTP status").toBe(status);

    // The error boundary (app/error.tsx) and the database status screen
    // answer 200 with an apology; a page must never be either.
    await expect(page.locator("h1"), "exactly one <h1>").toHaveCount(1);
    await expect(page.locator("h1")).not.toBeEmpty();
    await expect(page.locator("h1")).not.toContainText(/didn.t load|not connected/i);

    const head = await page.evaluate(() => ({
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
      canonicals: [...document.querySelectorAll('link[rel="canonical"]')].map((l) => l.getAttribute("href") ?? ""),
      robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "",
    }));
    expect(head.title.trim(), "<title>").not.toBe("");
    expect(head.description.trim().length, "meta description").toBeGreaterThan(20);

    if (route.canonical === null) {
      expect(head.canonicals, "no canonical").toEqual([]);
    } else {
      expect(head.canonicals, "exactly one canonical").toHaveLength(1);
      const href = head.canonicals[0];
      expect(href, "canonical is absolute").toMatch(/^https?:\/\//);
      const want = new URL(route.canonical ?? route.path, siteOrigin(baseURL));
      const got = new URL(href);
      expect(got.origin, "canonical origin").toBe(want.origin);
      expect(got.pathname + got.search, "canonical path").toBe(want.pathname + want.search);
    }
    if (route.noindex) expect(head.robots).toContain("noindex");
    else expect(head.robots, "indexable page").not.toContain("noindex");
  });
}
