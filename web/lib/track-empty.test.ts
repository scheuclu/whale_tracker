import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { buildTrackRecord } from "./api-v1.ts";
import { getMemberTrack, getTrackLeaderboard, memberTrackState } from "./track-queries.ts";

// The state between the schema-16 migration and the first scoring pass: the
// tables exist and are empty. The member section must say "being computed"
// (not "0 of 0 decisions") and the API must say so once, in one notices list.

test("empty track tables read as being computed everywhere", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-track-empty-"));
  const file = path.join(dir, "t.sqlite3");
  const db = new Database(file);
  db.exec(`
    CREATE TABLE politicians (id INTEGER PRIMARY KEY, bioguide_id TEXT, full_name TEXT NOT NULL, party TEXT,
      state TEXT, district TEXT, chamber TEXT);
    CREATE TABLE filings (id INTEGER PRIMARY KEY, filing_date TEXT, updated_at TEXT);
    CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE track_decisions (id INTEGER PRIMARY KEY, filing_id INTEGER, member_name TEXT, ticker TEXT,
      direction TEXT, tx_date TEXT, exclusion TEXT, t0_trade TEXT, t0_disclosure TEXT, series_ended TEXT,
      signed_trade_30 REAL, signed_trade_90 REAL, signed_trade_180 REAL,
      signed_disclosure_30 REAL, signed_disclosure_90 REAL, signed_disclosure_180 REAL);
    CREATE TABLE track_scores (member_name TEXT, politician_id INTEGER, horizon INTEGER, n INTEGER, filings INTEGER,
      min_decisions INTEGER, min_filings INTEGER, qualifies INTEGER, rank INTEGER, trade_mean REAL, trade_score REAL,
      trade_lo REAL, trade_hi REAL, trade_hit_rate REAL, trade_luck REAL, disclosure_mean REAL, disclosure_score REAL,
      disclosure_lo REAL, disclosure_hi REAL, disclosure_hit_rate REAL, disclosure_luck REAL, computed_at TEXT);
    CREATE TABLE track_model (clock TEXT, horizon INTEGER, k REAL, mean REAL, decisions INTEGER, members INTEGER,
      ranked INTEGER, min_decisions INTEGER, min_filings INTEGER, computed_at TEXT);
    CREATE TABLE track_coverage (outcome TEXT, rows INTEGER, decisions INTEGER, computed_at TEXT);
  `);
  db.close();
  process.env.TRADES_DB_FILE = file;
  try {
    const member = await getMemberTrack("Nancy Pelosi");
    assert.equal(member.available, true, "the tables exist");
    assert.equal(member.min_decisions, null);
    assert.equal(memberTrackState(member), "computing");
    const board = await getTrackLeaderboard(90);
    assert.equal(board.model.trade, null, "the leaderboard falls back to computing on the missing model too");
    const api = await buildTrackRecord("https://x.test", new URLSearchParams());
    const notices = (api.body as { meta: { notices?: string[] } }).meta.notices ?? [];
    assert.deepEqual(notices, ["The track record is being computed by the pipeline; no scores yet."]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
