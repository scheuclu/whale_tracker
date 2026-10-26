import { expect, test, visit } from "./fixtures";

test("rankings: one page, four views, each a link", async ({ page }) => {
  await visit(page, "/rankings");
  const nav = page.getByRole("navigation", { name: "Rankings" });
  for (const [name, href] of [
    ["Track record", "/rankings"],
    ["Most active", "/rankings?view=active"],
    ["Late filers", "/rankings?view=late"],
    ["Trends", "/rankings?view=trends"],
  ] as const) {
    await expect(nav.getByRole("link", { name })).toHaveAttribute("href", href);
  }
  await expect(nav.getByRole("link", { name: "Track record" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Most active" }).click();
  await expect(page).toHaveURL(/\/rankings\?view=active$/);
  await expect(page.getByRole("heading", { level: 1, name: "Most active" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: "Rankings" })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

test("the old track record, late and trends URLs open their ranking", async ({ page }) => {
  for (const [from, to] of [
    ["/politicians?view=track", "/rankings?view=track"],
    ["/politicians?view=track&h=30", "/rankings?view=track&h=30"],
    ["/politicians?view=late", "/rankings?view=late"],
    ["/trends", "/rankings?view=trends"],
    ["/trends?w=24", "/rankings?view=trends&w=24"],
  ]) {
    const res = await page.request.get(from, { maxRedirects: 0 });
    expect(res.status(), from).toBe(308);
    const got = new URL(res.headers()["location"], "http://x");
    const want = new URL(to, "http://x");
    expect(got.pathname, from).toBe(want.pathname);
    expect(Object.fromEntries(got.searchParams), from).toEqual(Object.fromEntries(want.searchParams));
  }
  // The roster itself stays where it is.
  const roster = await page.request.get("/politicians", { maxRedirects: 0 });
  expect(roster.status()).toBe(200);
});
