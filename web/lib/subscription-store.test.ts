import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMemorySubscriptionBackend,
  getSubscription,
  listVerifiedSubscriptions,
  deleteSubscription,
  markDigestSent,
  parseStoredSubscription,
  signInAccount,
  stopEmails,
  updateAccountSettings,
  updateAccountWatch,
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

    // An unsubscribe link stops the emails and keeps the record
    await stopEmails(backend, SECRET, "reader@example.com");
    const stopped = await getSubscription(backend, SECRET, "reader@example.com");
    assert.equal(stopped?.emailAlerts, false);
    assert.deepEqual(stopped?.tickers, ["AAPL"]);
    assert.equal((await listVerifiedSubscriptions(backend)).length, 0);

    // Deleting removes it
    await deleteSubscription(backend, SECRET, "reader@example.com");
    assert.equal(await getSubscription(backend, SECRET, "reader@example.com"), null);
  });

  it("reads a record from before accounts as still emailed", () => {
    const old = parseStoredSubscription(
      JSON.stringify({
        v: 1,
        id: "0".repeat(32),
        email: "old@example.com",
        verified: true,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
        members: [],
        tickers: ["NVDA"],
        clusters: false,
        weeklyDigest: false,
        lastSentDate: null,
      })
    );
    assert.equal(old?.emailAlerts, true);
  });

  it("signs in: creates a verified account, merges the device's follows, keeps settings", async () => {
    const backend = createMemorySubscriptionBackend();
    const created = await signInAccount(backend, SECRET, "New@Example.com", { tickers: ["nvda"] });
    assert.equal(created.verified, true);
    assert.equal(created.emailAlerts, true);
    assert.equal(created.clusters, false);
    assert.deepEqual(created.tickers, ["NVDA"]);
    assert.equal((await listVerifiedSubscriptions(backend)).length, 1);

    // An unsubscribed reader signing in again stays unsubscribed
    await stopEmails(backend, SECRET, "new@example.com");
    const again = await signInAccount(backend, SECRET, "new@example.com", { members: ["P000197"] });
    assert.equal(again.emailAlerts, false);
    assert.deepEqual(again.members, ["P000197"]);
    assert.deepEqual(again.tickers, ["NVDA"]);
    assert.equal(again.createdAt, created.createdAt);

    // A pending double-opt-in subscriber is verified by signing in
    await upsertSubscription(backend, SECRET, { email: "pending@example.com", tickers: ["MSFT"] });
    const verified = await signInAccount(backend, SECRET, "pending@example.com");
    assert.equal(verified.verified, true);
    assert.deepEqual(verified.tickers, ["MSFT"]);
  });

  it("adds and removes follows item by item and changes settings", async () => {
    const backend = createMemorySubscriptionBackend();
    await signInAccount(backend, SECRET, "reader@example.com", { tickers: ["NVDA", "MSFT"] });
    const changed = await updateAccountWatch(backend, SECRET, "reader@example.com", {
      add: { members: ["p000197"], tickers: ["AAPL", "not a ticker!"] },
      remove: { tickers: ["MSFT"] },
    });
    assert.deepEqual(changed?.members, ["P000197"]);
    assert.deepEqual(changed?.tickers, ["NVDA", "AAPL"]);

    const settings = await updateAccountSettings(backend, SECRET, "reader@example.com", { clusters: true });
    assert.equal(settings?.clusters, true);
    assert.equal(settings?.emailAlerts, true);

    // No account, nothing created
    assert.equal(await updateAccountWatch(backend, SECRET, "ghost@example.com", { add: { tickers: ["NVDA"] } }), null);
    assert.equal(await updateAccountSettings(backend, SECRET, "ghost@example.com", { clusters: true }), null);
    assert.equal(await getSubscription(backend, SECRET, "ghost@example.com"), null);
  });
});
