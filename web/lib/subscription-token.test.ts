import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  emailSubscriberKey,
  normalizeEmail,
  signSubscriptionToken,
  verifySubscriptionToken,
} from "./subscription-token.ts";

const SECRET = "test-alerts-secret-at-least-16-bytes";

describe("subscription-token", () => {
  it("normalizes and validates email addresses", () => {
    assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");
    assert.equal(normalizeEmail("not-an-email"), null);
    assert.equal(normalizeEmail(""), null);
    assert.equal(normalizeEmail(null), null);
  });

  it("derives a stable 32-hex subscriber key", () => {
    const k1 = emailSubscriberKey("Reader@Example.com", SECRET);
    const k2 = emailSubscriberKey("reader@example.com", SECRET);
    assert.equal(k1, k2);
    assert.match(k1, /^[0-9a-f]{32}$/);
  });

  it("signs and verifies tokens with purpose and expiry checks", () => {
    const token = signSubscriptionToken(
      { purpose: "verify", email: "Reader@Example.com", exp: 2000 },
      SECRET
    );
    const ok = verifySubscriptionToken(token, "verify", SECRET, 1500);
    assert.deepEqual(ok, {
      v: 1,
      purpose: "verify",
      email: "reader@example.com",
      exp: 2000,
    });

    // Expired
    assert.equal(verifySubscriptionToken(token, "verify", SECRET, 2500), null);
    // Wrong purpose
    assert.equal(verifySubscriptionToken(token, "manage", SECRET, 1500), null);
    // Wrong secret
    assert.equal(verifySubscriptionToken(token, "verify", "another-secret-that-is-long", 1500), null);
    // Tampered payload
    const [p, s] = token.split(".");
    assert.equal(verifySubscriptionToken(`${p}x.${s}`, "verify", SECRET, 1500), null);
  });
});
