import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHAT_TOTALS_PATH,
  chatUsagePathname,
  nextResetIso,
  readChatQuota,
  readChatTotals,
  recordChatTokens,
  refundChatMessage,
  reserveChatMessage,
} from "./chat-usage.ts";
import { createMemorySubscriptionBackend, deleteSubscription, signInAccount } from "./subscription-store.ts";
import { emailSubscriberKey } from "./subscription-token.ts";

const SECRET = "test-alerts-secret-at-least-16-bytes";
const ID = "0123456789abcdef0123456789abcdef";
const LIMITS = { dailyLimit: 3, dailyTokenBudget: 1_000 };
const DAY1 = new Date("2026-10-31T09:00:00Z");
const DAY2 = new Date("2026-11-01T00:00:01Z");

describe("chat-usage", () => {
  it("spends messages up to the daily limit, then refuses and counts the refusal", async () => {
    const b = createMemorySubscriptionBackend();
    for (let i = 1; i <= 3; i++) {
      const r = await reserveChatMessage(b, ID, LIMITS, DAY1);
      assert.equal(r.ok, true);
      assert.equal(r.quota.used, i);
      assert.equal(r.quota.remaining, 3 - i);
    }
    const refused = await reserveChatMessage(b, ID, LIMITS, DAY1);
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "limit");
    assert.equal(refused.quota.remaining, 0);
    const totals = await readChatTotals(b, DAY1);
    assert.equal(totals.messages, 3);
    assert.equal(totals.refusedLimit, 1);
  });

  it("starts again at midnight UTC", async () => {
    const b = createMemorySubscriptionBackend();
    for (let i = 0; i < 3; i++) await reserveChatMessage(b, ID, LIMITS, DAY1);
    assert.equal((await reserveChatMessage(b, ID, LIMITS, DAY1)).ok, false);
    const next = await reserveChatMessage(b, ID, LIMITS, DAY2);
    assert.equal(next.ok, true);
    assert.equal(next.quota.used, 1);
    assert.equal(nextResetIso(DAY1), "2026-11-01T00:00:00.000Z");
    assert.equal((await readChatTotals(b, DAY2)).messages, 1);
  });

  it("refuses everyone once today's token budget is spent", async () => {
    const b = createMemorySubscriptionBackend();
    const other = "fedcba9876543210fedcba9876543210";
    assert.equal((await reserveChatMessage(b, ID, LIMITS, DAY1)).ok, true);
    await recordChatTokens(b, ID, 1_000, DAY1);
    const r = await reserveChatMessage(b, other, LIMITS, DAY1);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "budget");
    // The budget refusal spends nothing of the reader's own allowance.
    assert.equal(r.quota.used, 0);
    const totals = await readChatTotals(b, DAY1);
    assert.equal(totals.tokens, 1_000);
    assert.equal(totals.refusedBudget, 1);
    // A new day, a new budget.
    assert.equal((await reserveChatMessage(b, other, LIMITS, DAY2)).ok, true);
  });

  it("gives a message back when no answer came, never below zero", async () => {
    const b = createMemorySubscriptionBackend();
    await reserveChatMessage(b, ID, LIMITS, DAY1);
    await refundChatMessage(b, ID, DAY1);
    assert.equal((await readChatQuota(b, ID, 3, DAY1)).used, 0);
    await refundChatMessage(b, ID, DAY1);
    assert.equal((await readChatQuota(b, ID, 3, DAY1)).used, 0);
    assert.equal((await readChatTotals(b, DAY1)).messages, 0);
  });

  it("concurrent messages from one account cannot spend more than the limit", async () => {
    const b = createMemorySubscriptionBackend();
    await reserveChatMessage(b, ID, LIMITS, DAY1); // the counter exists, so every write is ETag-guarded
    const results = await Promise.all(Array.from({ length: 6 }, () => reserveChatMessage(b, ID, LIMITS, DAY1)));
    assert.equal(results.filter((r) => r.ok).length, 2);
    assert.equal((await readChatQuota(b, ID, 3, DAY1)).used, 3);
  });

  it("stores counts keyed by the account hash, never an address, and goes with the account", async () => {
    const b = createMemorySubscriptionBackend();
    const email = "reader@example.com";
    await signInAccount(b, SECRET, email);
    const id = emailSubscriberKey(email, SECRET);
    await reserveChatMessage(b, id, LIMITS, DAY1);
    await recordChatTokens(b, id, 42, DAY1);
    const stored = await b.readByPath(chatUsagePathname(id));
    assert.ok(stored);
    assert.deepEqual(JSON.parse(stored.body), { v: 1, day: "2026-10-31", messages: 1, tokens: 42 });
    assert.ok(!stored.body.includes("example.com"));
    assert.ok(!(await b.readByPath(CHAT_TOTALS_PATH))!.body.includes("example.com"));

    await deleteSubscription(b, SECRET, email);
    assert.equal(await b.readByPath(chatUsagePathname(id)), null);
  });

  it("refuses a malformed key rather than writing outside its folder", () => {
    assert.throws(() => chatUsagePathname("../subscriptions/x"));
    assert.throws(() => chatUsagePathname("_total"));
  });
});
