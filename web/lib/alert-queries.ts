import { getDb } from "./db";

/**
 * The alert log — `alerts` in src/whale/db.py: one row per Telegram message
 * sent, of every kind, plus the dedupe rows the cluster kinds always kept.
 *
 * Two shapes of that table are live at once. The pipeline migrates the
 * committed database to schema 13 (nullable ticker/direction, the disclosed
 * range, participants, the message text) only when it next runs, while this
 * dashboard reads whatever is committed. A query that assumed the new
 * columns would take the page down for the hours in between — and for the
 * Vercel preview of the PR that introduced them. Every query here therefore
 * asks the table which columns it has and selects NULL for the missing ones;
 * keep it that way until the committed database is past schema 13.
 */

/** The message kinds — `stats.ALERT_KINDS` in Python. */
export const ALERT_KINDS = ["cluster", "insider_cluster", "filing", "watchlist", "insider_filing", "options"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const KIND_LABEL: Record<AlertKind, string> = {
  cluster: "Cluster",
  insider_cluster: "Insider cluster",
  filing: "Filing",
  watchlist: "Watchlist",
  insider_filing: "Insider filing",
  options: "Options",
};

/** What `politician_count` counts for each kind — mirrors the db.py docstring. */
export const COUNT_NOUN: Record<AlertKind, string> = {
  cluster: "members",
  insider_cluster: "insiders",
  filing: "member",
  watchlist: "member",
  insider_filing: "insider",
  options: "member",
};

/** Insider kinds carry exact values (shares × reported price) and link to the Insiders tab. */
export function isInsiderKind(kind: string): boolean {
  return kind === "insider_cluster" || kind === "insider_filing";
}

export type AlertRow = {
  id: number;
  kind: AlertKind | string;
  /** NULL when the alert is not about one ticker: a filing spanning several, or none. */
  ticker: string | null;
  /** 'buy' | 'sell'; NULL when the alert spans both sides. */
  direction: string | null;
  /** 0 for a per-filing alert. */
  window_days: number;
  /** Whatever the kind counts — see COUNT_NOUN. */
  politician_count: number;
  /** The disclosed range; NULL on rows from before schema 13. Insider values: min = max. */
  volume_min_cents: number | null;
  /** NULL when a row sits in the open-ended top bracket (or the range is unknown). */
  volume_max_cents: number | null;
  /** Bracket midpoints — an estimate; the figure the thresholds compared. */
  volume_mid_cents: number | null;
  fired_at: string;
  /** The names the message carried, comma-joined. */
  participants: string | null;
  /** The config.yaml rule that claimed an insider alert. */
  rule_name: string | null;
  filing_id: number | null;
  transaction_id: number | null;
  insider_filing_id: number | null;
  /** The Telegram HTML exactly as sent; NULL on rows from before schema 13. */
  message: string | null;
  // Joined from the filing the alert was about, when it was about one.
  member_name: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
  pdf_url: string | null;
  doc_id: string | null;
  filing_date: string | null;
  /** Distinct tickers on that filing — for a filing alert that has no single one. */
  filing_tickers: number | null;
  issuer_name: string | null;
  source_url: string | null;
  accession: string | null;
};

type Db = Awaited<ReturnType<typeof getDb>>;

function alertColumns(db: Db): Set<string> {
  const info = db.prepare("PRAGMA table_info(alerts)").all() as { name: string }[];
  return new Set(info.map((c) => c.name));
}

/** Columns schema 13 added, selected as NULL while the table predates it. */
const SINCE_13 = [
  "volume_min_cents",
  "volume_max_cents",
  "participants",
  "rule_name",
  "filing_id",
  "transaction_id",
  "insider_filing_id",
  "message",
] as const;

/** Every alert, newest first. `limit` defaults to 200; pass a large number for all. */
export async function getAlerts(opts: { kind?: string; limit?: number } = {}): Promise<AlertRow[]> {
  const db = await getDb();
  const cols = alertColumns(db);
  const optional = SINCE_13.map((c) => `${cols.has(c) ? `a.${c}` : "NULL"} AS ${c}`).join(",\n              ");
  const filing = cols.has("filing_id");
  const insider = cols.has("insider_filing_id");
  const f = (expr: string) => (filing ? expr : "NULL");
  const i = (expr: string) => (insider ? expr : "NULL");

  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) {
    where.push("a.kind = ?");
    params.push(opts.kind);
  }
  params.push(opts.limit ?? 200);

  return db
    .prepare(
      `SELECT a.id, a.kind, a.ticker, a.direction, a.window_days, a.politician_count,
              a.volume_mid_cents, a.fired_at,
              ${optional},
              ${f("COALESCE(p.full_name, f.filer_name)")} AS member_name,
              ${f("p.party")} AS party,
              ${f("p.state")} AS state,
              ${f("p.district")} AS district,
              ${f("COALESCE(p.chamber, f.chamber)")} AS chamber,
              ${f("f.pdf_url")} AS pdf_url,
              ${f("f.doc_id")} AS doc_id,
              ${f("f.filing_date")} AS filing_date,
              ${f(`(SELECT COUNT(DISTINCT t.ticker) FROM transactions t
                     WHERE t.filing_id = a.filing_id AND t.ticker IS NOT NULL AND t.ticker != '')`)} AS filing_tickers,
              ${i("i.issuer_name")} AS issuer_name,
              ${i("i.source_url")} AS source_url,
              ${i("i.accession")} AS accession
       FROM alerts a
       ${filing ? "LEFT JOIN filings f ON f.id = a.filing_id LEFT JOIN politicians p ON p.id = f.politician_id" : ""}
       ${insider ? "LEFT JOIN insider_filings i ON i.id = a.insider_filing_id" : ""}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY a.fired_at DESC, a.id DESC
       LIMIT ?`
    )
    .all(...params) as AlertRow[];
}

export type AlertKindTotal = {
  kind: string;
  total: number;
  last_7d: number;
  last_fired: string | null;
};

export type AlertTotals = {
  total: number;
  last_fired: string | null;
  /** When the database began logging every kind with its text; NULL before schema 13. */
  recorded_since: string | null;
  byKind: AlertKindTotal[];
};

/** Whole-log headline figures — never the slice a page renders. */
export async function getAlertTotals(): Promise<AlertTotals> {
  const db = await getDb();
  // julianday() on both sides: fired_at is ISO-8601 with a 'T', datetime()
  // renders a space, and comparing the two as strings misorders a boundary day.
  const byKind = db
    .prepare(
      `SELECT kind, COUNT(*) AS total,
              SUM(julianday(fired_at) >= julianday('now', '-7 days')) AS last_7d,
              MAX(fired_at) AS last_fired
       FROM alerts GROUP BY kind ORDER BY kind`
    )
    .all() as AlertKindTotal[];
  const since = db.prepare("SELECT value FROM sync_state WHERE key = 'alerts_recorded_since'").get() as
    | { value: string | null }
    | undefined;
  return {
    total: byKind.reduce((n, k) => n + k.total, 0),
    last_fired: byKind.reduce<string | null>(
      (latest, k) => (k.last_fired && (!latest || k.last_fired > latest) ? k.last_fired : latest),
      null
    ),
    recorded_since: since?.value ?? null,
    byKind,
  };
}

export type WeeklyAlertCount = { kind: string; weeks_ago: number; n: number };

/** Alerts per rolling 7-day bucket back from now, by kind. */
export async function getAlertsPerWeek(weeks = 8): Promise<WeeklyAlertCount[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT kind,
              CAST((julianday('now') - julianday(fired_at)) / 7 AS INTEGER) AS weeks_ago,
              COUNT(*) AS n
       FROM alerts
       WHERE julianday(fired_at) > julianday('now') - ?
       GROUP BY kind, weeks_ago`
    )
    .all(weeks * 7) as WeeklyAlertCount[];
}

/** One kind's buckets oldest → newest; the last entry is the most recent 7 days. */
export function weeklySeries(rows: WeeklyAlertCount[], kind: string, weeks: number): number[] {
  const series = new Array<number>(weeks).fill(0);
  for (const r of rows) {
    if (r.kind === kind && r.weeks_ago >= 0 && r.weeks_ago < weeks) {
      series[weeks - 1 - r.weeks_ago] = r.n;
    }
  }
  return series;
}
