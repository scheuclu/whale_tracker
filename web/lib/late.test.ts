import assert from "node:assert/strict";
import { test } from "node:test";

import * as q from "./queries.ts";

// The late view (/rankings?view=late) re-cuts the measure the politicians
// tiles already report: trades disclosed more than 45 days after they were
// made, trade date → filing date. Every query behind it must reconcile with
// `getPoliticianTotals` on the committed database, or one dataset would show
// two different "late" numbers depending on the page.

test("the deadline is the STOCK Act's 45 days, as in src/whale/stats.py", () => {
  assert.equal(q.STOCK_ACT_DEADLINE_DAYS, 45);
});

test("the ranking reproduces the tiles' late trades and members late", async () => {
  const [totals, members] = await Promise.all([q.getPoliticianTotals(), q.getLateMembers(10_000)]);
  assert.ok(totals.late_trades > 0, "the committed database has late trades");
  assert.equal(
    members.reduce((n, m) => n + m.late_count, 0),
    totals.late_trades,
    "sum of late_count over every ranked member"
  );
  assert.equal(members.length, totals.members_late, "one row per member with a late trade");
});

test("the monthly series and the late totals sum to the same late trades", async () => {
  const [totals, monthly, late] = await Promise.all([
    q.getPoliticianTotals(),
    q.getLateMonthly(),
    q.getLateTotals(),
  ]);
  assert.equal(
    monthly.reduce((n, m) => n + m.late_trades, 0),
    totals.late_trades
  );
  assert.equal(late.late_trades, totals.late_trades);
  assert.ok(late.late_filings > 0 && late.all_late_filings <= late.late_filings);
  assert.ok(late.worst_delay != null && late.worst_delay > q.STOCK_ACT_DEADLINE_DAYS);
  for (const m of monthly) {
    assert.match(m.month, /^\d{4}-\d{2}$/);
    assert.ok(0 <= m.late_trades && m.late_trades <= m.trades, `${m.month}: late within trades`);
    assert.ok(m.late_filings <= m.filings, `${m.month}: late filings within filings`);
  }
});

test("members are ranked by late trades then worst delay, and every row is past the deadline", async () => {
  const members = await q.getLateMembers(10_000);
  for (let i = 1; i < members.length; i++) {
    const a = members[i - 1];
    const b = members[i];
    assert.ok(
      a.late_count > b.late_count || (a.late_count === b.late_count && a.worst_delay >= b.worst_delay),
      `${a.member_name} before ${b.member_name}`
    );
  }
  for (const m of members) {
    assert.ok(m.late_count >= 1 && m.late_count <= m.trades, m.member_name);
    assert.ok(m.worst_delay > q.STOCK_ACT_DEADLINE_DAYS, `${m.member_name}: worst delay is late`);
    assert.ok(
      m.avg_late_delay > q.STOCK_ACT_DEADLINE_DAYS && m.avg_late_delay <= m.worst_delay,
      `${m.member_name}: mean of the late trades sits between the deadline and the worst`
    );
    assert.ok(m.late_filings >= 1, `${m.member_name}: a late trade came from a filing`);
  }
});

test("late filings carry their late rows, each with its own delay past the deadline", async () => {
  const filings = await q.getLateFilings(5);
  assert.ok(filings.length > 0 && filings.length <= 5);
  for (let i = 1; i < filings.length; i++) {
    assert.ok(
      (filings[i - 1].filing_date ?? "") >= (filings[i].filing_date ?? ""),
      "newest filing first"
    );
  }
  for (const f of filings) {
    assert.ok(f.late.length >= 1 && f.late.length <= f.trades, `${f.doc_id}: late rows within the filing`);
    for (let i = 1; i < f.late.length; i++) {
      assert.ok(f.late[i - 1].delay_days >= f.late[i].delay_days, `${f.doc_id}: longest delay first`);
    }
    for (const r of f.late) {
      assert.equal(r.doc_id, f.doc_id);
      assert.ok(r.delay_days > q.STOCK_ACT_DEADLINE_DAYS, `${f.doc_id}: row ${r.id} is late`);
      assert.equal(r.dates_inconsistent, 0, "a row with contradictory dates has no delay, so is never late");
    }
  }
});

test("the filing limit counts filings, never cuts a filing's rows", async () => {
  const [one, three] = await Promise.all([q.getLateFilings(1), q.getLateFilings(3)]);
  assert.equal(one.length, 1);
  assert.deepEqual(
    one[0].late.map((r) => r.id),
    three[0].late.map((r) => r.id),
    "the newest filing's rows are the same whatever the page size"
  );
});
