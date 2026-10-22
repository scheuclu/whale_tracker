import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTACT_LIMITS,
  CONTACT_RATE_LIMIT,
  CONTACT_TOPICS,
  HONEYPOT_FIELD,
  initialContactState,
  isContactTopic,
  isRateLimited,
  looksLikeBot,
  rateLimitSince,
  readContactFields,
  validateContact,
  type ContactFields,
} from "./contact.ts";
import { clientIpFrom, contactIpSalt, hashIp } from "./contact-ip.ts";

const valid: ContactFields = {
  topic: "correction",
  name: "",
  email: "reader@example.com",
  message: "The MSFT row on 2026-03-02 shows a sale; the filing says purchase.",
};

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

test("a complete submission validates, with the name optional", () => {
  const r = validateContact(valid);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.topic, "correction");
});

test("each field has one clear error", () => {
  const r = validateContact({ topic: "", name: "x".repeat(CONTACT_LIMITS.name + 1), email: "nope", message: "short" });
  assert.ok(!r.ok);
  if (!r.ok) assert.deepEqual(Object.keys(r.errors).sort(), ["email", "message", "name", "topic"]);
});

test("an empty email asks for one; a malformed one says so", () => {
  const empty = validateContact({ ...valid, email: "" });
  const bad = validateContact({ ...valid, email: "a@b" });
  assert.ok(!empty.ok && !bad.ok);
  if (!empty.ok && !bad.ok) assert.notEqual(empty.errors.email, bad.errors.email);
  for (const ok of ["a@b.co", "first.last+tag@sub.example.org"]) assert.ok(validateContact({ ...valid, email: ok }).ok, ok);
  for (const no of ["a b@c.com", "@c.com", "a@.com", "a@c.", "x".repeat(195) + "@b.com"]) {
    assert.ok(!validateContact({ ...valid, email: no }).ok, no);
  }
});

test("message length bounds are inclusive and reported", () => {
  assert.ok(validateContact({ ...valid, message: "x".repeat(CONTACT_LIMITS.messageMin) }).ok);
  assert.ok(validateContact({ ...valid, message: "x".repeat(CONTACT_LIMITS.message) }).ok);
  assert.ok(!validateContact({ ...valid, message: "x".repeat(CONTACT_LIMITS.messageMin - 1) }).ok);
  const long = validateContact({ ...valid, message: "x".repeat(CONTACT_LIMITS.message + 1) });
  assert.ok(!long.ok);
  if (!long.ok) assert.match(long.errors.message ?? "", /4,001/);
});

test("control characters are refused; newlines and tabs are fine", () => {
  assert.ok(validateContact({ ...valid, message: "line one\nline two\tok\r\n" }).ok);
  assert.ok(!validateContact({ ...valid, message: "nul \u0000 inside the text" }).ok);
});

test("only known topics are accepted", () => {
  for (const t of CONTACT_TOPICS) assert.ok(isContactTopic(t.value));
  for (const t of ["", "Correction", "spam", undefined, 1]) assert.ok(!isContactTopic(t));
  assert.ok(!validateContact({ ...valid, topic: "admin" }).ok);
  // ?topic= preselects only a real topic.
  assert.equal(initialContactState("press").values.topic, "press");
  assert.equal(initialContactState("<b>").values.topic, "");
  assert.equal(initialContactState().values.topic, "");
});

test("fields are read trimmed, and non-strings read as empty", () => {
  const fd = form({ topic: " press ", name: "  Ann ", email: " a@b.co ", message: "  hello there  " });
  fd.set("message", new Blob(["file"]));
  assert.deepEqual(readContactFields(fd), { topic: "press", name: "Ann", email: "a@b.co", message: "" });
});

test("the honeypot flags a bot only when filled", () => {
  assert.ok(!looksLikeBot(form({ email: "a@b.co" })));
  assert.ok(!looksLikeBot(form({ [HONEYPOT_FIELD]: "   " })));
  assert.ok(looksLikeBot(form({ [HONEYPOT_FIELD]: "https://spam.example" })));
});

test("the rate limit refuses the sender's next message once the window holds the max", () => {
  assert.ok(!isRateLimited(0));
  assert.ok(!isRateLimited(CONTACT_RATE_LIMIT.max - 1));
  assert.ok(isRateLimited(CONTACT_RATE_LIMIT.max));
  assert.ok(isRateLimited(CONTACT_RATE_LIMIT.max + 3));
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(rateLimitSince(now).toISOString(), "2026-10-22T11:00:00.000Z");
});

test("the IP hash is keyed, stable and never the address", () => {
  const a = hashIp("203.0.113.7", "salt-one");
  assert.equal(a, hashIp("203.0.113.7", "salt-one"));
  assert.notEqual(a, hashIp("203.0.113.7", "salt-two"));
  assert.notEqual(a, hashIp("203.0.113.8", "salt-one"));
  assert.match(a ?? "", /^[0-9a-f]{32}$/);
  assert.ok(!(a ?? "").includes("203"));
  // No address, or no key, means no hash: never an unkeyed (reversible) one.
  assert.equal(hashIp(null, "salt"), null);
  assert.equal(hashIp("203.0.113.7", null), null);
});

test("the salt prefers CONTACT_IP_SALT, falls back to AUTH_SECRET, and blank is unset", () => {
  assert.equal(contactIpSalt({ CONTACT_IP_SALT: "s", AUTH_SECRET: "a" }), "s");
  assert.equal(contactIpSalt({ CONTACT_IP_SALT: " ", AUTH_SECRET: "a" }), "a");
  assert.equal(contactIpSalt({ CONTACT_IP_SALT: "", AUTH_SECRET: "" }), null);
  assert.equal(contactIpSalt({}), null);
});

test("the client IP is the first forwarded hop, else x-real-ip", () => {
  const h = (m: Record<string, string>) => (n: string) => m[n] ?? null;
  assert.equal(clientIpFrom(h({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })), "198.51.100.1");
  assert.equal(clientIpFrom(h({ "x-real-ip": " 198.51.100.2 " })), "198.51.100.2");
  assert.equal(clientIpFrom(h({})), null);
});
