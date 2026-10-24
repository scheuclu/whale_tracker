/**
 * `/api/v1` — the public, read-only JSON API. Each builder takes the
 * request's site origin and query string and returns `{ status, body }`;
 * the route handlers only wrap that in a Response. Every figure comes from
 * the dashboard's own query layer (`queries.ts`, `insider-queries.ts`), so
 * the API and the pages cannot disagree about a total — `api.test.ts`
 * checks that they don't.
 *
 * Congressional and insider data stay apart here as everywhere: no
 * endpoint returns both, and a ticker's congressional response only links
 * to its insider counterpart.
 */

import {
  apiError,
  amountJson,
  BIOGUIDE,
  dollars,
  meta,
  ownerJson,
  parseParams,
  SYMBOL,
  upper,
  volumeJson,
  type ApiResult,
  type ParamSpec,
} from "./api-format";
import { getCoverage, getDataAsOf, getMemberByBioguide } from "./api-queries";
import { parseTransactionFilters } from "./feed-filters";
import { insiderIssuerHref, memberHref, tickerHref } from "./format";
import {
  getInsiderIssuer,
  getInsiderTrades,
  getIssuerInsiders,
  type InsiderTradeRow,
  type IssuerRow,
} from "./insider-queries";
import { API_ENDPOINTS } from "./methodology";
import {
  STOCK_ACT_DEADLINE_DAYS,
  getPoliticianDetail,
  getPoliticianTickers,
  getPoliticians,
  getTickerDetail,
  getTickerMembers,
  getTickers,
  getTransactionTotals,
  getTransactions,
  type PoliticianDetail,
  type PoliticianRow,
  type TickerRow,
  type TransactionRow,
} from "./queries";
import { POLITICIAN_SORT, TICKER_SORT, type PoliticianSortKey, type TickerSortKey } from "./table-sort";
import { publicErrorMessage } from "./public-error";
import {
  ALL_TRACK_HORIZONS,
  DEFAULT_TRACK_HORIZON,
  OUTCOME_LABEL,
  TRACK_BENCHMARK,
  getMemberTrack,
  getTrackLeaderboard,
  type ClockScore,
  type MemberTrack,
  type TrackHorizon,
  type TrackScoreRow,
} from "./track-queries";

export const MAX_LIMIT = 500;
const MAX_OFFSET = 1_000_000;
const MAX_DAYS = 3650;

const LIMIT: ParamSpec = { kind: "int", min: 1, max: MAX_LIMIT, default: 50, clamp: true };
const DAYS: ParamSpec = { kind: "int", min: 1, max: MAX_DAYS };
const DIR: ParamSpec = { kind: "enum", values: ["asc", "desc"] };

/** API owner vocabulary → the House codes the feed filter takes. */
const OWNER_PARAM: Record<string, string> = { self: "self", spouse: "SP", joint: "JT", dependent_child: "DC" };

/** Query keys per endpoint — anything else is a 400. Exported for openapi.ts. */
export const PARAMS = {
  trades: {
    member_id: { kind: "pattern", re: BIOGUIDE, maxLength: 7, transform: upper },
    member: { kind: "text", maxLength: 120 },
    ticker: { kind: "pattern", re: SYMBOL, maxLength: 15, transform: upper },
    action: { kind: "enum", values: ["buy", "sell"] },
    chamber: { kind: "enum", values: ["house", "senate"] },
    party: { kind: "enum", values: ["D", "R", "I", "L"] },
    type: { kind: "pattern", re: /^[A-Z]{2}$/, maxLength: 2, transform: upper },
    owner: { kind: "enum", values: Object.keys(OWNER_PARAM) },
    from: { kind: "date" },
    to: { kind: "date" },
    scans: { kind: "enum", values: ["only", "exclude"] },
    limit: LIMIT,
    offset: { kind: "int", min: 0, max: MAX_OFFSET, default: 0 },
  },
  members: {
    sort: { kind: "enum", values: Object.keys(POLITICIAN_SORT.columns) },
    dir: DIR,
    days: DAYS,
    limit: LIMIT,
  },
  member: { limit: LIMIT },
  tickers: {
    sort: { kind: "enum", values: Object.keys(TICKER_SORT.columns) },
    dir: DIR,
    days: DAYS,
    limit: LIMIT,
  },
  ticker: { limit: LIMIT },
  insiders: { limit: LIMIT },
  track: { horizon: { kind: "enum", values: ALL_TRACK_HORIZONS.map(String), default: String(DEFAULT_TRACK_HORIZON) } },
  index: {},
} satisfies Record<string, Record<string, ParamSpec>>;

/* --------------------------------------------------------------- serialisers */

function absolute(origin: string, path: string): string {
  return `${origin}${path}`;
}

function memberApi(origin: string, bioguide: string | null | undefined): string | null {
  return bioguide ? absolute(origin, `/api/v1/members/${bioguide}`) : null;
}

function tickerApi(origin: string, symbol: string | null): string | null {
  return symbol ? absolute(origin, `/api/v1/tickers/${encodeURIComponent(symbol)}`) : null;
}

function bool(v: number | null | undefined): boolean {
  return v === 1;
}

function round1(v: number | null | undefined): number | null {
  return v == null ? null : Math.round(v * 10) / 10;
}

export type TradeJson = ReturnType<typeof tradeJson>;

export function tradeJson(r: TransactionRow, origin: string) {
  const transcribed = bool(r.transcribed);
  return {
    id: r.id,
    trade_date: r.tx_date,
    filing_date: r.filing_date,
    notification_date: r.notification_date,
    disclosure_delay_days: r.delay_days,
    late: r.delay_days == null ? null : r.delay_days > STOCK_ACT_DEADLINE_DAYS,
    dates_inconsistent: bool(r.dates_inconsistent),
    action: r.action,
    ticker: r.ticker || null,
    asset_name: r.asset_name,
    asset_type: r.asset_type,
    owner: ownerJson(r.owner),
    option: r.option_kind
      ? { kind: r.option_kind, strike_usd: dollars(r.strike_cents), expiry: r.expiry }
      : null,
    amount: amountJson(r.amount_min_cents, r.amount_max_cents, r.amount_exact_cents),
    transcribed,
    counted_in_totals: !transcribed,
    member: {
      name: r.member_name,
      bioguide_id: r.bioguide_id ?? null,
      party: r.party,
      state: r.state,
      district: r.district,
      chamber: r.chamber,
      url: absolute(origin, memberHref(r.member_name, r.bioguide_id)),
      api_url: memberApi(origin, r.bioguide_id),
    },
    industry_group: r.industry_group,
    source_url: r.pdf_url,
    url: absolute(origin, memberHref(r.member_name, r.bioguide_id)),
    ticker_url: r.ticker ? absolute(origin, tickerHref(r.ticker)) : null,
  };
}

function memberRowJson(r: PoliticianRow, origin: string) {
  return {
    name: r.member_name,
    bioguide_id: r.bioguide_id ?? null,
    party: r.party,
    state: r.state,
    district: r.district,
    chamber: r.chamber,
    trades: r.trades,
    tickers: r.tickers,
    buys: r.buys,
    sells: r.sells,
    volume: volumeJson(r),
    transcribed_trades: r.transcribed,
    avg_disclosure_delay_days: round1(r.avg_delay),
    late_trades: r.late_count,
    url: absolute(origin, memberHref(r.member_name, r.bioguide_id)),
    api_url: memberApi(origin, r.bioguide_id),
  };
}

function memberDetailJson(d: PoliticianDetail, origin: string) {
  return {
    ...memberRowJson(d, origin),
    filings: d.filings,
    avg_notification_lag_days: round1(d.avg_lag),
    first_trade_date: d.first_tx_date,
    last_trade_date: d.last_tx_date,
  };
}

function tickerRowJson(r: TickerRow, origin: string) {
  return {
    symbol: r.ticker,
    asset_name: r.asset_name,
    members: r.politicians,
    buy_members: r.buy_politicians,
    sell_members: r.sell_politicians,
    trades: r.trades,
    buys: r.buys,
    sells: r.sells,
    volume: volumeJson(r),
    transcribed_trades: r.transcribed,
    last_trade_date: r.last_tx_date,
    url: absolute(origin, tickerHref(r.ticker)),
    api_url: tickerApi(origin, r.ticker),
  };
}

/** A direction's insider value: unknown (null) when no row in it is priced. */
function insiderSide(count: number, valueCents: number, unpriced: number | undefined) {
  const missing = unpriced ?? 0;
  return {
    trades: count,
    value_usd: count > 0 && missing >= count ? null : dollars(valueCents),
    unpriced_trades: missing,
    value_is_partial: missing > 0 && missing < count,
  };
}

function issuerJson(r: IssuerRow, origin: string) {
  return {
    symbol: r.ticker,
    issuer_name: r.issuer_name,
    issuer_cik: r.issuer_cik,
    insiders: r.insiders,
    buy_insiders: r.buy_insiders,
    sell_insiders: r.sell_insiders,
    filings: r.filings,
    trades: r.trades,
    bought: insiderSide(r.buys, r.buy_value, r.unpriced_buys),
    sold: insiderSide(r.sells, r.sell_value, r.unpriced_sells),
    value_basis: "shares × reported price",
    last_trade_date: r.last_tx_date,
    url: r.ticker ? absolute(origin, insiderIssuerHref(r.ticker)) : null,
  };
}

export function insiderTradeJson(r: InsiderTradeRow) {
  const implausible = bool(r.implausible);
  return {
    id: r.id,
    trade_date: r.tx_date,
    trade_date_as_filed: r.tx_date_as_filed,
    filing_date: r.filing_date,
    disclosure_delay_days: r.delay_days,
    late: r.late == null ? null : r.late === 1,
    timeliness_box: r.timeliness,
    action: r.action,
    transaction_code: r.transaction_code,
    security_title: r.security_title,
    shares: r.shares,
    price_per_share_usd: r.price_per_share,
    value_usd: implausible ? null : dollars(r.amount_exact_cents),
    value_basis: "shares × reported price",
    implausible,
    counted_in_totals: !implausible && r.amount_exact_cents != null,
    ownership: r.direct_or_indirect === "D" ? "direct" : r.direct_or_indirect === "I" ? "indirect" : r.direct_or_indirect,
    nature_of_ownership: r.nature_of_ownership,
    rule_10b5_1: r.aff_10b5_one == null ? null : r.aff_10b5_one === 1,
    insider: {
      name: r.insider_name,
      cik: r.insider_cik,
      is_director: bool(r.is_director),
      is_officer: bool(r.is_officer),
      is_ten_percent_owner: bool(r.is_ten_percent_owner),
      officer_title: r.officer_title,
    },
    reporting_owners_on_filing: r.owner_count,
    footnotes: r.footnotes,
    accession: r.accession,
    source_url: r.source_url,
  };
}

/* ------------------------------------------------------------------ builders */

function badRequest(origin: string, errors: string[]): ApiResult {
  return apiError(origin, 400, "invalid query parameters", errors);
}

async function guard(origin: string, run: () => Promise<ApiResult>): Promise<ApiResult> {
  try {
    return await run();
  } catch (err) {
    return apiError(origin, 503, `data unavailable: ${publicErrorMessage(err)}`);
  }
}

export async function buildIndex(origin: string, search: URLSearchParams): Promise<ApiResult> {
  const p = parseParams(search, PARAMS.index);
  if (p.errors.length) return badRequest(origin, p.errors);
  return guard(origin, async () => {
    const coverage = await getCoverage();
    return {
      status: 200,
      body: {
        data: {
          name: "FatCat Watch API",
          version: "v1",
          endpoints: API_ENDPOINTS.map((e) => ({
            path: e.path,
            summary: e.summary,
            example: e.example ? absolute(origin, e.example) : null,
          })),
          coverage,
        },
        meta: meta(origin, coverage.data_as_of),
      },
    };
  });
}

export async function buildTrades(origin: string, search: URLSearchParams): Promise<ApiResult> {
  const p = parseParams(search, PARAMS.trades);
  if (p.values.member_id && p.values.member) p.errors.push("give member_id or member, not both");
  if (p.errors.length) return badRequest(origin, p.errors);
  return guard(origin, async () => {
    const v = p.values;
    let member = v.member as string | undefined;
    if (v.member_id) {
      const m = await getMemberByBioguide(v.member_id as string);
      if (!m) return apiError(origin, 404, `no member with bioguide_id ${v.member_id}`);
      member = m.member_name;
    }
    // The feed's own parser makes the filter, so an API query and the
    // equivalent feed URL name exactly the same rows.
    const raw: Record<string, string> = {};
    if (member) raw.member = member;
    for (const k of ["ticker", "action", "chamber", "party", "type", "from", "to", "scans"] as const) {
      if (v[k] !== undefined) raw[k] = String(v[k]);
    }
    if (v.owner !== undefined) raw.owner = OWNER_PARAM[v.owner as string];
    const { filters, ignored } = parseTransactionFilters(raw);
    if (ignored.length) return badRequest(origin, ignored.map((i) => `unrecognised value: ${i}`));

    const limit = v.limit as number;
    const offset = v.offset as number;
    const [rows, totals, asOf] = await Promise.all([
      getTransactions({ ...filters, limit, offset }),
      getTransactionTotals(filters),
      getDataAsOf(),
    ]);
    const next = offset + rows.length < totals.trades ? new URLSearchParams(search) : null;
    if (next) {
      next.set("offset", String(offset + rows.length));
      next.set("limit", String(limit));
    }
    return {
      status: 200,
      body: {
        data: rows.map((r) => tradeJson(r, origin)),
        meta: meta(origin, asOf, {
          ...(p.notices.length ? { notices: p.notices } : {}),
          filters: { ...v, limit: undefined, offset: undefined },
          total: { trades: totals.trades, volume: volumeJson(totals) },
          pagination: {
            limit,
            offset,
            returned: rows.length,
            next: next ? absolute(origin, `/api/v1/trades?${next.toString()}`) : null,
          },
        }),
      },
    };
  });
}

export async function buildMembers(origin: string, search: URLSearchParams): Promise<ApiResult> {
  const p = parseParams(search, PARAMS.members);
  if (p.errors.length) return badRequest(origin, p.errors);
  return guard(origin, async () => {
    const key = (p.values.sort as PoliticianSortKey | undefined) ?? POLITICIAN_SORT.default;
    const dir = (p.values.dir as "asc" | "desc" | undefined) ?? POLITICIAN_SORT.columns[key].first;
    const days = p.values.days as number | undefined;
    const [rows, asOf] = await Promise.all([
      getPoliticians(days, p.values.limit as number, { key, dir }),
      getDataAsOf(),
    ]);
    return {
      status: 200,
      body: {
        data: rows.map((r) => memberRowJson(r, origin)),
        meta: meta(origin, asOf, {
          ...(p.notices.length ? { notices: p.notices } : {}),
          sort: { key, dir },
          window_days: days ?? null,
          returned: rows.length,
        }),
      },
    };
  });
}

export type MemberResult = {
  member: ReturnType<typeof memberDetailJson>;
  top_tickers: ReturnType<typeof memberTickerJson>[];
  recent_trades: TradeJson[];
  track_record: ReturnType<typeof memberTrackJson>;
};

function memberTickerJson(
  r: Awaited<ReturnType<typeof getPoliticianTickers>>[number],
  origin: string
) {
  return {
    symbol: r.ticker,
    asset_name: r.asset_name,
    trades: r.trades,
    buys: r.buys,
    sells: r.sells,
    volume: volumeJson(r),
    last_trade_date: r.last_tx_date,
    url: absolute(origin, tickerHref(r.ticker)),
    api_url: tickerApi(origin, r.ticker),
  };
}

export async function buildMember(origin: string, id: string, search: URLSearchParams): Promise<ApiResult> {
  const p = parseParams(search, PARAMS.member);
  const bioguide = id.toUpperCase();
  if (!BIOGUIDE.test(bioguide)) p.errors.push("member id must be a Bioguide ID such as P000197");
  if (p.errors.length) return badRequest(origin, p.errors);
  return guard(origin, async () => {
    const who = await getMemberByBioguide(bioguide);
    const detail = who ? await getPoliticianDetail(who.member_name) : null;
    if (!who || !detail) return apiError(origin, 404, `no disclosed trades for bioguide_id ${bioguide}`);
    const limit = p.values.limit as number;
    const [tickers, trades, asOf, track] = await Promise.all([
      getPoliticianTickers(who.member_name, 20),
      getTransactions({ member: who.member_name, limit }),
      getDataAsOf(),
      getMemberTrack(who.member_name),
    ]);
    const data: MemberResult = {
      member: memberDetailJson(detail, origin),
      top_tickers: tickers.map((t) => memberTickerJson(t, origin)),
      recent_trades: trades.map((t) => tradeJson(t, origin)),
      track_record: memberTrackJson(track, origin),
    };
    return {
      status: 200,
      body: {
        data,
        meta: meta(origin, asOf, {
          ...(p.notices.length ? { notices: p.notices } : {}),
          recent_trades_returned: trades.length,
          all_trades: absolute(origin, `/api/v1/trades?member_id=${bioguide}`),
          markdown: absolute(origin, `/api/v1/members/${bioguide}.md`),
        }),
      },
    };
  });
}

export async function buildTickers(origin: string, search: URLSearchParams): Promise<ApiResult> {
  const p = parseParams(search, PARAMS.tickers);
  if (p.errors.length) return badRequest(origin, p.errors);
  return guard(origin, async () => {
    const key = (p.values.sort as TickerSortKey | undefined) ?? TICKER_SORT.default;
    const dir = (p.values.dir as "asc" | "desc" | undefined) ?? TICKER_SORT.columns[key].first;
    const days = p.values.days as number | undefined;
    const [rows, asOf] = await Promise.all([getTickers(days, p.values.limit as number, { key, dir }), getDataAsOf()]);
    return {
      status: 200,
      body: {
        data: rows.map((r) => tickerRowJson(r, origin)),
        meta: meta(origin, asOf, {
          ...(p.notices.length ? { notices: p.notices } : {}),
          sort: { key, dir },
          window_days: days ?? null,
          returned: rows.length,
          total: rows[0]?.total_rows ?? 0,
        }),
      },
    };
  });
}

export type TickerResult = {
  ticker: ReturnType<typeof tickerRowJson>;
  members: ReturnType<typeof tickerMemberJson>[];
  recent_trades: TradeJson[];
};

function tickerMemberJson(r: Awaited<ReturnType<typeof getTickerMembers>>[number], origin: string) {
  return {
    name: r.member_name,
    bioguide_id: r.bioguide_id ?? null,
    party: r.party,
    state: r.state,
    district: r.district,
    chamber: r.chamber,
    trades: r.trades,
    buys: r.buys,
    sells: r.sells,
    volume: volumeJson(r),
    last_trade_date: r.last_tx_date,
    url: absolute(origin, memberHref(r.member_name, r.bioguide_id)),
    api_url: memberApi(origin, r.bioguide_id),
  };
}

export async function buildTicker(origin: string, symbol: string, search: URLSearchParams): Promise<ApiResult> {
  const p = parseParams(search, PARAMS.ticker);
  const sym = symbol.toUpperCase();
  if (!SYMBOL.test(sym)) p.errors.push("symbol is malformed");
  if (p.errors.length) return badRequest(origin, p.errors);
  return guard(origin, async () => {
    const detail = await getTickerDetail(sym);
    if (!detail) {
      return apiError(origin, 404, `no congressional trades for ${sym}; Form 4 insider data, if any, is at /api/v1/insiders/${sym}`);
    }
    const limit = p.values.limit as number;
    const [members, trades, asOf] = await Promise.all([
      getTickerMembers(sym, undefined, 200),
      getTransactions({ ticker: sym, limit }),
      getDataAsOf(),
    ]);
    const data: TickerResult = {
      ticker: tickerRowJson(detail, origin),
      members: members.map((m) => tickerMemberJson(m, origin)),
      recent_trades: trades.map((t) => tradeJson(t, origin)),
    };
    return {
      status: 200,
      body: {
        data,
        meta: meta(origin, asOf, {
          ...(p.notices.length ? { notices: p.notices } : {}),
          recent_trades_returned: trades.length,
          all_trades: absolute(origin, `/api/v1/trades?ticker=${encodeURIComponent(sym)}`),
          insiders: absolute(origin, `/api/v1/insiders/${encodeURIComponent(sym)}`),
          markdown: absolute(origin, `/api/v1/tickers/${encodeURIComponent(sym)}.md`),
        }),
      },
    };
  });
}

export async function buildInsiders(origin: string, symbol: string, search: URLSearchParams): Promise<ApiResult> {
  const p = parseParams(search, PARAMS.insiders);
  const sym = symbol.toUpperCase();
  if (!SYMBOL.test(sym)) p.errors.push("symbol is malformed");
  if (p.errors.length) return badRequest(origin, p.errors);
  return guard(origin, async () => {
    const issuer = await getInsiderIssuer(sym);
    if (!issuer) return apiError(origin, 404, `no stored Form 4 insider trades for ${sym}`);
    const limit = p.values.limit as number;
    const [insiders, trades, asOf] = await Promise.all([
      getIssuerInsiders(sym),
      getInsiderTrades({ ticker: sym, limit }),
      getDataAsOf(),
    ]);
    return {
      status: 200,
      body: {
        data: {
          dataset: "sec_form4",
          issuer: issuerJson(issuer, origin),
          insiders: insiders.map((i) => ({
            name: i.name,
            cik: i.cik,
            is_director: bool(i.is_director),
            is_officer: bool(i.is_officer),
            is_ten_percent_owner: bool(i.is_ten_percent_owner),
            officer_title: i.officer_title,
            filings: i.filings,
            buys: i.buys,
            sells: i.sells,
            bought_priced_usd: dollars(i.bought),
            sold_priced_usd: dollars(i.sold),
          })),
          recent_trades: trades.map(insiderTradeJson),
        },
        meta: meta(origin, asOf, {
          ...(p.notices.length ? { notices: p.notices } : {}),
          dataset_note:
            "SEC Form 4 corporate-insider data. Never combine with congressional figures. Values are shares × reported price; " +
            "bought_priced_usd / sold_priced_usd sum only rows with a usable price (see issuer.bought.unpriced_trades).",
          recent_trades_returned: trades.length,
        }),
      },
    };
  });
}

/* -------------------------------------------------------------- track record */

/**
 * The track record's JSON: every figure as stored by the pipeline
 * (`stats.track_scores`), in percentage points, with field names that say
 * what they are — a stock's move against SPY after a disclosed trade, never
 * a profit or a return. Nothing is re-derived here.
 */
export const TRACK_MEASURE =
  "Stock's close-to-close move minus SPY's over the same trading days, signed by the trade's direction " +
  "(a sale followed by a fall is positive), in percentage points. The stock's move, not the member's profit: " +
  "exit, position size and dividends are unknown, and no dollar amount enters it. Not investment advice; " +
  "a disclosed trade is not evidence of wrongdoing.";

function pts(v: number | null): number | null {
  return v == null ? null : Math.round(v * 1000) / 10;
}

function clockJson(c: ClockScore) {
  return {
    shrunk_excess_move_pts: pts(c.score),
    unshrunk_mean_excess_move_pts: pts(c.mean),
    interval_90_pts: c.lo == null || c.hi == null ? null : [pts(c.lo), pts(c.hi)],
    hit_rate: c.hit_rate == null ? null : Math.round(c.hit_rate * 1000) / 1000,
    share_of_same_date_random_portfolios_beaten: c.luck == null ? null : Math.round(c.luck * 1000) / 1000,
  };
}

function trackEntryJson(r: TrackScoreRow, origin: string) {
  return {
    rank: r.rank,
    member: {
      name: r.member_name,
      bioguide_id: r.bioguide_id,
      party: r.party,
      state: r.state,
      chamber: r.chamber,
      url: absolute(origin, memberHref(r.member_name, r.bioguide_id)),
      api_url: memberApi(origin, r.bioguide_id),
    },
    horizon_trading_days: r.horizon,
    decisions_measured: r.n,
    filings: r.filings,
    ranked: r.qualifies,
    after_trade: clockJson(r.trade),
    after_disclosure: clockJson(r.disclosure),
    timing_lost_to_disclosure_delay_pts: pts(r.trade.score - r.disclosure.score),
  };
}

function memberTrackJson(t: MemberTrack, origin: string) {
  if (!t.available) return { available: false, note: "The track record is being computed by the pipeline." };
  return {
    available: true,
    measure: TRACK_MEASURE,
    minimum_decisions_to_rank: t.min_decisions,
    by_horizon: t.scores.map((s) => ({ ...trackEntryJson(s, origin), ranked_members: t.ranked_count[s.horizon] ?? null })),
    decisions_waiting_for_horizon: t.pending,
    excluded_decisions: t.excluded,
    url: absolute(origin, "/politicians?view=track"),
  };
}

export async function buildTrackRecord(origin: string, search: URLSearchParams): Promise<ApiResult> {
  const p = parseParams(search, PARAMS.track);
  if (p.errors.length) return badRequest(origin, p.errors);
  return guard(origin, async () => {
    const horizon = Number(p.values.horizon ?? DEFAULT_TRACK_HORIZON) as TrackHorizon;
    const [board, asOf] = await Promise.all([getTrackLeaderboard(horizon), getDataAsOf()]);
    const model = (clock: "trade" | "disclosure") => {
      const m = board.model[clock];
      return m
        ? {
            shrinkage_k: m.k == null ? null : Math.round(m.k * 10) / 10,
            all_decisions_mean_excess_move_pts: pts(m.mean),
            decisions_measured: m.decisions,
            members_measured: m.members,
            members_ranked: m.ranked,
          }
        : null;
    };
    return {
      status: 200,
      body: {
        data: {
          dataset: "congress",
          available: board.available,
          horizon_trading_days: horizon,
          benchmark: TRACK_BENCHMARK,
          measure: TRACK_MEASURE,
          ranking:
            "Ranked by the shrunk after-trade score: a member's mean multiplied by n / (n + k), k estimated from " +
            "how much members differ beyond chance. Only members with the minimum number of measured decisions " +
            "over the minimum number of filings are ranked; the interval is a 90% bootstrap over their filings.",
          minimum_decisions_to_rank: board.min_decisions,
          model: { after_trade: model("trade"), after_disclosure: model("disclosure") },
          ranked: board.ranked.map((r) => trackEntryJson(r, origin)),
          not_enough_matured_decisions: board.unranked.map((r) => ({
            member: trackEntryJson(r, origin).member,
            decisions_measured: r.n,
            filings: r.filings,
          })),
          coverage: board.coverage.map((c) => ({
            outcome: c.outcome,
            description: OUTCOME_LABEL[c.outcome] ?? c.outcome,
            rows: c.rows,
            decisions: c.decisions,
          })),
          computed_at: board.computed_at,
          status: board.status,
        },
        meta: meta(origin, asOf, {
          ...(p.notices.length ? { notices: p.notices } : {}),
          ...(board.available ? {} : { notices: ["The track record is being computed by the pipeline; no scores yet."] }),
          page: absolute(origin, horizon === 90 ? "/politicians?view=track" : `/politicians?view=track&h=${horizon}`),
        }),
      },
    };
  });
}
