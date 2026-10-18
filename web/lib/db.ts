import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * In production the bot commits `data/trades.sqlite3` to the repo and this
 * fetches it over HTTP, so the dashboard reflects the latest run with no
 * redeploy. Locally it opens the working-copy file directly.
 *
 * The repo is private, so a plain raw.githubusercontent.com URL 404s. Set
 * `TRADES_DB_REPO` (owner/name) plus `TRADES_DB_TOKEN` (a GitHub PAT with
 * Contents: read) and the database is pulled through the authenticated
 * contents API instead; `TRADES_DB_URL` still works for a public repo.
 */
const DB_URL = process.env.TRADES_DB_URL;
const DB_REPO = process.env.TRADES_DB_REPO;
const DB_REF = process.env.TRADES_DB_REF ?? "main";
const DB_PATH_IN_REPO = process.env.TRADES_DB_PATH ?? "data/trades.sqlite3";
// TRADES_DB_TOKEN is the preferred name — it says what it is for. GITHUB_TOKEN
// is accepted too, but it is a generic name that collides with other tooling's
// conventions, so it is the fallback rather than the documented one.
const DB_TOKEN = process.env.TRADES_DB_TOKEN ?? process.env.GITHUB_TOKEN;
// TRADES_DB_FILE opens a specific local file instead of the working copy (a
// migrated /tmp copy for a render or a test); it is read in `refresh`, not
// folded in here — see the note there about Turbopack's tracing.
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

/** Where to fetch the committed database from, and with what headers. */
function remoteSource(): { url: string; headers: Record<string, string> } | null {
  if (DB_REPO) {
    if (!DB_TOKEN) {
      throw new Error(
        "TRADES_DB_REPO is set but no token — add TRADES_DB_TOKEN (a GitHub PAT " +
          "with Contents: read on that repo)"
      );
    }
    return {
      // The contents API returns the file itself under the raw media type,
      // which is what makes this work for a private repo.
      url: `https://api.github.com/repos/${DB_REPO}/contents/${DB_PATH_IN_REPO}?ref=${DB_REF}`,
      headers: {
        Authorization: `Bearer ${DB_TOKEN}`,
        Accept: "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
  }
  if (DB_URL) return { url: `${DB_URL}?t=${Date.now()}`, headers: {} };
  return null;
}

async function refresh(): Promise<Database.Database> {
  const source = remoteSource();
  if (!source) {
    // TRADES_DB_FILE points a local run at another copy — a test migrating
    // a scratch copy to a newer schema than the committed file. Read here,
    // not folded into LOCAL_DB: Turbopack traces `fs.existsSync` on a path
    // it cannot resolve statically and then bundles the whole repository
    // into the server output.
    const override = process.env.TRADES_DB_FILE;
    if (!override && !fs.existsSync(LOCAL_DB)) {
      const onVercel = Boolean(process.env.VERCEL);
      throw new Error(
        onVercel
          ? "Not configured: set TRADES_DB_REPO=owner/name and TRADES_DB_TOKEN " +
            "(GitHub PAT, Contents: read) in the Vercel project's environment " +
            "variables, then redeploy — env changes do not affect a running " +
            "deployment. The repo checkout is not available at runtime."
          : `no database at ${LOCAL_DB} — run \`python -m whale backfill --year 2026\`, ` +
            `or set TRADES_DB_REPO + TRADES_DB_TOKEN`
      );
    }
    const db = new Database(override ?? LOCAL_DB, { readonly: true, fileMustExist: true });
    const previous = cached;
    cached = { db, file: null, fetchedAt: Date.now() };
    if (previous) retire(previous);
    return db;
  }

  const resp = await fetch(source.url, { cache: "no-store", headers: source.headers });
  if (!resp.ok) {
    if (cached) return cached.db; // stale is better than broken
    throw new Error(
      `trade database fetch failed: ${resp.status}` +
        (resp.status === 404 ? " — wrong repo/ref/path, or the token lacks Contents: read" : "") +
        (resp.status === 401 ? " — token invalid or expired" : "")
    );
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
