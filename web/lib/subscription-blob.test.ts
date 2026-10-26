import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStoreEnabled, subscriptionBackend, vercelSubscriptionBackend } from "./subscription-blob.ts";

test("the in-memory account store needs the explicit switch and is never used on Vercel", () => {
  assert.equal(memoryStoreEnabled({}), false);
  assert.equal(memoryStoreEnabled({ WHALE_TEST_MEMORY_STORE: "1" }), true);
  assert.equal(memoryStoreEnabled({ WHALE_TEST_MEMORY_STORE: "1", VERCEL: "1" }), false);
  assert.equal(
    subscriptionBackend({ WHALE_TEST_MEMORY_STORE: "1", VERCEL: "1", BLOB_READ_WRITE_TOKEN: "x" }),
    vercelSubscriptionBackend
  );
  assert.equal(subscriptionBackend({}), null);
});
