import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * In production the bot commits `data/trades.sqlite3` to the repo and this
 * fetches it over HTTP, so the dashboard reflects the latest run with no
 * redeploy. Locally it opens the working-copy file directly.
 */
const DB_URL = process.env.TRADES_DB_URL;
const LOCAL_DB = path.join(process.cwd(), "..", "data", "trades.sqlite3");
const TTL_MS = 120_000;
/** Grace period before closing a superseded handle in-flight queries may hold. */
const RETIRE_MS = 60_000;

let cached: { db: Database.Database; file: string | null; fetchedAt: number } | null = null;
let inflight: Promise<Database.Database> | null = null;
let seq = 0;

function retire(entry: { db: Database.Database; file: string | null }) {
  const timer = setTimeout(() => {
    try {
      entry.db.close();
    } catch {
      /* already closed */
    }
    if (entry.file) fs.rm(entry.file, { force: true }, () => {});
  }, RETIRE_MS);
  timer.unref?.();
}

async function refresh(): Promise<Database.Database> {
  if (!DB_URL) {
    if (!fs.existsSync(LOCAL_DB)) {
      throw new Error(
        `no database at ${LOCAL_DB} — run \`python -m whale backfill --year 2026\`, ` +
          `or set TRADES_DB_URL to the committed copy`
      );
    }
    const db = new Database(LOCAL_DB, { readonly: true, fileMustExist: true });
    const previous = cached;
    cached = { db, file: null, fetchedAt: Date.now() };
    if (previous) retire(previous);
    return db;
  }

  const resp = await fetch(`${DB_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) {
    if (cached) return cached.db; // stale is better than broken
    throw new Error(`trade database fetch failed: ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());

  // Each refresh gets its own file: overwriting a file an open handle is
  // reading can corrupt in-flight reads.
  const file = path.join(os.tmpdir(), `trades-${process.pid}-${seq++}.sqlite3`);
  fs.writeFileSync(file, buf);
  const db = new Database(file, { readonly: true, fileMustExist: true });

  const previous = cached;
  cached = { db, file, fetchedAt: Date.now() };
  if (previous) retire(previous);
  return db;
}

/**
 * The trade database, opened read-only with a short TTL.
 *
 * Concurrent callers (server components render in parallel) share a single
 * in-flight refresh, and a superseded handle is only closed after a grace
 * period — otherwise one render closes a database another is still reading.
 */
export async function getDb(): Promise<Database.Database> {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.db;
  if (!inflight) {
    inflight = refresh().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
