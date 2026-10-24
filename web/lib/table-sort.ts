/**
 * Sortable leaderboard tables (/politicians, /tickers, /insiders).
 *
 * The sort travels in the URL (`?sort=trades&dir=asc`) so it works without
 * JavaScript, survives a reload and can be shared. It is applied in SQL,
 * before the LIMIT: re-sorting the rendered slice would rank the top 40 by
 * volume and call the result "fewest trades".
 *
 * A URL parameter never reaches SQL. `parseSort` maps it onto a key of a
 * fixed spec (anything else is the default), and `orderBy` emits only the
 * expressions written in that spec.
 *
 * NULL means unknown — a mean delay over contradictory dates, an unpriced
 * insider value — and an unknown is neither the largest nor the smallest, so
 * it sorts last in both directions.
 */

export type SortDir = "asc" | "desc";

export type SortColumn = {
  /** SQL over the query's own result aliases. Written here, never taken from input. */
  expr: string;
  /** The direction a first click sorts in: largest first for a measure, A→Z for a name. */
  first: SortDir;
  /** The expression can be NULL; those rows go last whichever way it sorts. */
  nullable?: boolean;
};

export type SortSpec<K extends string = string> = {
  columns: Record<K, SortColumn>;
  /** The order the page has when no sort is asked for. */
  default: NoInfer<K>;
  /** Appended after the chosen column so equal rows keep a stable order. */
  tiebreak: string;
};

export type Sort<K extends string = string> = { key: K; dir: SortDir };

/** What `searchParams` can hold for one key. */
type Param = string | string[] | undefined;

function one(p: Param): string | undefined {
  return Array.isArray(p) ? p[0] : p;
}

export function isSortKey<K extends string>(spec: SortSpec<K>, key: string | undefined): key is K {
  return key != null && Object.prototype.hasOwnProperty.call(spec.columns, key);
}

/** The requested sort, or the spec's default for anything not on its list. */
export function parseSort<K extends string>(
  spec: SortSpec<K>,
  params: { sort?: Param; dir?: Param }
): Sort<K> {
  const raw = one(params.sort);
  const key = isSortKey(spec, raw) ? raw : spec.default;
  const d = one(params.dir);
  const dir: SortDir = d === "asc" || d === "desc" ? d : spec.columns[key].first;
  return { key, dir };
}

/** `ORDER BY …` for a parsed sort. Only spec text is interpolated. */
export function orderBy<K extends string>(spec: SortSpec<K>, sort: Sort<K>): string {
  // Re-validated here as well: a caller may build a Sort by hand.
  const key = isSortKey(spec, sort.key) ? sort.key : spec.default;
  const col = spec.columns[key];
  const dir = sort.dir === "asc" ? "ASC" : "DESC";
  const terms = [];
  if (col.nullable) terms.push(`(${col.expr}) IS NULL`);
  terms.push(`${col.expr} ${dir}`);
  if (spec.tiebreak) terms.push(spec.tiebreak);
  return `ORDER BY ${terms.join(", ")}`;
}

/**
 * The `sort`/`dir` a header link should carry: the active column flips,
 * another column starts at its own first direction, and the page's default
 * order is spelled as no parameters at all so `/tickers` stays `/tickers`.
 */
export function nextSort<K extends string>(
  spec: SortSpec<K>,
  current: Sort<K>,
  key: K
): { sort?: K; dir?: SortDir } {
  const dir: SortDir = current.key === key ? (current.dir === "asc" ? "desc" : "asc") : spec.columns[key].first;
  return sortParams(spec, { key, dir });
}

/**
 * The canonical URL parameters for a sort — what other links on the page
 * (window pills, "show all") carry so they keep it. Validated values only:
 * a junk `?sort=` in the address bar is not copied into new links.
 */
export function sortParams<K extends string>(spec: SortSpec<K>, sort: Sort<K>): { sort?: K; dir?: SortDir } {
  const first = spec.columns[sort.key].first;
  if (sort.key === spec.default && sort.dir === first) return {};
  return sort.dir === first ? { sort: sort.key } : { sort: sort.key, dir: sort.dir };
}

/** True when the sort is the page's standing order. */
export function isDefaultSort<K extends string>(spec: SortSpec<K>, sort: Sort<K>): boolean {
  return sort.key === spec.default && sort.dir === spec.columns[sort.key].first;
}

/** A query string from the set values of `params`, with a leading "?" when non-empty. */
export function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Rows a leaderboard shows: 40 by default, more on request, never unbounded. */
export const ROW_LIMITS = { default: 40, more: 200, all: 5000 } as const;

export function parseLimit(p: Param): { n: "more" | "all" | undefined; limit: number } {
  const v = one(p);
  if (v === "200") return { n: "more", limit: ROW_LIMITS.more };
  if (v === "all") return { n: "all", limit: ROW_LIMITS.all };
  return { n: undefined, limit: ROW_LIMITS.default };
}

/** Keeps a spec's keys literal, and its default one of them. */
function defineSort<K extends string>(spec: SortSpec<K>): SortSpec<K> {
  return spec;
}

/** A buy share for the Buy / Sell column: NULL when nothing was bought or sold. */
const BUY_SHARE = `CAST(buys AS REAL) / NULLIF(buys + sells, 0)`;

/**
 * All members. `volume` is the bracket-midpoint estimate the column shows —
 * `SUM(MID)` in `getPoliticians`, which already counts an open-ended top
 * bracket at its floor and a transcribed row at nothing — so the order is
 * the order of the printed figures, under the same definition.
 */
export const POLITICIAN_SORT = defineSort({
  columns: {
    member: { expr: "member_name COLLATE NOCASE", first: "asc" },
    trades: { expr: "trades", first: "desc" },
    tickers: { expr: "tickers", first: "desc" },
    buysell: { expr: BUY_SHARE, first: "desc", nullable: true },
    volume: { expr: "volume_mid", first: "desc" },
    delay: { expr: "avg_delay", first: "desc", nullable: true },
    late: { expr: "late_count", first: "desc" },
    lag: { expr: "avg_lag", first: "desc", nullable: true },
  },
  default: "volume",
  tiebreak: "volume_mid DESC, member_name COLLATE NOCASE ASC",
});

/**
 * All tickers. `range` sorts on the disclosed floor — the one end every
 * range has; an open-ended top bracket has no ceiling to sort by.
 */
export const TICKER_SORT = defineSort({
  columns: {
    ticker: { expr: "ticker COLLATE NOCASE", first: "asc" },
    asset: { expr: "asset_name COLLATE NOCASE", first: "asc", nullable: true },
    members: { expr: "politicians", first: "desc" },
    trades: { expr: "trades", first: "desc" },
    buysell: { expr: BUY_SHARE, first: "desc", nullable: true },
    volume: { expr: "volume_mid", first: "desc" },
    range: { expr: "volume_min", first: "desc" },
  },
  default: "volume",
  tiebreak: "volume_mid DESC, ticker ASC",
});

/**
 * All insider issuers. Values are shares × reported price and the query
 * sums an unpriced direction to 0, which the table prints as "—"; sorting
 * on `NULLIF(…, 0)` sends those to the end instead of ranking an unknown as
 * the smallest purchase. `value` (bought + sold) is the page's standing
 * order and has no column of its own.
 */
export const ISSUER_SORT = defineSort({
  columns: {
    value: { expr: "buy_value + sell_value", first: "desc" },
    ticker: { expr: "ticker COLLATE NOCASE", first: "asc", nullable: true },
    issuer: { expr: "issuer_name COLLATE NOCASE", first: "asc", nullable: true },
    insiders: { expr: "insiders", first: "desc" },
    filings: { expr: "filings", first: "desc" },
    buysell: { expr: BUY_SHARE, first: "desc", nullable: true },
    bought: { expr: "NULLIF(buy_value, 0)", first: "desc", nullable: true },
    sold: { expr: "NULLIF(sell_value, 0)", first: "desc", nullable: true },
    last: { expr: "last_tx_date", first: "desc", nullable: true },
  },
  default: "value",
  tiebreak: "buy_value + sell_value DESC, issuer_cik ASC",
});

export type PoliticianSortKey = typeof POLITICIAN_SORT extends SortSpec<infer K> ? K : never;
export type TickerSortKey = typeof TICKER_SORT extends SortSpec<infer K> ? K : never;
export type IssuerSortKey = typeof ISSUER_SORT extends SortSpec<infer K> ? K : never;
