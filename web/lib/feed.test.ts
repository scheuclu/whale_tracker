import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRACKETS,
  bracketSpan,
  dayLabel,
  filedBeforeTrade,
  monthDay,
  groupFeed,
  todayIso,
  type FeedRowLike,
} from "./feed.ts";

const usd = (d: number) => d * 100;

test("every standard bracket maps onto its own rung", () => {
  BRACKETS.forEach((b, i) => {
    const span = bracketSpan(b.min, b.max);
    assert.equal(span.kind, b.max == null ? "open" : "range", b.label);
    assert.equal(span.lo, i, b.label);
    assert.equal(span.hi, b.max == null ? BRACKETS.length - 1 : i, b.label);
  });
});

test("the open-ended top bracket is open, never given a ceiling", () => {
  // Stored as the parser stores "Over $50,000,000": min = $50,000,000.
  assert.deepEqual(bracketSpan(usd(50_000_000), null), { kind: "open", lo: 9, hi: 9 });
});

test("the spouse 'Over $1,000,000' bracket spans every rung from $1M up", () => {
  assert.deepEqual(bracketSpan(usd(1_000_000), null), { kind: "open", lo: 6, hi: 9 });
});

test("a non-standard interval covers every rung it touches", () => {
  assert.deepEqual(bracketSpan(usd(15_001), usd(100_000)), { kind: "range", lo: 1, hi: 2 });
});

test("an exact figure sits on its bracket, or below the ladder", () => {
  assert.deepEqual(bracketSpan(null, null, usd(2_722)), { kind: "exact", lo: 0, hi: 0 });
  assert.deepEqual(bracketSpan(usd(318), usd(318), usd(318)), { kind: "exact", lo: -1, hi: -1 });
  assert.deepEqual(bracketSpan(null, null, usd(60_000_000)), { kind: "exact", lo: 9, hi: 9 });
});

test("no amount is unknown, not the lowest bracket", () => {
  assert.equal(bracketSpan(null, null).kind, "unknown");
});

test("todayIso reads the calendar date in New York", () => {
  // 03:00 UTC on Oct 18 is still Oct 17 in New York.
  assert.equal(todayIso(new Date("2026-10-18T03:00:00Z")), "2026-10-17");
  assert.equal(todayIso(new Date("2026-10-18T15:00:00Z")), "2026-10-18");
});

test("day labels: relative, dated, other-year, future and undated", () => {
  const today = "2026-10-18";
  assert.deepEqual(dayLabel("2026-10-18", today), { label: "Today", date: "Sun, Oct 18", future: false });
  assert.deepEqual(dayLabel("2026-10-17", today), { label: "Yesterday", date: "Sat, Oct 17", future: false });
  assert.deepEqual(dayLabel("2026-10-09", today), { label: "Fri, Oct 9", date: null, future: false });
  assert.equal(dayLabel("2025-12-26", today).label, "Fri, Dec 26, 2025");
  // A mistyped future trade date is labelled as filed and flagged.
  assert.deepEqual(dayLabel("2026-12-26", today), { label: "Sat, Dec 26", date: null, future: true });
  assert.equal(dayLabel(null, today).label, "No trade date");
  assert.equal(dayLabel("2026-13-45", today).label, "2026-13-45");
});

type Row = FeedRowLike;
let nextId = 1;
function row(tx_date: string | null, filing: string, extra: Partial<Row> = {}): Row {
  return {
    id: nextId++,
    tx_date,
    member_name: `Member ${filing}`,
    pdf_url: `https://example/${filing}.pdf`,
    doc_id: filing,
    ...extra,
  };
}

test("groupFeed cuts by trade date and by consecutive filing, preserving order", () => {
  const rows = [
    row("2026-10-12", "A"),
    row("2026-10-09", "A"),
    row("2026-10-09", "A"),
    row("2026-10-09", "B"),
    row("2026-10-09", "A"),
    row(null, "C"),
  ];
  const days = groupFeed(rows, "2026-10-18");
  assert.deepEqual(
    days.map((d) => [d.key, d.trades, d.filings, d.blocks.map((b) => b.rows.length)]),
    [
      ["2026-10-12", 1, 1, [1]],
      // A, A, then B, then A again: three blocks, two distinct filings.
      ["2026-10-09", 4, 2, [2, 1, 1]],
      [null, 1, 1, [1]],
    ]
  );
  assert.deepEqual(
    days.flatMap((d) => d.blocks.flatMap((b) => b.rows.map((r) => r.id))),
    rows.map((r) => r.id)
  );
});

test("monthDay and filedBeforeTrade", () => {
  assert.equal(monthDay("2026-10-12", "2026-10-18"), "Oct 12");
  assert.equal(monthDay("2025-10-12", "2026-10-18"), "Oct 12, 2025");
  assert.equal(monthDay(null, "2026-10-18"), "—");
  // Row 717: traded "2026-12-26", filed 2026-02-09 — reproduced, flagged.
  assert.equal(filedBeforeTrade("2026-12-26", "2026-02-09"), true);
  assert.equal(filedBeforeTrade("2026-10-09", "2026-10-15"), false);
  assert.equal(filedBeforeTrade("2026-10-09", "2026-10-09"), false);
  assert.equal(filedBeforeTrade(null, "2026-10-09"), false);
});
