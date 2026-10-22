import assert from "node:assert/strict";
import { test } from "node:test";

import { adminIds, authConfigured, isAllowedAdmin, missingAuthConfig, parseAdminIds } from "./admin-auth.ts";

const ID = "345e869043f1e55f8bdc837c";
const FULL = {
  AUTH_SECRET: "s",
  AUTH_VERCEL_ID: "cl_abc",
  AUTH_VERCEL_SECRET: "secret",
  ADMIN_VERCEL_USER_IDS: ` ${ID} , second1234567890 `,
};

test("the allowlist is comma-separated Vercel user IDs, trimmed", () => {
  assert.deepEqual(parseAdminIds(FULL.ADMIN_VERCEL_USER_IDS), [ID, "second1234567890"]);
  assert.ok(isAllowedAdmin(ID, adminIds(FULL)));
  assert.ok(isAllowedAdmin("second1234567890", adminIds(FULL)));
});

test("the allowlist fails closed", () => {
  for (const raw of [undefined, "", "   ", ",", "short", "has spaces in it", "user@example.com"]) {
    const list = parseAdminIds(raw);
    assert.deepEqual(list, [], String(raw));
    assert.ok(!isAllowedAdmin(ID, list));
  }
});

test("an ID off the list, a near miss, or a missing ID is refused", () => {
  const list = adminIds(FULL);
  assert.ok(!isAllowedAdmin("someone-else-entirely", list));
  assert.ok(!isAllowedAdmin(ID.toUpperCase(), list), "IDs match exactly");
  assert.ok(!isAllowedAdmin(`${ID}x`, list));
  assert.ok(!isAllowedAdmin(ID.slice(1), list));
  assert.ok(!isAllowedAdmin(null, list));
  assert.ok(!isAllowedAdmin("", list));
});

test("sign-in counts as configured only when every piece is set", () => {
  assert.ok(authConfigured(FULL));
  assert.deepEqual(missingAuthConfig(FULL), []);
  assert.ok(!authConfigured({}));
  assert.deepEqual(missingAuthConfig({}), ["AUTH_SECRET", "AUTH_VERCEL_ID / AUTH_VERCEL_SECRET", "ADMIN_VERCEL_USER_IDS"]);
  for (const key of Object.keys(FULL)) {
    assert.ok(!authConfigured({ ...FULL, [key]: "" }), `blank ${key}`);
    assert.ok(!authConfigured({ ...FULL, [key]: undefined }), `unset ${key}`);
  }
});
