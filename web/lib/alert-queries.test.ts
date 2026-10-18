import assert from "node:assert/strict";
import { test } from "node:test";

import * as aq from "./alert-queries.ts";

// The committed database still has the cluster-only alerts table (schema 8):
// these are the queries the /alerts page runs against exactly that file, and
// against it the page must list every row the pipeline ever logged.

test("every alert in the committed database is listed, newest first", async () => {
  const rows = await aq.getAlerts({ limit: 1_000_000 });
  const totals = await aq.getAlertTotals();
  assert.ok(rows.length >= 64, `64 alerts were committed as of 2026-10-18; got ${rows.length}`);
  assert.equal(rows.length, totals.total, "the list and the headline count agree");
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].fired_at >= rows[i].fired_at, "ordered newest first");
  }
  for (const r of rows) {
    assert.ok((aq.ALERT_KINDS as readonly string[]).includes(r.kind), `known kind: ${r.kind}`);
    assert.ok(r.politician_count >= 1, "every alert counts someone");
    assert.ok(r.fired_at, "every alert has a time");
  }
});

test("filtering by kind partitions the log", async () => {
  const totals = await aq.getAlertTotals();
  let sum = 0;
  for (const kind of aq.ALERT_KINDS) {
    const rows = await aq.getAlerts({ kind, limit: 1_000_000 });
    assert.ok(rows.every((r) => r.kind === kind));
    sum += rows.length;
  }
  assert.equal(sum, totals.total);
});

test("the default page size and the per-kind totals are honest about the slice", async () => {
  const page = await aq.getAlerts({ limit: 5 });
  assert.ok(page.length <= 5);
  const totals = await aq.getAlertTotals();
  assert.equal(
    totals.byKind.reduce((n, k) => n + k.total, 0),
    totals.total,
    "the kind totals sum to the whole log, not the page"
  );
});

test("the weekly series has one bucket per week, oldest first", async () => {
  const weekly = await aq.getAlertsPerWeek(8);
  for (const kind of aq.ALERT_KINDS) {
    const series = aq.weeklySeries(weekly, kind, 8);
    assert.equal(series.length, 8);
    assert.ok(series.every((n) => Number.isInteger(n) && n >= 0));
  }
  // Buckets never count an alert twice: the series sum is the row count in range.
  const inRange = weekly.reduce((n, r) => n + r.n, 0);
  const summed = aq.ALERT_KINDS.reduce((n, k) => n + aq.weeklySeries(weekly, k, 8).reduce((a, b) => a + b, 0), 0);
  assert.equal(summed, inRange);
});
