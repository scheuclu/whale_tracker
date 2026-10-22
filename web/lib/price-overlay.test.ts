import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  CONGRESS_RULE,
  INSIDER_RULE,
  OVERFLOW_BAND,
  alignToSessions,
  chartDomain,
  clusterSpans,
  congressDirection,
  congressEvents,
  crosshairStops,
  indexTo100,
  insiderEvents,
  layoutOverlay,
  linePath,
  midCents,
  nearestStop,
  niceTicks,
  toSessions,
  type CongressRow,
  type LaneTrade,
} from "./price-overlay.ts";
import { dayNumber as d } from "./timeline.ts";

/* ---------------------------------------------------------- config drift */

test("the cluster rules match config.yaml (alerts.* and insiders.*)", () => {
  const yaml = fs.readFileSync(path.join(process.cwd(), "..", "config.yaml"), "utf8");
  const block = (name: string) => {
    const m = new RegExp(`^${name}:\\n((?:[ #].*\\n|\\n)*)`, "m").exec(yaml);
    assert.ok(m, `config.yaml has a ${name} block`);
    return m![1];
  };
  const num = (text: string, key: string) => {
    const m = new RegExp(`^  ${key}:\\s*([0-9.]+)`, "m").exec(text);
    assert.ok(m, `config.yaml sets ${key}`);
    return Number(m![1]);
  };
  const alerts = block("alerts");
  assert.equal(num(alerts, "window_days"), CONGRESS_RULE.windowDays);
  assert.equal(num(alerts, "min_politicians"), CONGRESS_RULE.minPeople);
  assert.equal(num(alerts, "min_member_floor_usd") * 100, CONGRESS_RULE.minPersonFloorCents);
  assert.equal(num(alerts, "min_volume_usd") * 100, CONGRESS_RULE.minVolumeCents);
  const types = /^  cluster_asset_types:\s*\[([^\]]*)\]/m.exec(alerts);
  assert.deepEqual(types![1].split(",").map((s) => s.trim()), [...CONGRESS_RULE.assetTypes]);
  assert.match(alerts, new RegExp(`^  cluster_count_options:\\s*${CONGRESS_RULE.countOptions}`, "m"));
  const insiders = block("insiders");
  assert.equal(num(insiders, "cluster_window_days"), INSIDER_RULE.windowDays);
  assert.equal(num(insiders, "min_insiders"), INSIDER_RULE.minPeople);
});

/* -------------------------------------------------------- cluster spans */

let id = 1;
function row(date: string, member: string, extra: Partial<CongressRow> = {}): CongressRow {
  return {
    tx_date: date,
    action: "purchase",
    asset_type: "ST",
    option_kind: null,
    member_name: member,
    amount_min_cents: 250_001_00,
    amount_max_cents: 500_000_00,
    amount_exact_cents: null,
    transcribed: 0,
    ...extra,
  };
}

test("a congressional span needs min members over the floor AND the volume, inside one 90-day window", () => {
  const rows = [row("2026-01-05", "A"), row("2026-02-10", "B"), row("2026-03-20", "C")];
  const spans = clusterSpans(congressEvents(rows), CONGRESS_RULE, "congress");
  assert.equal(spans.length, 1);
  assert.deepEqual(
    { start: spans[0].start, end: spans[0].end, peak: spans[0].peak, people: spans[0].people, side: spans[0].side },
    { start: "2026-01-05", end: "2026-03-20", peak: 3, people: ["A", "B", "C"], side: "buy" }
  );
  // Third trade 91 days after the first: no window holds all three.
  const apart = [row("2026-01-05", "A"), row("2026-02-10", "B"), row("2026-04-06", "C")];
  assert.equal(d("2026-04-06")! - d("2026-01-05")!, 91);
  assert.deepEqual(clusterSpans(congressEvents(apart), CONGRESS_RULE, "congress"), []);
  // Exactly 90 days apart is inside: the window is [end − 90, end], as stats._window_start.
  const edge = [row("2026-01-05", "A"), row("2026-02-10", "B"), row("2026-04-05", "C")];
  assert.equal(clusterSpans(congressEvents(edge), CONGRESS_RULE, "congress").length, 1);
});

test("members below the floor are not counted, and lowest-bracket participation is not a cluster", () => {
  const low = { amount_min_cents: 1_001_00, amount_max_cents: 15_000_00 };
  const many = ["A", "B", "C", "D", "E"].map((m, i) => row(`2026-03-0${i + 1}`, m, low));
  assert.deepEqual(clusterSpans(congressEvents(many), CONGRESS_RULE, "congress"), []);
  // Two lowest-bracket trades ($2,002 in floors) still do not count C…
  const two = [row("2026-03-01", "A"), row("2026-03-02", "B"), row("2026-03-03", "C", low), row("2026-03-04", "C", low)];
  assert.deepEqual(clusterSpans(congressEvents(two), CONGRESS_RULE, "congress"), []);
  // …a $15,001–$50,000 trade does, and the span starts at C's counted trades too.
  const big = [...two, row("2026-03-05", "C", { amount_min_cents: 15_001_00, amount_max_cents: 50_000_00 })];
  const spans = clusterSpans(congressEvents(big), CONGRESS_RULE, "congress");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].peak, 3);
  assert.deepEqual([spans[0].start, spans[0].end], ["2026-03-01", "2026-03-05"]);
});

test("the volume test uses bracket midpoints, the open-ended top bracket at its floor", () => {
  assert.equal(midCents(1_001_00, 15_000_00, null), 8_000_50);
  assert.equal(midCents(50_000_001_00, null, null), 50_000_001_00);
  assert.equal(midCents(null, null, 123), 123);
  assert.equal(midCents(null, 15_000_00, null), 0);
  // Three members at $15,001–$50,000: floors clear, est. volume $97.5k does not reach $500k.
  const mid = { amount_min_cents: 15_001_00, amount_max_cents: 50_000_00 };
  const rows = ["A", "B", "C"].map((m) => row("2026-03-01", m, mid));
  assert.deepEqual(clusterSpans(congressEvents(rows), CONGRESS_RULE, "congress"), []);
});

test("cluster events skip Treasury-like types, parsed options, exchanges; transcribed rows add no floor", () => {
  const rows = [
    row("2026-03-01", "A", { asset_type: "GS" }),
    row("2026-03-01", "B", { asset_type: "OP", option_kind: "call" }),
    row("2026-03-01", "C", { action: "exchange" }),
    row("2026-03-01", "D", { transcribed: 1 }),
    row("2026-03-01", "E", { asset_type: "OP", option_kind: null }),
    row("2026-03-01", "F", { action: "sale_partial" }),
  ];
  const ev = congressEvents(rows);
  assert.deepEqual(
    ev.map((e) => [e.who, e.side, e.floor]),
    [
      ["D", "buy", 0],
      ["E", "buy", 250_001_00],
      ["F", "sell", 250_001_00],
    ]
  );
  assert.equal(congressDirection("purchase", "put", true), "sell");
  assert.equal(congressDirection("sale", "put", true), "buy");
  assert.equal(congressDirection("purchase", "call", false), null);
});

test("buys and sells are evaluated apart; overlapping windows merge into one span", () => {
  const rows = [
    row("2026-01-01", "A"),
    row("2026-01-10", "B"),
    row("2026-01-20", "C"),
    row("2026-03-01", "D"),
    row("2026-03-02", "A", { action: "sale" }),
    row("2026-03-03", "B", { action: "sale" }),
  ];
  const spans = clusterSpans(congressEvents(rows), CONGRESS_RULE, "congress");
  assert.equal(spans.length, 1, "two sellers are not a cluster, and never borrow the buyers");
  assert.equal(spans[0].start, "2026-01-01");
  assert.equal(spans[0].end, "2026-03-01");
  assert.equal(spans[0].peak, 4);
  assert.deepEqual(spans[0].people, ["A", "B", "C", "D"]);
});

test("insider spans count distinct primary owners in 30 days; a joint CIK repeated counts once", () => {
  const ins = (date: string, cik: string, action = "purchase") => ({ tx_date: date, action, insider_cik: cik });
  const rows = [ins("2026-05-01", "1"), ins("2026-05-02", "1"), ins("2026-05-10", "2"), ins("2026-05-31", "3")];
  const spans = clusterSpans(insiderEvents(rows), INSIDER_RULE, "insider");
  assert.equal(spans.length, 1);
  assert.deepEqual([spans[0].start, spans[0].end, spans[0].peak], ["2026-05-01", "2026-05-31", 3]);
  const late = [ins("2026-05-01", "1"), ins("2026-05-10", "2"), ins("2026-06-01", "3")];
  assert.deepEqual(clusterSpans(insiderEvents(late), INSIDER_RULE, "insider"), [], "31 days apart");
  // Other transaction codes never count; sales are their own direction.
  const mixed = [ins("2026-05-01", "1", "sale"), ins("2026-05-02", "2", "sale"), ins("2026-05-03", "3", "award")];
  assert.deepEqual(clusterSpans(insiderEvents(mixed), INSIDER_RULE, "insider"), []);
});

/* ---------------------------------------------------------------- domain */

test("domain: shortly before the first trade to today; typo dates are left off and counted", () => {
  const dom = chartDomain(["2026-03-01", "2026-06-01", "2016-02-01", "2027-01-01", null], "2026-10-22")!;
  assert.equal(dom.hi, "2026-10-22");
  assert.ok(dom.lo < "2026-03-01" && dom.lo >= "2026-02-01");
  assert.equal(dom.outside, 2);
  // A single recent trade still gets a readable span.
  const one = chartDomain(["2026-10-20"], "2026-10-22")!;
  assert.equal(d(one.hi)! - d(one.lo)!, 120);
  assert.equal(chartDomain([null], "2026-10-22"), null);
  assert.equal(chartDomain(["2027-01-01"], "2026-10-22"), null);
});

/* ------------------------------------------------------------- alignment */

// Thu 2 Jul 2026, then Independence Day observed Fri 3 Jul, the weekend, Mon 6 Jul.
const SESSIONS = toSessions([
  { date: "2026-07-06", close: 103 },
  { date: "2026-07-01", close: 100 },
  { date: "2026-07-02", close: 101 },
  { date: "2026-07-07", close: 0 },
]);

test("sessions are sorted, and a zero close is not a session", () => {
  assert.deepEqual(SESSIONS.map((s) => s.close), [100, 101, 103]);
});

test("a trade on a session aligns to it; on a holiday or weekend it sits between the sessions around it", () => {
  assert.deepEqual(alignToSessions(d("2026-07-02")!, SESSIONS), { at: 1, prev: null, next: null });
  // Holiday (Fri 3 Jul) and the weekend: no session; prev Thu 2 Jul, next Mon 6 Jul.
  for (const day of ["2026-07-03", "2026-07-04", "2026-07-05"]) {
    assert.deepEqual(alignToSessions(d(day)!, SESSIONS), { at: null, prev: 1, next: 2 }, day);
  }
  // Before the first session and after the last final close.
  assert.deepEqual(alignToSessions(d("2026-06-30")!, SESSIONS), { at: null, prev: null, next: 0 });
  assert.deepEqual(alignToSessions(d("2026-07-08")!, SESSIONS), { at: null, prev: 2, next: null });
  assert.deepEqual(alignToSessions(d("2026-07-08")!, []), { at: null, prev: null, next: null });
});

test("crosshair stops are every session plus every trade date that is not one, inside the domain", () => {
  const stops = crosshairStops(SESSIONS, [d("2026-07-04")!, d("2026-07-02")!, d("2026-12-01")!], d("2026-07-01")!, d("2026-07-31")!);
  assert.deepEqual(stops, ["2026-07-01", "2026-07-02", "2026-07-04", "2026-07-06"].map((x) => d(x)!));
  assert.equal(nearestStop(stops, d("2026-07-03")!), 1, "ties go to the earlier stop");
  assert.equal(nearestStop(stops, d("2026-07-05")! + 0.6), 3);
  assert.equal(nearestStop(stops, -1e9), 0);
  assert.equal(nearestStop(stops, 1e9), 3);
  assert.equal(nearestStop([], 5), null);
});

test("vs SPY rebases to 100 at the first session on or after the start; one axis", () => {
  const idx = indexTo100(SESSIONS, d("2026-07-02")!);
  assert.deepEqual(idx.map((s) => Math.round(s.close * 100) / 100), [100, 101.98]);
  assert.deepEqual(indexTo100(SESSIONS, d("2026-08-01")!), []);
});

test("nice ticks are round and cover the range", () => {
  assert.deepEqual(niceTicks(101, 187, 4), [120, 140, 160, 180]);
  assert.deepEqual(niceTicks(0.42, 0.61, 4), [0.45, 0.5, 0.55, 0.6]);
  assert.ok(niceTicks(50, 50).length >= 1);
  assert.deepEqual(niceTicks(Number.NaN, 1), []);
});

/* ---------------------------------------------------------------- layout */

const trade = (date: string, side: LaneTrade["side"], cents: number | null, tid: number): LaneTrade => ({
  id: tid,
  date,
  side,
  sizeCents: cents,
  who: "x",
  amount: "x",
});

test("layout: one x scale for every panel; buys above a lane's centre, sells below; out-of-domain dropped", () => {
  const L = layoutOverlay({
    width: 1040,
    priceHeight: 200,
    laneHalf: 26,
    lo: "2026-01-01",
    hi: "2026-12-31",
    lanes: [
      { source: "congress", trades: [trade("2026-07-01", "buy", 1_001_00, 1), trade("2026-07-01", "sell", 1_001_00, 2), trade("2025-01-01", "buy", 1, 3)] },
      { source: "insider", trades: [trade("2026-07-01", "buy", null, 4)] },
    ],
  });
  assert.equal(L.lanes.length, 2);
  const [c, i] = L.lanes;
  assert.equal(c.marks.length, 2);
  const buy = c.marks.find((m) => m.trade.side === "buy")!;
  const sell = c.marks.find((m) => m.trade.side === "sell")!;
  assert.ok(buy.y < c.mid && sell.y > c.mid);
  assert.equal(buy.x, sell.x);
  assert.equal(i.marks[0].x, buy.x, "the same date lands at the same x in every lane");
  assert.ok(i.top > c.bottom && L.axisY > i.bottom && c.top > L.priceBottom);
  assert.ok(Math.abs(L.dayAt(L.x(d("2026-07-01")!)) - d("2026-07-01")!) < 1e-9);
  assert.equal(L.x(d("2026-01-01")!), L.plotLeft);
  assert.equal(L.x(d("2026-12-31")!), L.plotRight);
});

test("layout: marks past the lane height become a +N count, never silently dropped", () => {
  const many = Array.from({ length: 40 }, (_, k) => trade("2026-07-01", "buy", 1_000_000_00, k + 1));
  const L = layoutOverlay({ width: 352, priceHeight: 150, laneHalf: 22, lo: "2026-06-01", hi: "2026-08-01", lanes: [{ source: "insider", trades: many }] });
  const lane = L.lanes[0];
  const over = lane.overflow.reduce((n, o) => n + o.count, 0);
  assert.ok(over > 0);
  assert.equal(lane.marks.length + over, 40);
  // Marks stay clear of the band the "+N" counters print in.
  for (const m of lane.marks) assert.ok(lane.mid - m.y + m.r <= 22 - OVERFLOW_BAND);
});

test("the line path covers only sessions inside the domain", () => {
  const p = linePath(SESSIONS, (x) => x, (v) => v, d("2026-07-02")!, d("2026-07-31")!);
  assert.equal(p, `M${d("2026-07-02")} 101L${d("2026-07-06")} 103`);
});
