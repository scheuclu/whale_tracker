import assert from "node:assert/strict";
import { test } from "node:test";

import { blobConfigured, contactConfigured } from "./contact-blob.ts";
import {
  countRecentMessagesFrom,
  listMessages,
  messagePathname,
  parseMessageFilter,
  parsePathname,
  parseStored,
  saveContactMessage,
  SCAN_LIMIT,
  senderPrefix,
  setMessageHandled,
  stampOf,
  type BlobBackend,
  type ListedBlob,
  type NewContactMessage,
} from "./contact-store.ts";

/**
 * An in-memory BlobBackend with the semantics the real one relies on:
 * create refuses an existing pathname, replace honours the ETag, and list
 * returns blobs in an arbitrary (here: reversed) order.
 */
function memoryBackend() {
  const blobs = new Map<string, { body: string; etag: number }>();
  let etag = 0;
  const backend: BlobBackend & { blobs: typeof blobs; beforeReplace?: () => void } = {
    blobs,
    async list(prefix) {
      return [...blobs.keys()].filter((p) => p.startsWith(prefix)).reverse().map((p): ListedBlob => ({ pathname: p, url: `mem://${p}` }));
    },
    async read(b) {
      const hit = blobs.get(b.pathname);
      return hit ? { body: hit.body, etag: String(hit.etag) } : null;
    },
    async create(p, body) {
      if (blobs.has(p)) throw new Error("exists");
      blobs.set(p, { body, etag: ++etag });
    },
    async replace(p, body, ifMatch) {
      backend.beforeReplace?.();
      const hit = blobs.get(p);
      if (!hit || String(hit.etag) !== ifMatch) return "conflict";
      blobs.set(p, { body, etag: ++etag });
      return "ok";
    },
  };
  return backend;
}

const HASH_A = "a".repeat(32);
const HASH_B = "b".repeat(32);
const msg = (over: Partial<NewContactMessage> = {}): NewContactMessage => ({
  topic: "correction",
  name: null,
  email: "reader@example.com",
  message: "The row does not match the filing.",
  ipHash: HASH_A,
  ...over,
});
const at = (iso: string) => new Date(iso);

test("pathnames group by sender, carry a sortable stamp, and round-trip", () => {
  assert.equal(stampOf(at("2026-10-22T13:13:52.123Z")), "20261022T131352123Z");
  const p = messagePathname({ ipHash: HASH_A, createdAt: "2026-10-22T13:13:52.123Z", id: "0b6f6c5e-3f0a-4c55-9a8e-2f1d7f2b9c10" });
  assert.equal(p, `contact/${HASH_A}/20261022T131352123Z_0b6f6c5e-3f0a-4c55-9a8e-2f1d7f2b9c10.json`);
  assert.deepEqual(parsePathname(p), { sender: HASH_A, createdAt: at("2026-10-22T13:13:52.123Z"), id: "0b6f6c5e-3f0a-4c55-9a8e-2f1d7f2b9c10" });
  assert.equal(senderPrefix(null), "contact/anon/");
  for (const bad of ["contact/x/1_2.json", "other/a.json", `contact/${HASH_A}/20261322T000000000Z_0b6f6c5e-3f0a-4c55-9a8e-2f1d7f2b9c10.json`]) {
    assert.equal(parsePathname(bad), null, bad);
  }
  assert.throws(() => senderPrefix("../etc"));
  assert.throws(() => messagePathname({ ipHash: HASH_A, createdAt: "2026-10-22T00:00:00Z", id: "../../x" }));
});

test("a stored message reads back; anything else reads as null", async () => {
  const be = memoryBackend();
  const saved = await saveContactMessage(be, msg({ name: "Ann" }), at("2026-10-22T10:00:00Z"));
  const [only] = be.blobs.values();
  assert.deepEqual(parseStored(only.body), saved);
  assert.equal(saved.handledAt, null);
  for (const junk of ["", "{", "[]", JSON.stringify({ ...saved, v: 2 }), JSON.stringify({ ...saved, topic: "spam" }), JSON.stringify({ ...saved, email: 7 })]) {
    assert.equal(parseStored(junk), null, junk);
  }
});

test("the rate limit counts only this sender's messages inside the window", async () => {
  const be = memoryBackend();
  await saveContactMessage(be, msg(), at("2026-10-22T09:59:59Z")); // before the window
  await saveContactMessage(be, msg(), at("2026-10-22T10:00:00Z"));
  await saveContactMessage(be, msg(), at("2026-10-22T10:30:00Z"));
  await saveContactMessage(be, msg({ ipHash: HASH_B }), at("2026-10-22T10:31:00Z"));
  await saveContactMessage(be, msg({ ipHash: null }), at("2026-10-22T10:32:00Z"));
  assert.equal(await countRecentMessagesFrom(be, HASH_A, at("2026-10-22T10:00:00Z")), 2);
  assert.equal(await countRecentMessagesFrom(be, HASH_B, at("2026-10-22T10:00:00Z")), 1);
  assert.equal(await countRecentMessagesFrom(be, "c".repeat(32), at("2026-10-22T10:00:00Z")), 0);
});

test("admin list: newest first whatever order list() returns, filtered, searched, counted", async () => {
  const be = memoryBackend();
  await saveContactMessage(be, msg({ email: "old@example.com" }), at("2026-10-20T10:00:00Z"));
  const mid = await saveContactMessage(be, msg({ email: "Press@Example.org", topic: "press", ipHash: HASH_B }), at("2026-10-21T10:00:00Z"));
  await saveContactMessage(be, msg({ email: "new@example.com", ipHash: null }), at("2026-10-22T10:00:00Z"));
  be.blobs.set("contact/notes.txt", { body: "not a message", etag: 99 });
  await be.create(`contact/${HASH_A}/20261019T000000000Z_0b6f6c5e-3f0a-4c55-9a8e-2f1d7f2b9c10.json`, "{corrupt");

  const all = await listMessages(be, { filter: "all", query: "" });
  assert.deepEqual(all.rows.map((r) => r.email), ["new@example.com", "Press@Example.org", "old@example.com"]);
  assert.equal(all.open, 3);
  assert.equal(all.handled, 0);
  assert.equal(all.unreadable, 1, "a corrupt message blob is counted, not shown");
  assert.equal(all.truncated, 0);
  assert.ok(!("ipHash" in all.rows[0]) && !("url" in all.rows[0]), "no IP hash or blob URL reaches the page");

  await setMessageHandled(be, mid.id, true, at("2026-10-22T11:00:00Z"));
  const open = await listMessages(be, { filter: "open", query: "" });
  const handled = await listMessages(be, { filter: "handled", query: "" });
  assert.deepEqual(open.rows.map((r) => r.email), ["new@example.com", "old@example.com"]);
  assert.deepEqual(handled.rows.map((r) => r.email), ["Press@Example.org"]);
  assert.equal(handled.rows[0].handledAt?.toISOString(), "2026-10-22T11:00:00.000Z");
  assert.equal(open.open, 2);
  assert.equal(open.handled, 1);

  const search = await listMessages(be, { filter: "all", query: "press@" });
  assert.deepEqual(search.rows.map((r) => r.email), ["Press@Example.org"], "search is case-insensitive");
  assert.equal((await listMessages(be, { filter: "all", query: "%" })).matched, 0, "no wildcard syntax");
});

test("handled is a conditional set: idempotent, reversible, and retried on a concurrent write", async () => {
  const be = memoryBackend();
  const m = await saveContactMessage(be, msg(), at("2026-10-22T10:00:00Z"));
  const state = async () => (await listMessages(be, { filter: "all", query: "" })).rows[0].handledAt;

  await setMessageHandled(be, m.id, true, at("2026-10-22T11:00:00Z"));
  const first = await state();
  await setMessageHandled(be, m.id, true, at("2026-10-22T12:00:00Z"));
  assert.deepEqual(await state(), first, "setting handled again keeps the first time");

  // Another writer slips in between our read and our write, once.
  let interfere = true;
  be.beforeReplace = () => {
    if (!interfere) return;
    interfere = false;
    const [p, hit] = [...be.blobs.entries()][0];
    be.blobs.set(p, { body: hit.body, etag: hit.etag + 1000 });
  };
  await setMessageHandled(be, m.id, false);
  assert.equal(await state(), null, "the reopen landed after re-reading");

  // A writer that never stops: give up loudly rather than clobber.
  be.beforeReplace = () => {
    const [p, hit] = [...be.blobs.entries()][0];
    be.blobs.set(p, { body: hit.body, etag: hit.etag + 1000 });
  };
  await assert.rejects(setMessageHandled(be, m.id, true), /kept changing/);

  await assert.rejects(setMessageHandled(be, "not-a-uuid", true), /Bad message id/);
  await assert.rejects(setMessageHandled(be, "0b6f6c5e-3f0a-4c55-9a8e-2f1d7f2b9c10", true), /No such message/);
});

test("admin reads at most SCAN_LIMIT messages, the newest, and says how many it left out", async () => {
  const be = memoryBackend();
  const base = at("2026-01-01T00:00:00Z").getTime();
  for (let i = 0; i < SCAN_LIMIT + 3; i++) {
    await saveContactMessage(be, msg({ email: `r${i}@example.com` }), new Date(base + i * 60_000));
  }
  const r = await listMessages(be, { filter: "all", query: "r0@" });
  assert.equal(r.truncated, 3);
  assert.equal(r.matched, 0, "the three oldest were not read");
  assert.equal((await listMessages(be, { filter: "all", query: "" })).rows[0].email, `r${SCAN_LIMIT + 2}@example.com`);
});

test("filter parsing defaults to open", () => {
  assert.equal(parseMessageFilter("handled"), "handled");
  assert.equal(parseMessageFilter("all"), "all");
  assert.equal(parseMessageFilter(undefined), "open");
  assert.equal(parseMessageFilter(["handled"]), "open");
});

test("the form is offered only with a store and an IP-hash key; blank reads as unset", () => {
  assert.ok(!blobConfigured({}));
  assert.ok(!blobConfigured({ BLOB_STORE_ID: " ", BLOB_READ_WRITE_TOKEN: "" }));
  assert.ok(blobConfigured({ BLOB_STORE_ID: "store_abc" }));
  assert.ok(blobConfigured({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_abc_def" }));
  assert.ok(!contactConfigured({ BLOB_STORE_ID: "store_abc" }), "no salt");
  assert.ok(contactConfigured({ BLOB_STORE_ID: "store_abc", AUTH_SECRET: "x" }));
  assert.ok(contactConfigured({ BLOB_STORE_ID: "store_abc", CONTACT_IP_SALT: "x" }));
});
