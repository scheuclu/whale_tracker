import { expect, test, visit } from "./fixtures";

test("the landing page says what the site is and offers alerts", async ({ page }) => {
  await visit(page, "/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("See what Congress and insiders are trading.");
  const cta = page.getByRole("link", { name: "Get free alerts" }).first();
  await expect(cta).toHaveAttribute("href", "/signin?next=%2Faccount");
  await expect(page.getByRole("link", { name: "Browse the live feed" })).toHaveAttribute("href", "/feed");
  // The hero art loads through the image optimizer and keeps its satire caption.
  const hero = page.getByRole("img", { name: /^Satirical illustration/ });
  await expect(hero).toBeVisible();
  await expect.poll(() => hero.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByText("Satirical illustration, AI-generated.", { exact: false })).toBeVisible();
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

test("People is one section: members and insiders, switched on the page", async ({ page }) => {
  const people = (p: typeof page) => p.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "People" });
  for (const path of ["/politicians", "/members/nancy-pelosi-p000197", "/insiders", "/insiders/rothblatt-martine-a-0001106578"]) {
    await visit(page, path);
    await expect(people(page), path).toHaveAttribute("aria-current", "page");
  }
  await visit(page, "/politicians");
  const sw = page.getByRole("navigation", { name: "People" });
  await expect(sw.getByRole("link", { name: "Congress", exact: true })).toHaveAttribute("aria-current", "page");
  await sw.getByRole("link", { name: "Insiders", exact: true }).click();
  await expect(page).toHaveURL(/\/insiders$/);
  await expect(
    page.getByRole("navigation", { name: "People" }).getByRole("link", { name: "Insiders", exact: true })
  ).toHaveAttribute("aria-current", "page");
});
