import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The same queries once the pipeline has migrated the database to schema 13
// and begun logging the per-filing kinds. That shape cannot be in the
// committed file until the workflow next runs, so this builds it: a scratch
// copy migrated by the Python package and given one alert of each new kind.
// Its own file because node:test runs each file in its own process, which
// is what lets TRADES_DB_FILE be set before lib/db.ts is first imported.
// Runs only where the Python venv exists; CI's web job has no Python.

const python = path.resolve("..", ".venv", "bin", "python");
const committed = path.resolve("..", "data", "trades.sqlite3");
const skip =
  fs.existsSync(python) && fs.existsSync(committed) ? false : "needs ../.venv and the committed database";

const SEED = `
import sys
from pathlib import Path
from whale import db, stats
conn = db.connect(Path(sys.argv[1]))
filing = conn.execute(
    "SELECT id FROM filings WHERE status IN ('notified', 'backfilled') AND politician_id IS NOT NULL"
    " ORDER BY id LIMIT 1").fetchone()
tx = conn.execute("SELECT id, ticker FROM transactions WHERE filing_id = ? ORDER BY id LIMIT 1",
                  (filing["id"],)).fetchone()
insider = conn.execute(
    "SELECT id, ticker FROM insider_filings WHERE ticker IS NOT NULL ORDER BY id LIMIT 1").fetchone()
db.record_alert(conn, stats.FILING_KIND, None, "buy", 0, 1, participants="Test Member",
                filing_id=filing["id"], volume_min_cents=200_200, volume_max_cents=None,
                volume_mid_cents=100_100_100,
                message="\\U0001F3DB <b>New filing \\u2014 Rep. Test &amp; Co</b>\\nFiled 2026-10-18 \\u00b7 2 transactions")
db.record_alert(conn, stats.WATCHLIST_KIND, tx["ticker"], "sell", 0, 1, participants="Test Member",
                filing_id=filing["id"], transaction_id=tx["id"], volume_min_cents=100_100,
                volume_max_cents=1_500_000, volume_mid_cents=800_050, message="<b>WATCHLIST</b>")
db.record_alert(conn, stats.INSIDER_FILING_KIND, insider["ticker"], "buy", 0, 1,
                participants="Some Insider", rule_name="Large buy", insider_filing_id=insider["id"],
                volume_min_cents=500_000_000, volume_max_cents=500_000_000,
                volume_mid_cents=500_000_000, message="<b>Large buy</b>")
conn.commit()
`;

test("the schema-13 shape: ranges, participants, links and message text come through", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whale-alerts-"));
  const file = path.join(dir, "trades.sqlite3");
  fs.copyFileSync(committed, file);
  try {
    execFileSync(python, ["-c", SEED, file], { stdio: "pipe" });
    process.env.TRADES_DB_FILE = file;
    const aq = await import("./alert-queries.ts");

    const totals = await aq.getAlertTotals();
    assert.ok(totals.recorded_since, "migration 13 writes alerts_recorded_since");
    const rows = await aq.getAlerts({ limit: 1_000_000 });
    assert.equal(rows.length, totals.total);

    const filing = rows.find((r) => r.kind === "filing");
    assert.ok(filing, "the filing alert is listed");
    assert.equal(filing.ticker, null, "a filing spanning tickers is about none of them");
    assert.equal(filing.volume_min_cents, 200_200);
    assert.equal(filing.volume_max_cents, null, "open-ended: a floor, never an invented ceiling");
    assert.ok(filing.member_name && filing.pdf_url, "joined to the filing and its member");
    assert.ok(filing.message?.includes("&amp;"), "stored as sent, Telegram HTML and all");

    const watch = rows.find((r) => r.kind === "watchlist");
    assert.ok(watch?.transaction_id, "a watchlist alert points at its transaction");
    assert.equal(watch.filing_id, filing.filing_id);

    const ins = rows.find((r) => r.kind === "insider_filing");
    assert.ok(ins, "the insider filing alert is listed");
    assert.equal(ins.rule_name, "Large buy");
    assert.ok(ins.source_url && ins.issuer_name, "joined to the Form 4 and its issuer");
    assert.equal(ins.volume_min_cents, ins.volume_max_cents, "an exact value: min = max");

    // The rows from before schema 13 are still there, with only their dedupe fields.
    const legacy = rows.filter((r) => r.message == null);
    assert.ok(legacy.length >= 64, `the 64 pre-13 rows survive the rebuild; got ${legacy.length}`);
    assert.ok(legacy.every((r) => r.volume_min_cents == null && r.participants == null));

    const byKind = await aq.getAlerts({ kind: "watchlist" });
    assert.equal(byKind.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
