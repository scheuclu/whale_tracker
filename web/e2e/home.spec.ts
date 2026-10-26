import { expect, test, visit } from "./fixtures";

test("the landing page says what the site is and offers alerts", async ({ page }) => {
  await visit(page, "/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("See what Congress and insiders are trading.");
  const cta = page.getByRole("link", { name: "Get free alerts" }).first();
  await expect(cta).toHaveAttribute("href", "/signin?next=%2Faccount");
  await expect(page.getByRole("link", { name: "Browse the live feed" })).toHaveAttribute("href", "/feed");
  // Both sources, side by side and apart.
  await expect(page.getByRole("heading", { name: "Congress", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Corporate insiders", exact: true })).toBeVisible();
  // No section tab is active on the landing page; the brand is its link.
  await expect(page.getByRole("navigation", { name: "Sections" }).locator("[aria-current=page]")).toHaveCount(0);
});

test("a feed link from before the landing page still opens the feed", async ({ page }) => {
  for (const q of ["action=sell", "watch=NVDA", "offset=120"]) {
    const res = await page.request.get(`/?${q}`, { maxRedirects: 0 });
    expect(res.status(), q).toBe(308);
    expect(res.headers()["location"], q).toBe(`/feed?${q}`);
  }
  // `?member=` keeps going to the member's own page.
  const member = await page.request.get("/?member=Nancy%20Pelosi", { maxRedirects: 0 });
  expect(member.status()).toBe(308);
  expect(member.headers()["location"]).toContain("/members/");
});
