import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MIN_R,
  dayNumber,
  dodge,
  earlySplit,
  floorRadius,
  isoFromDay,
  layoutTimeline,
  mergeBins,
  monthTicks,
  sideOf,
  type TimelineInput,
} from "./timeline.ts";

let nextId = 1;
function trade(tx: string | null, action = "purchase", extra: Partial<TimelineInput> = {}): TimelineInput {
  return {
    id: nextId++,
    tx_date: tx,
    filing_date: null,
    action,
    amount_min_cents: 1_001_00,
    amount_exact_cents: null,
    ...extra,
  };
}

test("dayNumber reads ISO dates and rejects malformed or impossible ones", () => {
  assert.equal(dayNumber("1970-01-02"), 1);
  assert.equal(isoFromDay(dayNumber("2026-10-18")!), "2026-10-18");
  assert.equal(dayNumber("2026-02-31"), null);
  assert.equal(dayNumber("10/18/2026"), null);
  assert.equal(dayNumber(null), null);
  assert.equal(dayNumber(""), null);
});

test("sideOf maps buys up, sells (full and partial) down, everything else onto the axis", () => {
  assert.equal(sideOf("purchase"), "buy");
  assert.equal(sideOf("sale"), "sell");
  assert.equal(sideOf("sale_partial"), "sell");
  assert.equal(sideOf("exchange"), "other");
  assert.equal(sideOf("unknown"), "other");
});

test("mark size grows with the bracket floor on a log scale, never below the marker floor", () => {
  assert.equal(floorRadius(1_001_00), MIN_R);
  assert.equal(floorRadius(null), MIN_R, "an unknown amount gets the smallest mark, not a guess");
  assert.equal(floorRadius(0), MIN_R);
  assert.equal(floorRadius(15_00), MIN_R, "an exact figure below the lowest floor is not shrunk away");
  const a = floorRadius(15_001_00);
  const b = floorRadius(1_000_001_00);
  const c = floorRadius(50_000_001_00);
  assert.ok(MIN_R < a && a < b && b < c);
  // Log scale: the $50M top floor is under three times the lowest mark, so a
  // single huge trade cannot drown 83% of rows in the $1,001 bracket.
  assert.ok(c < MIN_R * 3);
});

test("earlySplit sets apart a minority of dates far before the rest", () => {
  const d = (iso: string) => dayNumber(iso)!;
  // McCaul-like: a few 2016-typed dates in front of a 2026 record.
  const days = [d("2016-01-02"), d("2016-02-01"), d("2026-03-01"), d("2026-04-01"), d("2026-06-30")];
  assert.equal(earlySplit(days), 2);
  // A record that simply spans two years has no break.
  assert.equal(earlySplit([d("2024-10-23"), d("2025-04-01"), d("2025-12-01"), d("2026-09-30")]), 0);
  // The majority is never the outlier.
  assert.equal(earlySplit([d("2016-01-01"), d("2016-01-02"), d("2016-01-03"), d("2026-01-01")]), 0);
  assert.equal(earlySplit([d("2026-01-01")]), 0);
});

test("dodge stacks colliding marks away from the axis without overlap", () => {
  const items = [
    { x: 100, r: 4 },
    { x: 100, r: 4 },
    { x: 101, r: 4 },
    { x: 300, r: 4 },
  ];
  const ys = dodge(items, { gap: 1, base: 2 });
  assert.equal(ys[0], 6, "the first mark sits right by the axis");
  assert.equal(ys[3], 6, "a lone mark elsewhere also sits by the axis");
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const dx = items[i].x - items[j].x;
      const dy = ys[i]! - ys[j]!;
      assert.ok(Math.hypot(dx, dy) >= items[i].r + items[j].r + 1 - 1e-6, `marks ${i} and ${j} overlap`);
    }
  }
});

test("dodge leaves marks past the height cap unplaced instead of overlapping them", () => {
  const items = Array.from({ length: 20 }, () => ({ x: 50, r: 4 }));
  const ys = dodge(items, { maxExtent: 40 });
  const placed = ys.filter((y) => y != null);
  assert.ok(placed.length > 0 && placed.length < 20);
  for (const y of placed) assert.ok(y! + 4 <= 40);
});

test("monthTicks picks a step that keeps labels apart and prints the year on January", () => {
  const lo = dayNumber("2025-11-15")!;
  const hi = dayNumber("2026-03-20")!;
  const wide = monthTicks(lo, hi, (d) => (d - lo) * 10);
  assert.deepEqual(
    wide.map((t) => [t.label, t.year]),
    [
      ["Dec", "2025"],
      ["Jan", "2026"],
      ["Feb", null],
      ["Mar", null],
    ]
  );
  // Squeezed: a 2-year span on 300px steps up to quarters or more.
  const lo2 = dayNumber("2024-10-01")!;
  const hi2 = dayNumber("2026-10-01")!;
  const tight = monthTicks(lo2, hi2, (d) => ((d - lo2) / (hi2 - lo2)) * 300);
  for (let i = 1; i < tight.length; i++) assert.ok(tight[i].x - tight[i - 1].x >= 46 - 1e-9);
});

test("layout keeps a mistyped future date off the scale, flagged in the right gutter", () => {
  const rows = [
    trade("2026-03-30", "purchase", { filing_date: "2026-04-20" }),
    trade("2026-12-26", "sale", { filing_date: "2026-02-09" }),
  ];
  const l = layoutTimeline(rows, { width: 1000, today: "2026-10-18" });
  const late = l.marks.find((m) => m.trade.tx_date === "2026-12-26")!;
  assert.equal(late.zone, "late");
  assert.equal(late.afterFiling, true, "a trade date after its filing date is flagged, not moved");
  assert.ok(l.late && l.late.count === 1);
  assert.ok(l.plotRight < 1000 - 44, "the to-scale axis stops short of the gutter");
  // The in-range trade is on the scale, left of the gutter.
  const main = l.marks.find((m) => m.trade.tx_date === "2026-03-30")!;
  assert.equal(main.zone, "main");
  assert.ok(main.x >= l.plotLeft && main.x <= l.plotRight);
});

test("layout sets a far-early minority apart instead of squashing the record", () => {
  const rows = [
    trade("2016-01-02", "purchase"),
    trade("2016-01-09", "sale"),
    ...["2026-03-24", "2026-05-01", "2026-06-15", "2026-08-20"].map((d) => trade(d)),
  ];
  const l = layoutTimeline(rows, { width: 1000, today: "2026-10-18" });
  assert.equal(l.early?.count, 2);
  assert.equal(l.early?.label, "2016");
  const main = l.marks.filter((m) => m.zone === "main");
  const span = Math.max(...main.map((m) => m.x)) - Math.min(...main.map((m) => m.x));
  assert.ok(span > (l.plotRight - l.plotLeft) * 0.8, "the 2026 record spans the axis");
});

test("a trade date after the filing date but before today stays where filed, flagged", () => {
  const rows = [
    trade("2026-06-01"),
    trade("2026-06-11", "purchase", { filing_date: "2026-06-01" }),
    trade("2026-07-01"),
  ];
  const l = layoutTimeline(rows, { width: 800, today: "2026-10-18" });
  const m = l.marks.find((x) => x.trade.tx_date === "2026-06-11")!;
  assert.equal(m.zone, "main");
  assert.equal(m.afterFiling, true);
  assert.equal(l.counts.afterFiling, 1);
});

test("one trade gets a minimum span centred on it, and undated rows are counted not plotted", () => {
  const rows = [trade("2023-10-31"), trade(null), trade("garbage")];
  const l = layoutTimeline(rows, { width: 600, today: "2026-10-18" });
  assert.equal(l.marks.length, 1);
  assert.equal(l.counts.undated, 2);
  const x = l.marks[0].x;
  assert.ok(Math.abs(x - (l.plotLeft + l.plotRight) / 2) < 1, "a single trade is centred");
  assert.ok(l.ticks.length >= 1);
});

test("buys sit above, sells below, others on the axis; marks come out in date order", () => {
  const rows = [trade("2026-05-03", "sale"), trade("2026-05-01", "purchase"), trade("2026-05-02", "exchange")];
  const l = layoutTimeline(rows, { width: 600, today: "2026-10-18" });
  assert.deepEqual(
    l.marks.map((m) => [m.trade.tx_date, m.side]),
    [
      ["2026-05-01", "buy"],
      ["2026-05-02", "other"],
      ["2026-05-03", "sell"],
    ]
  );
  assert.equal(l.marks[1].y, 0);
  assert.deepEqual(l.counts, { buy: 1, sell: 1, other: 1, undated: 0, afterFiling: 0 });
});

test("mergeBins folds +N counters that would print on top of each other", () => {
  const merged = mergeBins([
    { side: "buy", x: 100, count: 3 },
    { side: "buy", x: 114, count: 1 },
    { side: "buy", x: 300, count: 2 },
  ]);
  assert.deepEqual(merged, [
    { side: "buy", x: 103.5, count: 4 },
    { side: "buy", x: 300, count: 2 },
  ]);
});

test("a dense day overflows into a counted +N rather than an unbounded column", () => {
  const rows = Array.from({ length: 60 }, () => trade("2026-05-01"));
  const l = layoutTimeline(rows, { width: 600, today: "2026-10-18", maxExtent: 60 });
  const drawn = l.marks.length;
  const over = l.overflow.reduce((n, o) => n + o.count, 0);
  assert.equal(drawn + over, 60, "every trade is either drawn or counted");
  assert.ok(over > 0);
  assert.ok(l.above <= 60 + 2 + 16);
});
