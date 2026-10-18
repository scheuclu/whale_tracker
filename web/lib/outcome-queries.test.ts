import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import {
  getAlertOutcomes,
  getOutcomeSummary,
  isListedTicker,
  median,
  signedExcess,
  summarize,
  type OutcomeInput,
} from "./outcome-queries.ts";

// The aggregate is computed here and in stats.outcome_summary on the same
// stored rows; this fixture is the one tests/test_alert_outcomes.py uses, so
// the two are checked against the same expectations.
const ROWS: Array<[string, string | null, number | null, number | null, number | null]> = [
  ["cluster", "buy", 0.02, 0.05, null],
  ["cluster", "buy", -0.01, 0.01, null],
  ["cluster", "sell", -0.03, 0.02, null], // a fall: the sell was right
  ["cluster", "sell", 0.0, null, null], // flat: not a hit
  ["cluster", "buy", 0.04, null, null],
  ["cluster", null, 0.1, 0.1, 0.1], // both sides: no claim, excluded
  ["insider_cluster", "buy", 0.01, null, null],
];
const INPUT: OutcomeInput[] = ROWS.map(([kind, direction, e5, e20, e60]) => ({
  kind,
  direction,
  excess_5: e5,
  excess_20: e20,
  excess_60: e60,
}));

const close = (a: number | null, b: number) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("a sell alert's hit is a fall, and an alert with no direction makes no claim", () => {
  assert.equal(signedExcess(0.02, "buy"), 0.02);
  assert.equal(signedExcess(0.02, "sell"), -0.02);
  assert.equal(signedExcess(-0.03, "sell"), 0.03);
  assert.equal(signedExcess(0.02, null), null);
  assert.equal(signedExcess(null, "buy"), null);
});

test("median averages the two middle values of an even count", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("a bare CIK is not a listed ticker", () => {
  assert.ok(isListedTicker("BRK.B"));
  assert.ok(!isListedTicker("0001742952"));
  assert.ok(!isListedTicker(null));
});

test("the summary is per kind and horizon with n next to every figure", () => {
  const byKind = summarize(INPUT);
  assert.deepEqual(
    byKind.map((k) => k.kind),
    ["cluster", "insider_cluster"]
  );
  const cluster = byKind[0].horizons;
  // +5: signed 0.02, -0.01, 0.03, 0, 0.04 → median 0.02, three above zero.
  assert.equal(cluster[0].n, 5);
  close(cluster[0].median_excess, 0.02);
  close(cluster[0].hit_rate, 0.6);
  assert.ok(cluster[0].sufficient);
  // +20: 0.05, 0.01, -0.02 → reported, not sufficient.
  assert.equal(cluster[1].n, 3);
  close(cluster[1].median_excess, 0.01);
  close(cluster[1].hit_rate, 2 / 3);
  assert.ok(!cluster[1].sufficient);
  // +60: the undirected alert is the only one with a value, and it is excluded.
  assert.deepEqual([cluster[2].n, cluster[2].median_excess, cluster[2].hit_rate], [0, null, null]);
  const insider = byKind[1].horizons[0];
  assert.deepEqual([insider.n, insider.median_excess, insider.hit_rate, insider.sufficient], [1, 0.01, 1, false]);
});

// The stored shape, read back. Its own database so TRADES_DB_FILE can point
// at it before lib/db.ts first opens anything (node:test runs each file in
// its own process).
test("stored outcomes and the coverage summary are read, never re-derived", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-outcomes-"));
  const file = path.join(dir, "t.sqlite3");
  const db = new Database(file);
  db.exec(`
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticker TEXT, direction TEXT,
      window_days INTEGER NOT NULL DEFAULT 0, politician_count INTEGER NOT NULL,
      volume_mid_cents INTEGER, fired_at TEXT NOT NULL);
    CREATE TABLE prices (ticker TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
      source TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (ticker, date));
    CREATE TABLE alert_outcomes (alert_id INTEGER PRIMARY KEY, ticker TEXT NOT NULL, t0_date TEXT NOT NULL,
      t0_close REAL NOT NULL, days_elapsed INTEGER NOT NULL,
      ret_5 REAL, bench_5 REAL, excess_5 REAL, ret_20 REAL, bench_20 REAL, excess_20 REAL,
      ret_60 REAL, bench_60 REAL, excess_60 REAL, computed_at TEXT NOT NULL);
    CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);
    INSERT INTO sync_state VALUES ('prices_status', 'ok: 3 ticker(s) refreshed, 7 outcome(s)', 'x');
    INSERT INTO prices VALUES ('SPY', '2026-09-08', 100, 'yahoo', 'x'), ('SPY', '2026-10-16', 110, 'yahoo', 'x'),
                              ('TKR', '2026-09-08', 50, 'yahoo', 'x');
  `);
  const alert = db.prepare("INSERT INTO alerts (kind, ticker, direction, politician_count, fired_at) VALUES (?,?,?,3,'2026-09-07T14:20:12Z')");
  const outcome = db.prepare(
    "INSERT INTO alert_outcomes VALUES (?, 'TKR', '2026-09-08', 50, 28, ?, 0, ?, ?, 0, ?, ?, 0, ?, 'x')"
  );
  for (const [kind, direction, e5, e20, e60] of ROWS) {
    const id = Number(alert.run(kind, "TKR", direction).lastInsertRowid);
    outcome.run(id, e5, e5, e20, e20, e60, e60);
  }
  // Two alerts nothing can price: one with no ticker, one on a symbol the source lacks.
  alert.run("filing", null, "buy");
  alert.run("watchlist", "ZZZ", "buy");
  alert.run("insider_cluster", "0001742952", "buy");
  db.close();

  process.env.TRADES_DB_FILE = file;
  try {
    const outcomes = await getAlertOutcomes();
    assert.equal(outcomes.size, ROWS.length);
    const first = outcomes.get(1);
    assert.ok(first);
    assert.equal(first.t0_date, "2026-09-08");
    assert.equal(first.excess_5, 0.02);
    assert.equal(first.excess_60, null, "a horizon not reached is null, not zero");

    const s = await getOutcomeSummary();
    assert.ok(s.available);
    assert.equal(s.status, "ok: 3 ticker(s) refreshed, 7 outcome(s)");
    assert.equal(s.newest_close, "2026-10-16");
    assert.equal(s.alerts_total, ROWS.length + 3);
    assert.equal(s.alerts_listed, ROWS.length + 1, "the CIK-keyed and the ticker-less alerts are not listed");
    assert.equal(s.alerts_priced, ROWS.length);
    assert.deepEqual(s.no_series, ["ZZZ"]);
    assert.deepEqual(s.byKind, summarize(INPUT), "the page aggregates exactly the stored rows");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
