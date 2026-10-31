import { expect, test, visit } from "./fixtures";
import { signLoginToken } from "../lib/auth";

/**
 * Following needs an account, and the account has a dashboard. The signed-in
 * half runs only where the server keeps accounts in memory
 * (`WHALE_TEST_MEMORY_STORE=1` plus an `ALERTS_SECRET`, as in CI): the test
 * mints the emailed sign-in link itself, so no mail is sent.
 */
const SECRET = process.env.ALERTS_SECRET?.trim();
const MEMORY = process.env.WHALE_TEST_MEMORY_STORE === "1" && !!SECRET && SECRET.length >= 16;

test("signed out, Follow asks you to sign in and remembers what you wanted", async ({ page }) => {
  await visit(page, "/members/nancy-pelosi-p000197");
  const follow = page.locator("button[data-follow-kind='member'][data-follow-id='P000197']");
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await follow.click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fmembers%2Fnancy-pelosi-p000197$/);
  const pending = await page.evaluate(() => localStorage.getItem("fatcat_pending_follow_v1"));
  expect(JSON.parse(pending!)).toMatchObject({ members: ["P000197"] });
  // No watchlist exists without an account.
  await expect(page.getByRole("link", { name: /watchlist \(\d+ followed\)/i })).toHaveCount(0);
});

test("the old watchlist page now opens the dashboard", async ({ page }) => {
  const res = await page.request.get("/watchlist?status=unsubscribed", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers()["location"]).toBe("/account?status=unsubscribed");
});

test.describe("signed in", () => {
  test.skip(!MEMORY, "needs WHALE_TEST_MEMORY_STORE=1 and ALERTS_SECRET on the server");

  test("sign in by email link, follow, see it on the dashboard, unfollow, sign out", async ({ page }) => {
    const email = `e2e-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`;

    // The follow that sent the reader to sign in is applied on the way back.
    await visit(page, "/tickers/MSFT");
    await page.locator("button[data-follow-kind='ticker'][data-follow-id='MSFT']").click();
    await expect(page).toHaveURL(/\/signin\?next=%2Ftickers%2FMSFT$/);
    const token = signLoginToken(email, SECRET!);
    await visit(page, `/api/auth/email/callback?token=${encodeURIComponent(token)}&next=%2Ftickers%2FMSFT`);
    await expect(page).toHaveURL(/\/tickers\/MSFT$/);
    const msft = page.locator("button[data-follow-kind='ticker'][data-follow-id='MSFT']");
    await expect(msft).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: `Your account (${email})` })).toBeVisible();

    // A second follow, made signed in.
    await visit(page, "/members/nancy-pelosi-p000197");
    const pelosi = page.locator("button[data-follow-kind='member'][data-follow-id='P000197']");
    await pelosi.click();
    await expect(pelosi).toHaveAttribute("aria-pressed", "true");

    // The dashboard, rendered on the server from the session.
    await visit(page, "/account");
    await expect(page.getByRole("heading", { level: 1, name: "Your dashboard" })).toBeVisible();
    await expect(page.getByText(email).first()).toBeVisible();
    await expect(page.locator("[data-followed-ticker='MSFT']")).toBeVisible();
    await expect(page.locator("[data-followed-member='P000197']")).toContainText("Pelosi");
    await expect(page.getByRole("heading", { name: "Congressional trades" })).toBeVisible();
    const res = await page.request.get("/account");
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["cdn-cache-control"]).toBeUndefined();

    // Settings save as they change.
    const clusters = page.getByLabel(/Cluster alerts/);
    await clusters.check();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/Cluster alerts/)).toBeChecked();

    // Unfollow from the dashboard.
    await page.getByRole("button", { name: "Unfollow MSFT" }).click();
    await expect(page.locator("[data-followed-ticker='MSFT']")).toHaveCount(0);
    await expect(page.locator("[data-followed-member='P000197']")).toBeVisible();

    // Sign out: back to signed out everywhere.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    await visit(page, "/account");
    await expect(page.getByRole("heading", { level: 1, name: "Your dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await expect(page.getByText(email)).toHaveCount(0);
  });

  test("the admin page lists accounts to an ADMIN_EMAILS address and to no one else", async ({ page }) => {
    const admin = process.env.ADMIN_EMAILS?.split(/[\s,]+/).find((e) => e.includes("@"));
    test.skip(!admin, "needs ADMIN_EMAILS on the server");
    const reader = `e2e-reader-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`;

    // A reader who follows something, and is refused the page.
    await visit(page, `/api/auth/email/callback?token=${encodeURIComponent(signLoginToken(reader, SECRET!))}&next=%2Ftickers%2FMSFT`);
    const msft = page.locator("button[data-follow-kind='ticker'][data-follow-id='MSFT']");
    await msft.click();
    await expect(msft).toHaveAttribute("aria-pressed", "true");
    await visit(page, "/admin");
    await expect(page.getByText("which is not an admin address")).toBeVisible();
    await expect(page.locator("[data-admin-account]")).toHaveCount(0);

    // The operator sees that reader and what they follow, uncached.
    await visit(page, `/api/auth/email/callback?token=${encodeURIComponent(signLoginToken(admin!, SECRET!))}&next=%2Fadmin`);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible();
    const row = page.locator(`[data-admin-account='${reader}']`);
    await expect(row).toContainText("MSFT");
    await expect(row).toContainText("Gets the digest");
    const res = await page.request.get("/admin");
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["cdn-cache-control"]).toBeUndefined();
  });
});
