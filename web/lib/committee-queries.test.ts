import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

// The committee queries, run against a copy of the committed database with
// the schema-10 tables added and a small roster seeded onto real members.
// The committed file itself may predate the migration (the pipeline applies
// it on its next run), which is exactly why the queries carry a table guard;
// this file is where the SQL behind that guard is actually exercised.
//
// `TRADES_DB_FILE` is read when lib/db.ts loads, so the copy is built before
// the queries are imported.

const SRC = path.join(process.cwd(), "..", "data", "trades.sqlite3");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-committees-"));
const FILE = path.join(dir, "trades.sqlite3");
fs.copyFileSync(SRC, FILE);
process.env.TRADES_DB_FILE = FILE;
delete process.env.TRADES_DB_REPO;
delete process.env.TRADES_DB_URL;

// Mirrors _COMMITTEE_DDL in src/whale/db.py.
const DDL = `
CREATE TABLE IF NOT EXISTS committees (
  thomas_id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES committees(thomas_id) ON DELETE CASCADE,
  chamber TEXT NOT NULL,
  name TEXT NOT NULL,
  house_committee_id TEXT,
  senate_committee_id TEXT,
  url TEXT,
  jurisdiction TEXT,
  jurisdiction_source TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS committee_members (
  committee_id TEXT NOT NULL REFERENCES committees(thomas_id) ON DELETE CASCADE,
  politician_id INTEGER NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
  rank INTEGER,
  party TEXT,
  title TEXT,
  chamber TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (committee_id, politician_id)
);`;

type Member = { id: number; full_name: string };

const seed = new Database(FILE);
seed.exec("DROP TABLE IF EXISTS committee_members; DROP TABLE IF EXISTS committees;");
seed.exec(DDL);
// Two real members with counted trades, and one active member with none.
const [chair, ranking] = seed
  .prepare(
    `SELECT p.id, p.full_name FROM politicians p
     JOIN transactions t ON t.politician_id = p.id
     JOIN filings f ON f.id = t.filing_id
     WHERE f.status IN ('parsed','notified','backfilled')
     GROUP BY p.id ORDER BY COUNT(*) DESC, p.id LIMIT 2`
  )
  .all() as Member[];
const quiet = seed
  .prepare(
    `SELECT p.id, p.full_name FROM politicians p
     WHERE p.active = 1 AND p.bioguide_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.politician_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM filings f WHERE f.filer_name = p.full_name)
     ORDER BY p.id LIMIT 1`
  )
  .get() as Member;
assert.ok(chair && ranking && quiet, "the committed database has the members this test seeds");

const insCommittee = seed.prepare(
  `INSERT INTO committees (thomas_id, parent_id, chamber, name, house_committee_id, url, jurisdiction, jurisdiction_source, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 't')`
);
insCommittee.run("HSIF", null, "house", "House Committee on Energy and Commerce", "IF",
  "https://energycommerce.house.gov/", "Energy, commerce and health.", "https://energycommerce.house.gov/about");
insCommittee.run("HSIF16", "HSIF", "house", "Communications and Technology", null, null, null, null);
insCommittee.run("HSIF17", "HSIF", "house", "Commerce, Manufacturing, and Trade", null, null, null, null);
insCommittee.run("JSEC", null, "joint", "Joint Economic Committee", null, null, null, null);
const insSeat = seed.prepare(
  `INSERT INTO committee_members (committee_id, politician_id, rank, party, title, chamber, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, 't')`
);
insSeat.run("HSIF", chair.id, 1, "majority", "Chair", null);
insSeat.run("HSIF16", chair.id, 2, "majority", null, null);
insSeat.run("HSIF", ranking.id, 1, "minority", "Ranking Member", null);
insSeat.run("HSIF", quiet.id, 4, "minority", null, null);
insSeat.run("JSEC", ranking.id, 1, "majority", "Chairman", "house");
seed.close();

let q: typeof import("./queries.ts");
before(async () => {
  q = await import("./queries.ts");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("the table guard reads the schema, not an assumption", () => {
  const empty = new Database(":memory:");
  assert.equal(q.hasTable(empty, "committees"), false);
  empty.exec("CREATE TABLE committees (thomas_id TEXT PRIMARY KEY)");
  assert.equal(q.hasTable(empty, "committees"), true);
  empty.close();
});

test("a member's seats come back full committee first, then its subcommittees", async () => {
  const seats = await q.getPoliticianCommittees(chair.full_name);
  assert.deepEqual(
    seats.map((s) => [s.thomas_id, s.parent_id, s.parent_name, s.rank, s.side, s.title]),
    [
      ["HSIF", null, null, 1, "majority", "Chair"],
      ["HSIF16", "HSIF", "House Committee on Energy and Commerce", 2, "majority", null],
    ]
  );
});

test("a joint committee seat carries the chamber it is held for", async () => {
  const seats = await q.getPoliticianCommittees(ranking.full_name);
  const jec = seats.find((s) => s.thomas_id === "JSEC");
  assert.ok(jec);
  assert.equal(jec.chamber, "joint");
  assert.equal(jec.seat_chamber, "house");
  assert.equal(jec.title, "Chairman");
});

test("a member with no seat has an empty list, not an error", async () => {
  assert.deepEqual(await q.getPoliticianCommittees("Nobody Atall"), []);
});

test("a committee resolves by id, case-insensitively, with its parent", async () => {
  const c = await q.getCommittee("hsif16");
  assert.ok(c);
  assert.equal(c.name, "Communications and Technology");
  assert.equal(c.parent_id, "HSIF");
  assert.equal(c.parent_name, "House Committee on Energy and Commerce");
  const parent = await q.getCommittee("HSIF");
  assert.ok(parent);
  assert.equal(parent.parent_id, null);
  assert.equal(parent.house_committee_id, "IF");
  assert.equal(parent.jurisdiction_source, "https://energycommerce.house.gov/about");
  assert.equal(await q.getCommittee("XXXX"), null);
});

test("subcommittees list with their seat counts", async () => {
  assert.deepEqual(await q.getSubcommittees("HSIF"), [
    { thomas_id: "HSIF17", name: "Commerce, Manufacturing, and Trade", members: 0 },
    { thomas_id: "HSIF16", name: "Communications and Technology", members: 1 },
  ]);
  assert.deepEqual(await q.getSubcommittees("HSIF16"), []);
});

test("a committee lists every seat, traders first and the rest with zeros", async () => {
  const rows = await q.getCommitteeMembers("HSIF");
  assert.equal(rows.length, 3);
  // The two traders lead, by estimated volume; the seat with no trades is last.
  assert.deepEqual(
    rows
      .slice(0, 2)
      .map((r) => r.member_name)
      .sort(),
    [chair.full_name, ranking.full_name].sort()
  );
  assert.equal(rows[2].member_name, quiet.full_name);
  const silent = rows[2];
  assert.equal(silent.trades, 0);
  assert.equal(silent.volume_mid, 0);
  assert.equal(silent.late_count, 0);
  assert.equal(silent.avg_delay, null);
  assert.equal(silent.side, "minority");
  assert.equal(silent.rank, 4);
  assert.ok(rows[0].volume_mid >= rows[1].volume_mid, "ordered by estimated volume");
});

test("a seat holder's totals are the member page's totals", async () => {
  const [rows, detail] = await Promise.all([
    q.getCommitteeMembers("HSIF"),
    q.getPoliticianDetail(chair.full_name),
  ]);
  const row = rows.find((r) => r.member_name === chair.full_name);
  assert.ok(row && detail);
  assert.ok(detail.trades > 0);
  for (const k of ["trades", "tickers", "buys", "sells", "volume_mid", "transcribed", "late_count"] as const) {
    assert.equal(row[k], detail[k], k);
  }
  assert.equal(row.avg_delay, detail.avg_delay);
});

test("an unknown committee has no members rather than an error", async () => {
  assert.deepEqual(await q.getCommitteeMembers("XXXX"), []);
});
