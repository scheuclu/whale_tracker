import type { Page } from "@playwright/test";
import { expect, test, visit } from "./fixtures";

test.describe.configure({ mode: "parallel" });

/** The numbers in the column a sorted header sits over, top to bottom. */
async function sortedColumn(page: Page, table: string) {
  return page.locator(table).evaluate((t) => {
    const ths = [...t.querySelectorAll("thead th")];
    const idx = ths.findIndex((th) => th.hasAttribute("aria-sort"));
    const dir = idx >= 0 ? ths[idx].getAttribute("aria-sort") : null;
    const values = [...t.querySelectorAll("tbody tr")]
      .map((tr) => tr.children[idx]?.textContent ?? "")
      .map((s) => Number(s.replace(/[^\d.]/g, "")));
    return { idx, dir, values };
  });
}

function expectOrdered(values: number[], dir: string | null) {
  expect(values.length).toBeGreaterThan(5);
  const sorted = [...values].sort((a, b) => (dir === "ascending" ? a - b : b - a));
  expect(values).toEqual(sorted);
}

/** /politicians' member table, sorted by the Trades header. */
async function sortByTrades(page: Page) {
  await visit(page, "/politicians");
  const table = "table:has(thead a[href*='sort=trades'])";
  const header = page.locator("thead a[href*='sort=trades']").first();
  await header.click();
  await expect(page).toHaveURL(/[?&]sort=trades\b/);
  await expect(page.locator("th[aria-sort] a[href*='sort=trades']")).toHaveCount(1);
  const first = await sortedColumn(page, table);
  expect(first.dir).toBe("descending");
  expectOrdered(first.values, first.dir);

  // Clicking the active header again reverses it.
  await page.locator("thead a[href*='sort=trades']").first().click();
  await expect(page).toHaveURL(/[?&]dir=asc\b/);
  await expect(page.locator("th[aria-sort='ascending']")).toHaveCount(1);
  const second = await sortedColumn(page, table);
  expectOrdered(second.values, second.dir);
}

test("sorting a table header (JavaScript on)", async ({ page }) => {
  await sortByTrades(page);
});

/**
 * Without JavaScript the streamed page content is revealed by the
 * <noscript> stylesheet in app/no-script.tsx (React's swap script never
 * runs). These fail if a React/Next upgrade changes the streaming markup
 * that stylesheet keys on.
 */
test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("sorting a table header still works", async ({ page }) => {
    await page.goto("/politicians");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 3_000 });
    await sortByTrades(page);
  });
  test("the Buys/Sells filter still works", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 3_000 });
    await page.getByRole("navigation", { name: "Trade direction" }).getByRole("link", { name: "Sells" }).click();
    await expect(page).toHaveURL(/[?&]action=sell\b/);
    const labels = await page.locator("li.feed-row > span:first-child").allTextContents();
    expect(labels.length).toBeGreaterThan(5);
    for (const l of labels) expect(l).toMatch(/^Sell/);
  });
});

test("the feed's Buys/Sells filter", async ({ page }) => {
  await visit(page, "/");
  const direction = page.getByRole("navigation", { name: "Trade direction" });
  for (const [name, param, label] of [
    ["Buys", "buy", /^Buy$/],
    ["Sells", "sell", /^Sell/],
  ] as const) {
    await direction.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]action=${param}\\b`));
    await expect(direction.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    const labels = await page.locator("li.feed-row > span:first-child").allTextContents();
    expect(labels.length, `${name}: rows shown`).toBeGreaterThan(5);
    for (const l of labels) expect(l.trim(), `${name} shows only ${param} rows`).toMatch(label);
  }
  await direction.getByRole("link", { name: "All" }).click();
  await expect(page).not.toHaveURL(/action=/);
});

test("theme toggle switches and persists", async ({ page }) => {
  await visit(page, "/");
  const html = page.locator("html");
  await expect(html).not.toHaveClass(/\bdark\b/);
  const toggle = page.getByRole("button", { name: /switch to dark theme/i });
  await toggle.click();
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(page.getByRole("button", { name: /switch to light theme/i })).toBeVisible();
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  await page.getByRole("button", { name: /switch to light theme/i }).click();
  await expect(html).not.toHaveClass(/\bdark\b/);
});

/**
 * KNOWN BUG (expected to fail until fixed): on a member page a trade row's
 * tag group (option badge · sector · owner, app/trade-row.tsx) is
 * `shrink-0 whitespace-nowrap`, so an option row pushes the page 18px past
 * a 390px screen on /members/nancy-pelosi-p000197.
 */
const KNOWN_OVERFLOW: Record<string, string> = {};

test.describe("phone width (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const path of ["/", "/politicians", "/members/nancy-pelosi-p000197", "/tickers/MSFT", "/insiders", "/trends", "/methodology"]) {
    test(`no horizontal overflow on ${path}`, async ({ page }) => {
      test.fail(path in KNOWN_OVERFLOW, KNOWN_OVERFLOW[path]);
      await visit(page, path);
      const { scroll, client } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(scroll, "page wider than the viewport").toBeLessThanOrEqual(client);
      const nav = page.getByRole("navigation", { name: "Sections" });
      await expect(nav).toBeVisible();
      const box = await nav.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(client + 0.5);
    });
  }
});
