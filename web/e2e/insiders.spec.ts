import { expect, test, visit } from "./fixtures";
import { signLoginToken } from "../lib/auth";

const SECRET = process.env.ALERTS_SECRET?.trim();
const MEMORY = process.env.WHALE_TEST_MEMORY_STORE === "1" && !!SECRET && SECRET.length >= 16;
const PROFILE = "/insiders/rothblatt-martine-a-0001106578";

test("an insider has a page of their own: companies, trades, and the follow button", async ({ page }) => {
  await visit(page, PROFILE);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("ROTHBLATT MARTINE A");
  await expect(page.getByRole("heading", { name: "Companies" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Every stored trade" })).toBeVisible();
  await expect(page.locator("button[data-follow-kind='insider'][data-follow-id='0001106578']")).toBeVisible();
});

test("the old insider filter and a stale name both reach the insider's page", async ({ page }) => {
  const res = await page.request.get("/insiders?cik=0001106578", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers()["location"]).toMatch(/\/insiders\/rothblatt-martine-a-0001106578$/);
  // Names link to the profile from the insider list.
  await visit(page, "/insiders");
  await expect(page.locator(`a[href^="/insiders/"][href$="-0001106578"]`).first()).toBeVisible();
});

test("rankings has an insider track record of its own", async ({ page }) => {
  await visit(page, "/rankings?view=insiders");
  await expect(page.getByRole("heading", { level: 1, name: "Insider track record" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Rankings" }).getByRole("link", { name: "Insiders" })
  ).toHaveAttribute("aria-current", "page");
});

test.describe("signed in", () => {
  test.skip(!MEMORY, "needs WHALE_TEST_MEMORY_STORE=1 and ALERTS_SECRET on the server");

  test("follow an insider and see them on the dashboard", async ({ page }) => {
    const email = `e2e-insider-${Date.now()}@example.com`;
    await visit(page, `/api/auth/email/callback?token=${encodeURIComponent(signLoginToken(email, SECRET!))}&next=${encodeURIComponent(PROFILE)}`);
    const follow = page.locator("button[data-follow-kind='insider'][data-follow-id='0001106578']");
    await follow.click();
    await expect(follow).toHaveAttribute("aria-pressed", "true");
    await visit(page, "/account");
    await expect(page.locator("[data-followed-insider='0001106578']")).toContainText("ROTHBLATT MARTINE A");
    await page.getByRole("button", { name: "Unfollow ROTHBLATT MARTINE A" }).click();
    await expect(page.locator("[data-followed-insider='0001106578']")).toHaveCount(0);
  });
});
