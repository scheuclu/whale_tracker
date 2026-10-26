import { getDb } from "./db";
import { getInsiderIssuer, getInsiderTrades, type InsiderTradeRow, type IssuerRow } from "./insider-queries";
import { getAlerts, type AlertRow } from "./alert-queries";
import {
  getPoliticianDetail,
  getTickers,
  getTransactions,
  type PoliticianDetail,
  type TickerRow,
  type TransactionRow,
} from "./queries";

/**
 * The signed-in dashboard (`/account`): what a reader follows, each with its
 * own record, and the recent filings behind it. Every figure comes from the
 * same query the member, ticker and insider pages use, filtered to the
 * follows, so a number here always matches the page it links to. Congress and
 * Form 4 stay in separate fields and are never summed.
 */

export type FollowedMember = {
  bioguide_id: string;
  /** From the roster; null when the id is not in it (a retired member's id still parses). */
  name: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: string | null;
  /** The member's whole record, as on their page; null when they have filed no trades. */
  record: PoliticianDetail | null;
};

export type FollowedTicker = {
  ticker: string;
  /** Congressional aggregate, as on the ticker page; null when no member traded it. */
  congress: TickerRow | null;
  /** Form 4 aggregate for the issuer, as on the insider page; null when none was ingested. */
  insiders: IssuerRow | null;
};

export async function getFollowedMembers(ids: string[]): Promise<FollowedMember[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const roster = db
    .prepare(
      `SELECT bioguide_id, full_name, party, state, district, chamber
       FROM politicians WHERE bioguide_id IN (${ids.map(() => "?").join(",")})`
    )
    .all(...ids) as {
    bioguide_id: string;
    full_name: string;
    party: string | null;
    state: string | null;
    district: string | null;
    chamber: string | null;
  }[];
  const byId = new Map(roster.map((r) => [r.bioguide_id, r]));
  return Promise.all(
    ids.map(async (id) => {
      const r = byId.get(id);
      return {
        bioguide_id: id,
        name: r?.full_name ?? null,
        party: r?.party ?? null,
        state: r?.state ?? null,
        district: r?.district ?? null,
        chamber: r?.chamber ?? null,
        record: r ? await getPoliticianDetail(r.full_name) : null,
      };
    })
  );
}

export async function getFollowedTickers(tickers: string[]): Promise<FollowedTicker[]> {
  if (tickers.length === 0) return [];
  const all = await getTickers(undefined, 100_000);
  const congress = new Map(all.filter((t) => tickers.includes(t.ticker)).map((t) => [t.ticker, t]));
  return Promise.all(
    tickers.map(async (ticker) => ({
      ticker,
      congress: congress.get(ticker) ?? null,
      insiders: await getInsiderIssuer(ticker).catch(() => null),
    }))
  );
}

/** Congressional trades by a followed member or in a followed ticker, newest trade first. */
export async function getFollowedTrades(
  follows: { members: string[]; tickers: string[] },
  limit = 30
): Promise<TransactionRow[]> {
  if (follows.members.length === 0 && follows.tickers.length === 0) return [];
  return getTransactions({ watch: follows, limit });
}

/** Form 4 trades in a followed ticker, newest first. */
export async function getFollowedInsiderTrades(tickers: string[], limit = 20): Promise<InsiderTradeRow[]> {
  if (tickers.length === 0) return [];
  const per = await Promise.all(tickers.map((t) => getInsiderTrades({ ticker: t, limit })));
  return per
    .flat()
    .sort((a, b) => (b.tx_date ?? "").localeCompare(a.tx_date ?? "") || b.id - a.id)
    .slice(0, limit);
}

/** Cluster alerts (both kinds) sent about a followed ticker. */
export async function getFollowedClusterAlerts(tickers: string[], limit = 10): Promise<AlertRow[]> {
  if (tickers.length === 0) return [];
  const set = new Set(tickers);
  const alerts = await getAlerts({ limit: 1000 });
  return alerts
    .filter((a) => (a.kind === "cluster" || a.kind === "insider_cluster") && a.ticker != null && set.has(a.ticker))
    .slice(0, limit);
}
