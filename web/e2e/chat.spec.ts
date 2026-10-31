import { expect, test, visit } from "./fixtures";
import { signLoginToken } from "../lib/auth";

/**
 * Ask FatCat (/chat). Signed out it asks you to sign in; signed in it
 * answers through `/api/chat`. The signed-in half needs the in-memory
 * account store and the scripted model (`WHALE_TEST_FAKE_CHAT=1`, which
 * searches for the question's last word and answers from what it found), so
 * the route, the tool loop over the committed database, the daily limit and
 * the page run end to end with no Gemini key. CI sets `CHAT_DAILY_LIMIT=3`.
 */
const SECRET = process.env.ALERTS_SECRET?.trim();
const MEMORY = process.env.WHALE_TEST_MEMORY_STORE === "1" && !!SECRET && SECRET.length >= 16;
const FAKE = process.env.WHALE_TEST_FAKE_CHAT === "1";
const LIMIT = Number(process.env.CHAT_DAILY_LIMIT ?? 20);

test("signed out, the chat asks you to sign in and keeps the question you picked", async ({ page }) => {
  await visit(page, "/chat");
  await expect(page.getByRole("heading", { level: 1, name: "Ask FatCat" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to ask" })).toBeVisible();
  await page.getByRole("button", { name: "What has Nancy Pelosi traded recently?" }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fchat$/);
  const draft = await page.evaluate(() => sessionStorage.getItem("fatcat_chat_draft_v1"));
  expect(draft).toBe("What has Nancy Pelosi traded recently?");
});

test("the masthead links to the chat", async ({ page }) => {
  await visit(page, "/feed");
  await page.getByRole("link", { name: /Ask FatCat/ }).first().click();
  await expect(page).toHaveURL(/\/chat$/);
});

test("the chat API refuses cross-site and signed-out requests, and is never cached", async ({ page, baseURL }) => {
  const get = await page.request.get("/api/chat");
  expect(get.headers()["cache-control"]).toContain("no-store");
  expect([200, 401]).toContain(get.status());
  const cross = await page.request.post("/api/chat", {
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    data: { messages: [{ role: "user", text: "hi" }] },
  });
  expect(cross.status()).toBe(403);
  const signedOut = await page.request.post("/api/chat", {
    headers: { Origin: new URL(baseURL!).origin },
    data: { messages: [{ role: "user", text: "hi" }] },
  });
  expect([401, 503]).toContain(signedOut.status());
});

test.describe("signed in", () => {
  test.skip(!MEMORY || !FAKE, "needs WHALE_TEST_MEMORY_STORE=1, ALERTS_SECRET and WHALE_TEST_FAKE_CHAT=1 on the server");

  test("ask, follow a link in the answer, come back to the conversation, run out of messages", async ({ page, baseURL }) => {
    const email = `e2e-chat-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`;
    await visit(page, `/api/auth/email/callback?token=${encodeURIComponent(signLoginToken(email, SECRET!))}&next=%2Fchat`);
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator("[data-chat-quota]")).toHaveText(`${LIMIT} of ${LIMIT} messages left today`);

    // The scripted model looks up the question's last word.
    const input = page.getByLabel("Your question");
    await input.fill("Tell me about pelosi");
    await input.press("Enter");
    const answer = page.locator("[data-chat-answer]").last();
    await expect(answer).toContainText("Scripted answer for pelosi");
    await expect(answer).toContainText("Looked up: “pelosi”");
    await expect(page.locator("[data-chat-quota]")).toHaveText(`${LIMIT - 1} of ${LIMIT} messages left today`);

    // Links in answers stay on the site, and the conversation survives the visit.
    const link = answer.getByRole("link", { name: "Nancy Pelosi" });
    await expect(link).toHaveAttribute("href", "/members/nancy-pelosi-p000197");
    await link.click();
    await expect(page).toHaveURL(/\/members\/nancy-pelosi-p000197$/);
    await page.goBack();
    await expect(page.locator("[data-chat-answer]").last()).toContainText("Scripted answer for pelosi");

    // Spend the rest of the day's messages.
    for (let i = 1; i < LIMIT; i++) {
      await input.fill(`and msft ${i}`);
      await input.press("Enter");
      await expect(page.locator("[data-chat-answer]")).toHaveCount(i + 1);
      await expect(page.locator("[data-chat-answer]").last()).toContainText("Scripted answer");
    }
    await expect(page.locator("[data-chat-quota]")).toContainText(`You've used today's ${LIMIT} messages`);
    await expect(input).toBeDisabled();
    const over = await page.request.post("/api/chat", {
      headers: { Origin: new URL(baseURL!).origin },
      data: { messages: [{ role: "user", text: "one more" }] },
    });
    expect(over.status()).toBe(429);
    expect((await over.json()).code).toBe("limit");

    // A new chat clears the tab's copy; signing out clears it too.
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.locator("[data-chat-answer]")).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("fatcat_chat_v1"))).toBeNull();
  });
});
