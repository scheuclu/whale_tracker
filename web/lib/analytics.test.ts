import test from "node:test";
import assert from "node:assert/strict";
import { trackEvent } from "./analytics";

test("trackEvent safely no-ops on server / Node.js without window", () => {
  assert.doesNotThrow(() => {
    trackEvent("test_event", { foo: "bar", num: 42, flag: true, undef: undefined });
  });
});

test("an event sent before <Analytics /> starts is queued, not dropped", async () => {
  // The landing page after a sign-in reads `?signed_in=` and tracks
  // `sign_in_complete` before Vercel's component has defined `window.va`;
  // `track()` alone drops it, and production recorded none.
  const g = globalThis as unknown as { window?: { va?: unknown; vaq?: unknown[][] } };
  const w: { va?: unknown; vaq?: unknown[][] } = {};
  g.window = w;
  try {
    trackEvent("sign_in_complete", { method: "google", skipped: undefined });
    assert.equal(typeof w.va, "function", "the queue exists synchronously");
    // track() runs once the SDK module has loaded.
    for (let i = 0; i < 50 && !w.vaq?.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(w.vaq?.length, 1);
    const [kind, payload] = w.vaq![0] as [string, { name: string; data: Record<string, unknown> }];
    assert.equal(kind, "event");
    assert.equal(payload.name, "sign_in_complete");
    assert.deepEqual(payload.data, { method: "google" });
  } finally {
    delete g.window;
  }
});

test("a va the analytics script already set up is kept and called", async () => {
  const g = globalThis as unknown as { window?: { va?: unknown } };
  const calls: unknown[][] = [];
  const real = (...params: unknown[]) => calls.push(params);
  g.window = { va: real };
  try {
    trackEvent("nav_tab_click");
    assert.equal(g.window.va, real);
    for (let i = 0; i < 50 && !calls.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((calls[0]?.[1] as { name?: string })?.name, "nav_tab_click");
  } finally {
    delete g.window;
  }
});
