import assert from "node:assert/strict";
import { test } from "node:test";

import { axisLabel, clampMonths, dense, monthKeys, monthLabel, previousMonth } from "./months.ts";

test("monthKeys ends in the current month and counts back across a year boundary", () => {
  const keys = monthKeys(3, new Date("2026-01-15T12:00:00Z"));
  assert.deepEqual(keys, ["2025-11", "2025-12", "2026-01"]);
});

test("monthKeys is computed in UTC, like the database's date('now')", () => {
  // 23:30 on the 31st in UTC is already the next month in UTC+1 — the key must not be.
  const keys = monthKeys(1, new Date("2026-03-31T23:30:00Z"));
  assert.deepEqual(keys, ["2026-03"]);
});

test("previousMonth steps back across January", () => {
  assert.equal(previousMonth("2026-01"), "2025-12");
  assert.equal(previousMonth("2026-10"), "2026-09");
});

test("clampMonths rejects garbage and bounds the window", () => {
  assert.equal(clampMonths("12"), 12);
  assert.equal(clampMonths("abc"), 12);
  assert.equal(clampMonths(undefined), 12);
  assert.equal(clampMonths(0), 12);
  assert.equal(clampMonths(999), 60);
  assert.equal(clampMonths(6.9), 6);
});

test("labels name the month; the axis form carries the year only on January and the first slot", () => {
  assert.equal(monthLabel("2026-09"), "September 2026");
  assert.equal(monthLabel("2026-09", "short"), "Sep 2026");
  assert.equal(monthLabel("not-a-month"), "not-a-month");
  assert.equal(axisLabel("2026-09"), "Sep");
  assert.equal(axisLabel("2026-01"), "Jan '26");
  assert.equal(axisLabel("2025-11", true), "Nov '25");
});

test("dense fills a hole with the empty row, in key order — a quiet month is zero, not absent", () => {
  const rows = [
    { month: "2026-02", n: 2 },
    { month: "2026-01", n: 1 },
  ];
  const out = dense(["2026-01", "2026-02", "2026-03"], rows, (month) => ({ month, n: 0 }));
  assert.deepEqual(out, [
    { month: "2026-01", n: 1 },
    { month: "2026-02", n: 2 },
    { month: "2026-03", n: 0 },
  ]);
});
