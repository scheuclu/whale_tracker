import assert from "node:assert/strict";
import { test } from "node:test";

import { assessHealth, parseUtc, readHealthInputs, staleAfterHours, STALE_AFTER_HOURS, type HealthInputs } from "./health.ts";

const NOW = Date.parse("2026-10-22T14:00:00Z");
const inputs = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  lastPipelineWrite: "2026-10-22T13:13:51Z",
  lastFilingWrite: "2026-10-21T22:48:35Z",
  lastRunOutcome: "ok",
  consecutiveFailedRuns: 0,
  ...over,
});

test("a recent pipeline write is ok, however old the last filing change", () => {
  const r = assessHealth(inputs({ lastFilingWrite: "2026-10-01T00:00:00Z" }), { now: NOW });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.problems, []);
  assert.equal(r.checks.database.ok, true);
  assert.equal(r.checks.freshness.age_hours, 0.77);
  assert.equal(r.checks.freshness.stale_after_hours, STALE_AFTER_HOURS);
});

test("past the threshold is degraded, with the age in the reason", () => {
  const r = assessHealth(inputs({ lastPipelineWrite: "2026-10-21T20:00:00Z" }), { now: NOW });
  assert.equal(r.status, "degraded");
  assert.equal(r.checks.freshness.ok, false);
  assert.match(r.problems[0], /18\.0 h ago \(threshold 12 h\)/);
});

test("the threshold is configurable, and a bad value falls back to the default", () => {
  assert.equal(staleAfterHours({ HEALTH_STALE_AFTER_HOURS: "0.5" }), 0.5);
  assert.equal(staleAfterHours({ HEALTH_STALE_AFTER_HOURS: "" }), STALE_AFTER_HOURS);
  assert.equal(staleAfterHours({ HEALTH_STALE_AFTER_HOURS: "-3" }), STALE_AFTER_HOURS);
  assert.equal(staleAfterHours({ HEALTH_STALE_AFTER_HOURS: "soon" }), STALE_AFTER_HOURS);
  assert.equal(assessHealth(inputs(), { now: NOW, staleAfter: 0.5 }).status, "degraded");
});

test("an unreadable database is degraded and says nothing more", () => {
  const r = assessHealth(null, { now: NOW });
  assert.equal(r.status, "degraded");
  assert.equal(r.checks.database.ok, false);
  assert.deepEqual(r.problems, ["database unreachable"]);
});

test("no pipeline write at all is degraded, not ok", () => {
  assert.equal(assessHealth(inputs({ lastPipelineWrite: null }), { now: NOW }).status, "degraded");
});

test("one failed run is a passing error; two in a row is degraded", () => {
  assert.equal(assessHealth(inputs({ lastRunOutcome: "failed", consecutiveFailedRuns: 1 }), { now: NOW }).status, "ok");
  const r = assessHealth(inputs({ lastRunOutcome: "failed", consecutiveFailedRuns: 2 }), { now: NOW });
  assert.equal(r.status, "degraded");
  assert.match(r.problems.join(), /last 2 pipeline runs failed/);
});

test("stored timestamps parse as UTC with or without a zone", () => {
  assert.equal(parseUtc("2026-10-22T13:13:51Z"), Date.parse("2026-10-22T13:13:51Z"));
  assert.equal(parseUtc("2026-10-22 13:13:51"), Date.parse("2026-10-22T13:13:51Z"));
  assert.equal(parseUtc("2026-10-22T13:13:51+00:00"), Date.parse("2026-10-22T13:13:51Z"));
  assert.equal(parseUtc(null), null);
  assert.equal(parseUtc("garbage"), null);
});

test("readHealthInputs counts the newest consecutive failures from the run log", () => {
  const runs = JSON.stringify([
    { started: "2026-10-22T13:00:00Z", outcome: "failed" },
    { started: "2026-10-22T11:00:00Z", outcome: "failed" },
    { started: "2026-10-22T09:00:00Z", outcome: "ok" },
    { started: "2026-10-22T07:00:00Z", outcome: "failed" },
  ]);
  const db = { prepare: () => ({ get: () => ({ pipeline: "2026-10-22T13:00:05Z", filing: null, runs }) }) };
  const i = readHealthInputs(db);
  assert.equal(i.consecutiveFailedRuns, 2);
  assert.equal(i.lastRunOutcome, "failed");
  const empty = readHealthInputs({ prepare: () => ({ get: () => ({ pipeline: null, filing: null, runs: "not json" }) }) });
  assert.equal(empty.consecutiveFailedRuns, 0);
  assert.equal(empty.lastRunOutcome, null);
});

test("the report carries no error text, path or environment", () => {
  const body = JSON.stringify(assessHealth(null, { now: NOW }));
  assert.doesNotMatch(body, /TRADES_DB|token|\/Users\/|sqlite3/i);
});
