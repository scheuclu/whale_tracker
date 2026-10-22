import assert from "node:assert/strict";
import { test } from "node:test";

import { publicErrorMessage } from "./public-error.ts";

test("a server path is masked, the advice around it kept", () => {
  const msg = publicErrorMessage(
    new Error("no database at /Users/someone/projects/whale_tracker/data/trades.sqlite3 — run `python -m whale backfill`")
  );
  assert.equal(msg, "no database at [path] — run `python -m whale backfill`");
  assert.equal(publicErrorMessage(new Error("unable to open /tmp/trades-12-3.sqlite3")), "unable to open [path]");
  assert.equal(publicErrorMessage(new Error("cannot read C:\\app\\data\\x.db")), "cannot read [path]");
});

test("URLs, env-var names and status text survive", () => {
  assert.equal(
    publicErrorMessage(new Error("trade database fetch failed: 401 — token invalid or expired")),
    "trade database fetch failed: 401 — token invalid or expired"
  );
  assert.equal(
    publicErrorMessage(new Error("see https://example.com/docs/setup/db for TRADES_DB_REPO=owner/name")),
    "see https://example.com/docs/setup/db for TRADES_DB_REPO=owner/name"
  );
});

test("credentials are redacted", () => {
  const out = publicErrorMessage(
    new Error("fetch https://api.github.com/x?token=abc123&ref=main with Bearer ghp_abcdefghijklmnopqrstuvwxyz0123")
  );
  assert.doesNotMatch(out, /abc123|ghp_abcdef/);
  assert.match(out, /token=\[redacted\]&ref=main/);
});

test("only the first line, bounded, never empty", () => {
  const e = new Error("first line\n    at Object.<anonymous> (/srv/app/x.js:1:1)");
  assert.equal(publicErrorMessage(e), "first line");
  assert.ok(publicErrorMessage(new Error("x".repeat(1000))).length <= 300);
  assert.equal(publicErrorMessage(new Error("")), "unexpected error");
  assert.equal(publicErrorMessage({ weird: true }), "unexpected error");
  assert.equal(publicErrorMessage("plain string"), "plain string");
});
