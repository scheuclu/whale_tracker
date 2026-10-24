import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { buildTrackRecord } from "./api-v1.ts";
import { getMemberTrack, getTrackLeaderboard, parseTrackHorizon, percent, points } from "./track-queries.ts";

// The scores are derived once in Python (stats.track_scores) and only read
// here: this fixture stores them the way track.rescore_all does and checks
// that the page and the API return exactly what was stored — ranks, minimum
// and all — without recomputing a thing.

test("points and horizons", () => {
  assert.equal(points(0.0421), "+4.2");
  assert.equal(points(-0.01), "−1.0");
  assert.equal(points(0.0004), "0.0");
  assert.equal(points(null), "—");
  assert.equal(percent(0.866), "87%");
  assert.equal(parseTrackHorizon("30"), 30);
  assert.equal(parseTrackHorizon("180"), 90, "180 is API-only: the page falls back to the default");
  assert.equal(parseTrackHorizon("180", [30, 90, 180]), 180);
  assert.equal(parseTrackHorizon(undefined), 90);
  assert.equal(parseTrackHorizon("abc"), 90);
});

const DDL = `
  CREATE TABLE politicians (id INTEGER PRIMARY KEY, bioguide_id TEXT UNIQUE, full_name TEXT NOT NULL,
    first TEXT, last TEXT, chamber TEXT, party TEXT, state TEXT, district TEXT, active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL);
  CREATE TABLE filings (id INTEGER PRIMARY KEY, chamber TEXT NOT NULL, doc_id TEXT NOT NULL, politician_id INTEGER,
    filer_name TEXT NOT NULL, state_district TEXT, filing_type TEXT NOT NULL, filing_date TEXT, year INTEGER NOT NULL,
    pdf_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', parse_method TEXT, notified_at TEXT, last_error TEXT,
    first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE track_decisions (id INTEGER PRIMARY KEY, filing_id INTEGER NOT NULL, politician_id INTEGER,
    member_name TEXT NOT NULL, ticker TEXT NOT NULL, direction TEXT NOT NULL, tx_date TEXT, rows INTEGER NOT NULL,
    exclusion TEXT, t0_trade TEXT, t0_disclosure TEXT,
    signed_trade_30 REAL, signed_trade_90 REAL, signed_trade_180 REAL,
    signed_disclosure_30 REAL, signed_disclosure_90 REAL, signed_disclosure_180 REAL, checked_through TEXT);
  CREATE TABLE track_scores (member_name TEXT NOT NULL, politician_id INTEGER, horizon INTEGER NOT NULL,
    n INTEGER NOT NULL, filings INTEGER NOT NULL, min_decisions INTEGER NOT NULL, min_filings INTEGER NOT NULL,
    qualifies INTEGER NOT NULL, rank INTEGER,
    trade_mean REAL NOT NULL, trade_score REAL NOT NULL, trade_lo REAL, trade_hi REAL, trade_hit_rate REAL NOT NULL, trade_luck REAL,
    disclosure_mean REAL NOT NULL, disclosure_score REAL NOT NULL, disclosure_lo REAL, disclosure_hi REAL,
    disclosure_hit_rate REAL NOT NULL, disclosure_luck REAL, computed_at TEXT NOT NULL, PRIMARY KEY (member_name, horizon));
  CREATE TABLE track_model (clock TEXT NOT NULL, horizon INTEGER NOT NULL, k REAL, sigma2 REAL, tau2 REAL, mean REAL,
    members_fit INTEGER NOT NULL, decisions INTEGER NOT NULL, members INTEGER NOT NULL, ranked INTEGER NOT NULL,
    min_decisions INTEGER NOT NULL, min_filings INTEGER NOT NULL, computed_at TEXT NOT NULL, PRIMARY KEY (clock, horizon));
  CREATE TABLE track_coverage (outcome TEXT PRIMARY KEY, rows INTEGER NOT NULL, decisions INTEGER NOT NULL, computed_at TEXT NOT NULL);
`;

test("the leaderboard, a member's record and the API read the stored scores", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-track-"));
  const file = path.join(dir, "t.sqlite3");
  const db = new Database(file);
  db.exec(DDL);
  db.exec(`
    INSERT INTO politicians VALUES (1, 'A000001', 'Ann Able', 'Ann', 'Able', 'house', 'D', 'CA', '1', 1, 'x'),
                                   (2, 'B000002', 'Bob Baker', 'Bob', 'Baker', 'senate', 'R', 'TX', NULL, 1, 'x');
    INSERT INTO filings (id, chamber, doc_id, politician_id, filer_name, filing_type, filing_date, year, pdf_url, status, first_seen_at, updated_at)
      VALUES (10, 'house', 'd10', 1, 'Ann Able', 'P', '2026-03-20', 2026, 'u', 'backfilled', 'x', 'x');
    INSERT INTO sync_state VALUES ('track_record_status', 'ok: 3 ticker(s) fetched', 'x');
    INSERT INTO track_scores VALUES
      ('Ann Able', 1, 90, 12, 4, 8, 3, 1, 1, 0.10, 0.05, 0.01, 0.09, 0.75, 0.9, 0.06, 0.03, -0.01, 0.07, 0.6, 0.8, 'now'),
      ('Cy Unmatched', NULL, 90, 9, 3, 8, 3, 1, 2, 0.02, 0.01, -0.03, 0.04, 0.5, NULL, 0.0, 0.0, -0.02, 0.02, 0.4, 0.5, 'now'),
      ('Bob Baker', 2, 90, 3, 1, 8, 3, 0, NULL, 0.20, 0.03, NULL, NULL, 1.0, NULL, 0.1, 0.01, NULL, NULL, 1.0, NULL, 'now'),
      ('Ann Able', 1, 30, 20, 6, 8, 3, 1, 1, 0.01, 0.005, -0.01, 0.02, 0.55, 0.6, 0.0, 0.0, -0.01, 0.01, 0.5, 0.5, 'now');
    INSERT INTO track_model VALUES
      ('trade', 90, 17.0, 0.05, 0.003, 0.004, 30, 24, 3, 2, 8, 3, 'now'),
      ('disclosure', 90, 25.0, 0.05, 0.002, 0.008, 30, 24, 3, 2, 8, 3, 'now'),
      ('trade', 30, 21.0, 0.02, 0.001, -0.008, 30, 50, 3, 1, 8, 3, 'now'),
      ('disclosure', 30, 22.0, 0.02, 0.001, 0.004, 30, 50, 3, 1, 8, 3, 'now');
    INSERT INTO track_coverage VALUES ('transcribed', 5, 0, 'now'), ('included', 40, 30, 'now'), ('option', 2, 2, 'now');
    INSERT INTO track_decisions (filing_id, politician_id, member_name, ticker, direction, tx_date, rows, exclusion,
      t0_trade, t0_disclosure, signed_trade_90, signed_disclosure_90) VALUES
      (10, 1, 'Ann Able', 'AAA', 'buy', '2026-03-02', 1, NULL, '2026-03-02', '2026-03-23', 0.20, 0.10),
      (10, 1, 'Ann Able', 'BBB', 'sell', '2026-03-03', 2, NULL, '2026-03-03', '2026-03-23', -0.05, -0.02),
      (10, 1, 'Ann Able', 'CCC', 'buy', '2026-03-04', 1, NULL, '2026-03-04', '2026-03-23', 0.07, NULL),
      (10, 1, 'Ann Able', 'DDD', 'buy', '2026-03-04', 1, 'option', NULL, NULL, NULL, NULL);
  `);
  db.close();

  process.env.TRADES_DB_FILE = file;
  try {
    const board = await getTrackLeaderboard(90);
    assert.ok(board.available);
    assert.deepEqual(board.ranked.map((r) => [r.member_name, r.rank]), [["Ann Able", 1], ["Cy Unmatched", 2]]);
    assert.deepEqual(board.unranked.map((r) => r.member_name), ["Bob Baker"], "below the minimum: listed, never ranked");
    assert.equal(board.min_decisions, 8);
    assert.equal(board.model.trade?.k, 17);
    assert.equal(board.ranked[0].bioguide_id, "A000001");
    assert.equal(board.ranked[1].bioguide_id, null, "an unmatched filer keeps their name and no id");
    assert.deepEqual(board.coverage.map((c) => c.outcome), ["included", "transcribed", "option"]);

    const ann = await getMemberTrack("Ann Able");
    assert.deepEqual(ann.scores.map((s) => s.horizon), [30, 90]);
    assert.deepEqual(ann.decisions.map((d) => d.ticker), ["AAA", "BBB"], "paired decisions only, best first");
    assert.equal(ann.pending, 1, "a decision missing one clock is still waiting");
    assert.deepEqual(ann.excluded, [{ outcome: "option", decisions: 1 }]);
    assert.equal(ann.ranked_count[90], 2);

    const api = await buildTrackRecord("https://x.test", new URLSearchParams("horizon=90"));
    assert.equal(api.status, 200);
    const data = (api.body as { data: Record<string, unknown> }).data as {
      ranked: { rank: number; after_trade: { shrunk_excess_move_pts: number; interval_90_pts: number[] }; timing_lost_to_disclosure_delay_pts: number }[];
      not_enough_matured_decisions: unknown[];
      measure: string;
    };
    assert.equal(data.ranked[0].after_trade.shrunk_excess_move_pts, 5);
    assert.deepEqual(data.ranked[0].after_trade.interval_90_pts, [1, 9]);
    assert.equal(data.ranked[0].timing_lost_to_disclosure_delay_pts, 2);
    assert.equal(data.not_enough_matured_decisions.length, 1);
    assert.match(data.measure, /not the member's profit/);
    const bad = await buildTrackRecord("https://x.test", new URLSearchParams("horizon=45"));
    assert.equal(bad.status, 400, "an unknown horizon is rejected, not ignored");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
