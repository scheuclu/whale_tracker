import test from "node:test";
import assert from "node:assert/strict";
import { trackEvent } from "./analytics";

test("trackEvent safely no-ops on server / Node.js without window", () => {
  assert.doesNotThrow(() => {
    trackEvent("test_event", { foo: "bar", num: 42, flag: true, undef: undefined });
  });
});
