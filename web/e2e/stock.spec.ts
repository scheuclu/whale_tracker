import { expect, test, visit } from "./fixtures";

test("one stock page carries both sources, side by side and apart", async ({ page }) => {
  await visit(page, "/tickers/MSFT");
  const lanes = page.getByRole("region", { name: "Who trades it" });
  await expect(lanes.getByText("Congress · STOCK Act")).toBeVisible();
  await expect(lanes.getByText("Corporate insiders · SEC Form 4")).toBeVisible();
  await expect(page.locator("section#congress").getByRole("heading", { level: 2, name: "Congress", exact: true })).toBeVisible();
  await expect(
    page.locator("section#insiders").getByRole("heading", { level: 2, name: "Corporate insiders", exact: true })
  ).toBeVisible();
});

test("a stock only insiders traded still has its page", async ({ page }) => {
  await visit(page, "/tickers/BBD");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("BBD");
  await expect(page.getByText(/No member of Congress has disclosed a trade in BBD/)).toBeVisible();
  await expect(page.locator("section#insiders")).toBeVisible();
  await expect(page.locator("section#congress")).toHaveCount(0);
});

test("the old insider issuer URL opens the stock page's insider section", async ({ page }) => {
  const res = await page.request.get("/insiders?t=bbd", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers()["location"]).toMatch(/\/tickers\/BBD#insiders$/);
});
