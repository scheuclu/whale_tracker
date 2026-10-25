import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMemorySubscriptionBackend,
  getSubscription,
  listVerifiedSubscriptions,
  markDigestSent,
  unsubscribeAll,
  upsertSubscription,
  verifySubscriber,
} from "./subscription-store.ts";

const SECRET = "test-alerts-secret-at-least-16-bytes";

describe("subscription-store", () => {
  it("creates, merges, verifies, and unsubscribes a subscriber", async () => {
    const backend = createMemorySubscriptionBackend();

    const s1 = await upsertSubscription(backend, SECRET, {
      email: "Reader@Example.com",
      members: ["p000197"],
      tickers: ["nvda"],
    });
    assert.equal(s1.email, "reader@example.com");
    assert.equal(s1.verified, false);
    assert.deepEqual(s1.members, ["P000197"]);
    assert.deepEqual(s1.tickers, ["NVDA"]);

    // Unverified subscribers do not appear in verified dispatch list
    assert.equal((await listVerifiedSubscriptions(backend)).length, 0);

    // Verify subscriber
    const verified = await verifySubscriber(backend, SECRET, "reader@example.com");
    assert.equal(verified?.verified, true);
    assert.equal((await listVerifiedSubscriptions(backend)).length, 1);

    // Merge additional ticker while preserving verified status and existing items
    const merged = await upsertSubscription(backend, SECRET, {
      email: "reader@example.com",
      tickers: ["msft"],
      clusters: true,
      merge: true,
    });
    assert.equal(merged.verified, true);
    assert.deepEqual(merged.members, ["P000197"]);
    assert.deepEqual(merged.tickers, ["NVDA", "MSFT"]);
    assert.equal(merged.clusters, true);

    // Exact preference replacement (merge: false)
    const replaced = await upsertSubscription(backend, SECRET, {
      email: "reader@example.com",
      members: [],
      tickers: ["AAPL"],
      clusters: false,
      weeklyDigest: true,
      merge: false,
    });
    assert.deepEqual(replaced.members, []);
    assert.deepEqual(replaced.tickers, ["AAPL"]);
    assert.equal(replaced.clusters, false);
    assert.equal(replaced.weeklyDigest, true);

    // Mark digest sent
    await markDigestSent(backend, SECRET, "reader@example.com", "2026-10-25");
    const afterMark = await getSubscription(backend, SECRET, "reader@example.com");
    assert.equal(afterMark?.lastSentDate, "2026-10-25");

    // Unsubscribe removes record
    await unsubscribeAll(backend, SECRET, "reader@example.com");
    assert.equal(await getSubscription(backend, SECRET, "reader@example.com"), null);
    assert.equal((await listVerifiedSubscriptions(backend)).length, 0);
  });
});
