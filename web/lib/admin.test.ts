import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adminEmails, isAdminEmail, sortAccounts, summarizeAccounts } from "./admin.ts";
import {
  createMemorySubscriptionBackend,
  listAllSubscriptions,
  listVerifiedSubscriptions,
  signInAccount,
  stopEmails,
  upsertSubscription,
  type StoredSubscription,
} from "./subscription-store.ts";

const SECRET = "test-alerts-secret-at-least-16-bytes";

function account(over: Partial<StoredSubscription> & { email: string; createdAt: string }): StoredSubscription {
  return {
    v: 1,
    id: "0".repeat(32),
    verified: true,
    updatedAt: over.createdAt,
    members: [],
    tickers: [],
    insiders: [],
    clusters: false,
    weeklyDigest: false,
    emailAlerts: true,
    lastSentDate: null,
    ...over,
  };
}

describe("admin allowlist", () => {
  it("fails closed when ADMIN_EMAILS is unset or blank", () => {
    assert.equal(adminEmails({}).size, 0);
    assert.equal(isAdminEmail("op@example.com", {}), false);
    // GitHub Actions and Vercel pass an undefined variable as "".
    assert.equal(isAdminEmail("op@example.com", { ADMIN_EMAILS: "" }), false);
    assert.equal(isAdminEmail("op@example.com", { ADMIN_EMAILS: "  ,  " }), false);
  });

  it("matches normalized addresses separated by commas or whitespace", () => {
    const env = { ADMIN_EMAILS: " Op@Example.com,second@example.org\nthird@example.net " };
    assert.deepEqual([...adminEmails(env)], ["op@example.com", "second@example.org", "third@example.net"]);
    assert.equal(isAdminEmail("OP@example.com", env), true);
    assert.equal(isAdminEmail("third@example.net", env), true);
    assert.equal(isAdminEmail("reader@example.com", env), false);
    assert.equal(isAdminEmail(null, env), false);
  });

  it("ignores entries that are not addresses rather than matching them", () => {
    const env = { ADMIN_EMAILS: "*,not-an-email,op@example.com" };
    assert.deepEqual([...adminEmails(env)], ["op@example.com"]);
    assert.equal(isAdminEmail("*", env), false);
  });
});

describe("summarizeAccounts", () => {
  // Saturday 2026-10-31, 12:00 UTC: its week began Monday 2026-10-26.
  const now = new Date("2026-10-31T12:00:00Z");
  const accounts = [
    account({ email: "a@example.com", createdAt: "2026-10-30T09:00:00Z", members: ["P000197"], tickers: ["MSFT", "NVDA"] }),
    account({ email: "b@example.com", createdAt: "2026-10-26T00:00:00Z", tickers: ["MSFT"], clusters: true }),
    account({ email: "c@example.com", createdAt: "2026-10-25T23:59:59Z", emailAlerts: false, tickers: ["MSFT"] }),
    account({ email: "d@example.com", createdAt: "2026-10-10T00:00:00Z", verified: false, members: ["P000197"] }),
    account({ email: "e@example.com", createdAt: "2026-06-01T00:00:00Z", weeklyDigest: true, insiders: ["0001106578"] }),
    account({ email: "f@example.com", createdAt: "2026-10-29T00:00:00Z" }),
  ];
  const s = summarizeAccounts(accounts, now, 4);

  it("counts states the way the digest sender reads them", () => {
    assert.equal(s.total, 6);
    assert.equal(s.verified, 5);
    assert.equal(s.unsubscribed, 1);
    // a, b, e: c is unsubscribed, d unconfirmed, f follows nothing and wants nothing.
    assert.equal(s.receivingDigest, 3);
    assert.equal(s.followingSomething, 5);
    assert.equal(s.clusters, 1);
    assert.equal(s.weeklyDigest, 1);
  });

  it("counts recent signups by age and by UTC week starting Monday", () => {
    assert.equal(s.newLast7Days, 4); // a, b, c, f
    assert.equal(s.newLast30Days, 5); // and d
    // e (June) is before the four weeks shown and counts in none.
    assert.deepEqual(s.signupsByWeek, [
      { week: "2026-10-05", signups: 1 }, // d, on Saturday 10-10
      { week: "2026-10-12", signups: 0 },
      { week: "2026-10-19", signups: 1 }, // c, one second before Monday
      { week: "2026-10-26", signups: 3 }, // a, b (Monday 00:00), f
    ]);
  });

  it("ranks follows by followers, then id", () => {
    assert.deepEqual(s.tickers, [
      { id: "MSFT", followers: 3 },
      { id: "NVDA", followers: 1 },
    ]);
    assert.deepEqual(s.members, [{ id: "P000197", followers: 2 }]);
    assert.deepEqual(s.insiders, [{ id: "0001106578", followers: 1 }]);
  });

  it("lists the newest account first", () => {
    assert.deepEqual(
      sortAccounts(accounts).map((a) => a.email),
      ["a@example.com", "f@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"]
    );
  });

  it("reports an empty store as zeros, with every week present", () => {
    const empty = summarizeAccounts([], now, 12);
    assert.equal(empty.total, 0);
    assert.equal(empty.signupsByWeek.length, 12);
    assert.equal(empty.signupsByWeek.at(-1)!.week, "2026-10-26");
    assert.ok(empty.signupsByWeek.every((w) => w.signups === 0));
  });
});

describe("listAllSubscriptions", () => {
  it("returns unconfirmed and unsubscribed records the digest list leaves out, and counts unreadable ones", async () => {
    const backend = createMemorySubscriptionBackend();
    await signInAccount(backend, SECRET, "signed-in@example.com", { tickers: ["MSFT"] });
    await upsertSubscription(backend, SECRET, { email: "pending@example.com", members: ["P000197"] });
    await signInAccount(backend, SECRET, "stopped@example.com", { tickers: ["NVDA"] });
    await stopEmails(backend, SECRET, "stopped@example.com");
    await backend.write(`subscriptions/${"f".repeat(32)}.json`, "{not json");
    await backend.write("subscriptions/stray-file.txt", "ignored: not a record path");

    const { accounts, unreadable } = await listAllSubscriptions(backend, 2);
    assert.deepEqual(accounts.map((a) => a.email).sort(), [
      "pending@example.com",
      "signed-in@example.com",
      "stopped@example.com",
    ]);
    assert.equal(unreadable, 1);

    const digest = await listVerifiedSubscriptions(backend);
    assert.deepEqual(digest.map((a) => a.email), ["signed-in@example.com"]);
    assert.equal(summarizeAccounts(accounts).receivingDigest, digest.length);
  });

  it("counts a blob that fails to read as unreadable instead of throwing", async () => {
    const backend = createMemorySubscriptionBackend();
    await signInAccount(backend, SECRET, "ok@example.com");
    await signInAccount(backend, SECRET, "flaky@example.com");
    const flaky = (await backend.list("subscriptions/"))[1].pathname;
    const read = backend.read.bind(backend);
    backend.read = async (b) => (b.pathname === flaky ? Promise.reject(new Error("503")) : read(b));
    const { accounts, unreadable } = await listAllSubscriptions(backend);
    assert.equal(accounts.length, 1);
    assert.equal(unreadable, 1);
  });
});
