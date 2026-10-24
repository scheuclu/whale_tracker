/**
 * What the data is and how it may be quoted — the single source for
 * `/methodology` (people), `/llms.txt` and `/llms-full.txt` (language
 * models), the `meta.caveats` of every `/api/v1` response and the
 * descriptions in `/openapi.json`. Each of those renders this module; none
 * of them carries its own copy of a rule.
 *
 * The rules restate CLAUDE.md's data rules ("amounts are ranges",
 * transcription quarantine, delay definition, Form 4 values, insider data
 * never joined into congressional aggregates). When one of those changes,
 * change it here and every surface follows. Pure: no database access, so
 * the test suite can import it directly.
 */

import { SITE_NAME } from "./site";

// One name for every surface: re-exported rather than restated.
export { SITE_NAME };

export const SITE_SUMMARY =
  "US congressional (STOCK Act) and corporate-insider (SEC Form 4) stock trades, reproduced as filed. " +
  "Congressional amounts are disclosed brackets, never exact figures; insider values are shares × the reported price.";

export type Source = {
  id: "house" | "senate" | "sec";
  name: string;
  href: string;
  what: string;
  how: string;
};

export const SOURCES: Source[] = [
  {
    id: "house",
    name: "US House Clerk",
    href: "https://disclosures-clerk.house.gov/FinancialDisclosure",
    what: "Periodic Transaction Reports (PTRs) filed under the STOCK Act by members of the House.",
    how:
      "Electronic PDFs are parsed from their text layer by word position. Scanned paper PDFs are " +
      "transcribed (see the transcription rule) and their rows never enter a dollar total.",
  },
  {
    id: "senate",
    name: "US Senate eFD",
    href: "https://efdsearch.senate.gov/",
    what: "Periodic Transaction Reports filed under the STOCK Act by senators.",
    how:
      "Electronic reports are read from the transactions table of each eFD page and mapped onto the " +
      "House vocabulary. Paper Senate filings are scanned images: they are listed as unread and never transcribed.",
  },
  {
    id: "sec",
    name: "SEC EDGAR",
    href: "https://www.sec.gov/edgar/search/",
    what: "Form 4 filings by corporate insiders (officers, directors, 10% owners).",
    how:
      "Only open-market purchases (code P) and sales (code S) are kept, and only from filings whose " +
      "P or S rows reach $50,000 in one direction. Amendments (4/A), Forms 3 and 5 and the derivative table are not ingested.",
  },
];

export type QuotingRule = {
  /** Stable id, used as an anchor on /methodology and in API caveats. */
  id: string;
  title: string;
  /** One sentence: what an API response's `meta.caveats` carries. */
  short: string;
  /** The rule in full, plain language. */
  body: string;
};

/**
 * The rules for quoting. Order matters: the first three are the ones a
 * misquotation most often breaks, so every surface leads with them.
 */
export const QUOTING_RULES: QuotingRule[] = [
  {
    id: "amounts-are-ranges",
    title: "Congressional amounts are ranges",
    short:
      "Congressional amounts are STOCK Act brackets (e.g. $1,001–$15,000), not figures: quote the range, never a single number.",
    body:
      "The STOCK Act requires members to disclose only an amount bracket such as \"$1,001 – $15,000\". " +
      "Every congressional trade and every congressional total on this site is therefore a range. Quote the " +
      "range (`amount.disclosed`, or `min_usd` to `max_usd`). Never state that a member traded a single dollar " +
      "amount unless `amount.exact_usd` is set.",
  },
  {
    id: "midpoints-are-estimates",
    title: "Midpoints are estimates",
    short:
      "Any single dollar figure for congressional trades (midpoint_estimate_usd, \"est.\") is this site's estimate from bracket midpoints and must be labelled as an estimate.",
    body:
      "Where the site shows one number for congressional volume (the API's `midpoint_estimate_usd`, the " +
      "dashboard's \"est.\" figures, rankings by volume) it is the sum of bracket midpoints: an estimate this " +
      "site computes, not a disclosed amount. If you use it, call it an estimate based on bracket midpoints " +
      "and give the disclosed range next to it.",
  },
  {
    id: "open-ended-top-bracket",
    title: "The top bracket has no ceiling",
    short:
      "Open-ended top brackets (\"Over $50,000,000\", spouse \"Over $1,000,000\") have max_usd = null; a total containing one is \"≥ its floor\" with no upper bound.",
    body:
      "The highest brackets (\"Over $50,000,000\", and \"Over $1,000,000\" for a spouse or dependent) have no " +
      "upper bound, so `max_usd` is null and the range is written \"≥ $X\". A total that includes such a row is " +
      "reported as at least its floor, never with an invented upper bound. In a midpoint estimate an " +
      "open-ended row contributes its floor; on a single trade it has no midpoint at all.",
  },
  {
    id: "exact-only-when-filed",
    title: "Exact figures only when filed",
    short: "amount.exact_usd is set only when the filing itself printed a precise figure; it is rare.",
    body:
      "A handful of filers write a precise amount (\"$2,722.50\") instead of ticking a bracket. Only then is " +
      "`exact_usd` set, and only then may the trade be quoted as one figure.",
  },
  {
    id: "transcribed-excluded",
    title: "Scanned paper filings stay out of totals",
    short:
      "Rows transcribed from scanned paper filings (transcribed: true) are listed and counted as trades but never enter a dollar total (counted_in_totals: false).",
    body:
      "Some House members file on paper; the Clerk publishes a scan. Those scans are transcribed: a model reads " +
      "the handwriting (names, dates, assets) and a separate grid reader decides which amount and type box is " +
      "ticked. Transcribed rows are shown and labelled, and they count toward trade counts and member/ticker " +
      "lists, but they are excluded from every dollar total, ranking by volume and alert. In the API they carry " +
      "`transcribed: true` and `counted_in_totals: false`; do not add their amounts into any total. Senate paper " +
      "filings are not read at all.",
  },
  {
    id: "disclosure-delay",
    title: "Disclosure delay is trade date to filing date",
    short:
      "disclosure_delay_days = trade date → date the report was filed (not the form's Notification Date); the STOCK Act deadline is 45 days; null when the filed dates contradict.",
    body:
      "Delay is measured from the trade date to the date the report reached the House Clerk or Senate eFD. It " +
      "is not the form's \"Notification Date\": someone trading their own account is notified the same day, so " +
      "that column reads 0 however long the filing took. The STOCK Act allows 45 days; a trade disclosed later " +
      "is late. Late filing is a reporting fact, not an allegation of wrongdoing. Where the filing's own dates " +
      "contradict each other the delay is null rather than negative.",
  },
  {
    id: "dates-as-filed",
    title: "Dates are reproduced as filed",
    short: "Dates are as filed; a few are mistyped (e.g. future trade dates) and are flagged, never corrected.",
    body:
      "A few filings carry mistyped dates, such as a trade date in the future or after the filing date. The " +
      "data stays faithful to the filing; such rows are flagged (`dates_inconsistent`) rather than corrected.",
  },
  {
    id: "insider-values",
    title: "Insider values are shares × reported price",
    short:
      "Form 4 values are shares × the price as filed (possibly a weighted average); an unpriced row has value null, never 0.",
    body:
      "Form 4 filers report shares and a price, so an insider value is exact arithmetic but computed: shares × " +
      "the reported price. Filers may report a weighted-average price over several executions; the real price " +
      "range is then only in the footnotes. A row with no price has a value of null (unknown, not zero), and a " +
      "row whose as-filed value is implausible is shown but excluded from totals. Say \"shares × reported " +
      "price\", never \"disclosed range\".",
  },
  {
    id: "never-combine",
    title: "Congressional and insider data are never combined",
    short:
      "Congressional and corporate-insider data are separate datasets: never add, rank or average them together.",
    body:
      "The two datasets measure different things (brackets versus computed values, a 45-day versus a " +
      "two-business-day deadline). They are shown side by side but never summed, ranked or averaged together. " +
      "\"Distinct insiders\" counts primary reporting owners: a joint filing is one decision.",
  },
  {
    id: "recent-incomplete",
    title: "Recent weeks are incomplete",
    short:
      "Members have 45 days to disclose (and some file later), so recent periods are always under-reported.",
    body:
      "Because members have up to 45 days to disclose, and some file later still, the most recent six weeks " +
      "of trade dates are always incomplete. Compare periods by filing date, or leave a margin.",
  },
  {
    id: "track-record",
    title: "The track record is a stock's move, not a profit",
    short:
      "Track-record figures are how a stock moved after a member's trade minus SPY over the same trading days, signed by direction, in points: never the member's profit, return or skill, and shrunk toward zero for small samples.",
    body:
      "The track record (`/politicians?view=track`, `/api/v1/track-record`) measures, for each decision (one member, " +
      "ticker, direction and filing), the stock's close-to-close move over 30, 90 or 180 trading days minus SPY's over " +
      "the same days, read the way the trade pointed (a sale followed by a fall is positive). It starts from the first " +
      "close on or after the trade date (`after_trade`) and from the first close after the filing date " +
      "(`after_disclosure`, what a member of the public could have copied). It is not what the member earned: the exit, " +
      "the position size and dividends are unknown, and no dollar amount enters it (brackets are not amounts, so every " +
      "decision counts once). Member scores are shrunk toward zero by n / (n + k) and come with a 90% bootstrap interval; " +
      "an interval that crosses zero cannot tell the record from no edge. Options, non-equity assets, exchanges, " +
      "transcribed rows, rows with contradictory dates and tickers without a price series are excluded and counted. " +
      "Say \"the stocks X traded beat the S&P 500 by N points on average over 90 trading days after the trade\", never " +
      "\"X earned\", \"X's returns\", \"alpha\" or \"the best trader\". It is not evidence of wrongdoing.",
  },
  {
    id: "not-advice",
    title: "Not investment advice",
    short: "Public disclosures shown for information; not investment advice and not evidence of wrongdoing.",
    body:
      "This site reproduces public disclosures for information. It is not investment advice, and a disclosed " +
      "trade is not evidence of wrongdoing. Cite the filing (`source_url`) and the date of the data " +
      "(`meta.data_as_of`) when you quote it.",
  },
];

/** The rule texts as `meta.caveats` carries them. */
export const CAVEATS: string[] = QUOTING_RULES.map((r) => r.short);

/** How the data is kept current. */
export const UPDATE_CADENCE = [
  "A scheduled GitHub Actions job polls the House Clerk, Senate eFD and SEC EDGAR, asking for a run every 90 minutes; GitHub delivers scheduled runs late and unevenly, typically every few hours.",
  "Each run commits the updated SQLite database; the dashboard and API re-read it within about two minutes.",
  "`meta.data_as_of` in every API response is the time of the last pipeline write.",
];

export const KNOWN_GAPS = [
  "Congressional coverage is filings filed in 2026. Trade dates can be older, because some members file late catch-up reports.",
  "Filings the pipeline could not read are not in the data; they are listed on the Pipeline page.",
  "Senate paper filings are not transcribed. House scans are transcribed but kept out of every total.",
  "Only open-market Form 4 purchases and sales from filings reaching $50,000 in one direction are kept; amendments (4/A), Forms 3 and 5 and derivative transactions are not ingested yet.",
  "Option contracts (call/put, strike, expiry) are read only where the filing's text names them; a strike is never guessed.",
  "Industry groups come from the issuer's SEC SIC code; ETFs, funds and unlisted assets have none and stay unclassified.",
  "Members are grouped by their name on the official roster; a filing the roster could not match keeps the name printed on it.",
  "The track record covers stocks and ETFs with a ticker and a price series from an unofficial source (Yahoo Finance's chart endpoint); delisted, renamed or acquired tickers drop out, and a decision counts only once its horizon has passed on both clocks, so recent months are missing. Corporate insiders have no track record yet.",
];

/* ------------------------------------------------------------- data dictionary */

export type Field = { name: string; type: string; description: string };
export type FieldGroup = { object: string; summary: string; fields: Field[] };

/**
 * Field meanings. `/openapi.json` takes its property descriptions from here
 * (by object and field name) and llms-full.txt prints the same table, so the
 * two cannot drift.
 */
export const DATA_DICTIONARY: FieldGroup[] = [
  {
    object: "Amount",
    summary: "One congressional trade's disclosed amount.",
    fields: [
      {
        name: "kind",
        type: "string",
        description:
          "`range` (a bracket), `open_ended` (top bracket, no ceiling), `exact` (the filing printed a figure) or `unknown` (no amount filed).",
      },
      { name: "min_usd", type: "number|null", description: "Bracket floor in US dollars." },
      {
        name: "max_usd",
        type: "number|null",
        description: "Bracket ceiling in US dollars; null for the open-ended top bracket (no upper bound).",
      },
      {
        name: "exact_usd",
        type: "number|null",
        description: "Set only when the filing itself states a precise figure; otherwise null.",
      },
      {
        name: "disclosed",
        type: "string|null",
        description: "The amount as disclosed, ready to quote: \"$1,001–$15,000\", \"≥$50,000,000\" or an exact figure.",
      },
      {
        name: "midpoint_estimate_usd",
        type: "number|null",
        description:
          "Bracket midpoint: an ESTIMATE computed by this site, not a disclosed figure. Null for an open-ended bracket. Label it as an estimate if used.",
      },
    ],
  },
  {
    object: "Volume",
    summary: "A sum of congressional amounts (a member's, a ticker's, a filtered set's).",
    fields: [
      { name: "min_usd", type: "number", description: "Sum of the disclosed floors of every counted row." },
      {
        name: "max_usd",
        type: "number|null",
        description: "Sum of the disclosed ceilings; null once any counted row is in the open-ended top bracket.",
      },
      { name: "open_ended", type: "boolean", description: "True when the total has no upper bound (quote it as ≥ min_usd)." },
      { name: "disclosed", type: "string", description: "The range, ready to quote: \"$X–$Y\", or \"≥$X\" when open-ended." },
      {
        name: "midpoint_estimate_usd",
        type: "number",
        description:
          "Sum of bracket midpoints (an open-ended row counts at its floor): an ESTIMATE, not a disclosed figure. The dashboard's \"est.\" volume.",
      },
      {
        name: "transcribed_rows_excluded",
        type: "integer",
        description: "Rows transcribed from scanned filings that are in the trade count but excluded from this total.",
      },
    ],
  },
  {
    object: "Trade",
    summary: "One congressional transaction as filed.",
    fields: [
      { name: "id", type: "integer", description: "Row id in this database; stable between runs but not an official identifier." },
      { name: "trade_date", type: "string|null", description: "Transaction date as filed (YYYY-MM-DD)." },
      { name: "filing_date", type: "string|null", description: "Date the report was filed with the House Clerk or Senate eFD." },
      { name: "notification_date", type: "string|null", description: "The form's Notification Date (House only): when the member learned of the trade." },
      {
        name: "disclosure_delay_days",
        type: "integer|null",
        description: "Days from trade_date to filing_date; null when the filed dates contradict. Over 45 is late under the STOCK Act.",
      },
      { name: "late", type: "boolean|null", description: "disclosure_delay_days > 45; null when the delay is unknown." },
      { name: "dates_inconsistent", type: "boolean", description: "The filing's own dates contradict each other; shown as filed, not corrected." },
      { name: "action", type: "string", description: "`purchase`, `sale`, `sale_partial` or `exchange`." },
      { name: "ticker", type: "string|null", description: "Ticker as filed (or read from the asset name); null for assets without one." },
      { name: "asset_name", type: "string", description: "Asset description as filed." },
      { name: "asset_type", type: "string|null", description: "House asset-type code (ST stock, OP option, EF ETF, GS government debt …); null when the Senate label has no equivalent." },
      { name: "owner", type: "string", description: "`self`, `spouse`, `joint` or `dependent_child`." },
      { name: "amount", type: "Amount", description: "The disclosed amount (see Amount)." },
      {
        name: "transcribed",
        type: "boolean",
        description: "True when the row was transcribed from a scanned paper filing. Such rows never enter a dollar total.",
      },
      { name: "counted_in_totals", type: "boolean", description: "Whether this row's amount enters dollar totals (false for transcribed rows)." },
      { name: "member", type: "object", description: "Who filed: name, bioguide_id (null if the roster did not match), party, state, district, chamber, url, api_url." },
      { name: "option", type: "object|null", description: "The option contract when the filing's text names one: kind (call/put), strike_usd, expiry. Never guessed." },
      { name: "industry_group", type: "string|null", description: "The issuer's industry group from its SEC SIC code; null when unclassified." },
      { name: "source_url", type: "string", description: "The original filing: a House Clerk PDF or a Senate eFD page." },
      { name: "url", type: "string", description: "This trade's member page on the dashboard." },
      { name: "ticker_url", type: "string|null", description: "The ticker's page on the dashboard." },
    ],
  },
  {
    object: "InsiderTrade",
    summary: "One SEC Form 4 open-market transaction.",
    fields: [
      { name: "trade_date", type: "string|null", description: "Transaction date as filed." },
      { name: "filing_date", type: "string", description: "Date the Form 4 was filed with the SEC." },
      { name: "action", type: "string", description: "`purchase` (code P) or `sale` (code S)." },
      { name: "shares", type: "number|null", description: "Shares as filed." },
      { name: "price_per_share_usd", type: "number|null", description: "Price as filed; may be a weighted average over several executions." },
      {
        name: "value_usd",
        type: "number|null",
        description: "shares × reported price. Null when the row has no price or its as-filed value is implausible: unknown, never 0.",
      },
      { name: "value_basis", type: "string", description: "Always \"shares × reported price\": computed, not a disclosed range." },
      { name: "late", type: "boolean|null", description: "Filed after the two-business-day Form 4 deadline (federal holidays excluded)." },
      { name: "insider", type: "object", description: "The primary reporting owner: name, CIK, roles." },
      { name: "footnotes", type: "string|null", description: "The filing's footnotes; a weighted-average price range is stated here." },
      { name: "source_url", type: "string", description: "The filing index on SEC EDGAR." },
    ],
  },
  {
    object: "TrackRecordEntry",
    summary:
      "One member's track record at one horizon: how the stocks they traded moved afterwards against SPY. A stock's move, never a profit.",
    fields: [
      { name: "rank", type: "integer|null", description: "Rank by `after_trade.shrunk_excess_move_pts` among members with enough measured decisions; null when not ranked." },
      { name: "horizon_trading_days", type: "integer", description: "30, 90 or 180 trading days after each clock's start." },
      {
        name: "decisions_measured",
        type: "integer",
        description: "Decisions (member, ticker, direction, filing) measured on both clocks at this horizon. Each counts once: no dollar amount weights it.",
      },
      { name: "filings", type: "integer", description: "Filings those decisions come from." },
      {
        name: "after_trade",
        type: "object",
        description:
          "From the first close on or after the trade date: `shrunk_excess_move_pts` (the mean signed move vs SPY in percentage points, × n/(n+k)), `unshrunk_mean_excess_move_pts`, `interval_90_pts` (bootstrap over filings; null if not ranked), `hit_rate`, `share_of_same_date_random_portfolios_beaten` (null without a comparable universe).",
      },
      { name: "after_disclosure", type: "object", description: "The same, from the first close strictly after the filing date: what a member of the public could have copied." },
      { name: "timing_lost_to_disclosure_delay_pts", type: "number", description: "after_trade minus after_disclosure (shrunk scores, same decisions)." },
    ],
  },
];

/** A field's description, for the OpenAPI document. */
export function fieldDescription(object: string, name: string): string {
  const group = DATA_DICTIONARY.find((g) => g.object === object);
  const field = group?.fields.find((f) => f.name === name);
  if (!field) throw new Error(`data dictionary has no ${object}.${name}`);
  return field.description;
}

/* -------------------------------------------------------------------- coverage */

/** Live figures from the database; rendered into llms-full.txt and /methodology. */
export type Coverage = {
  generated_at: string;
  /** Last pipeline write (filings.updated_at), ISO 8601. */
  data_as_of: string | null;
  congress: {
    filings: number;
    filings_house: number;
    filings_senate: number;
    trades: number;
    members: number;
    tickers: number;
    transcribed_trades: number;
    unreadable_filings: number;
    first_filing_date: string | null;
    last_filing_date: string | null;
    first_trade_date: string | null;
    last_trade_date: string | null;
  };
  insiders: {
    filings: number;
    trades: number;
    issuers: number;
    insiders: number;
    first_trade_date: string | null;
    last_trade_date: string | null;
  } | null;
};

/* ----------------------------------------------------------------- endpoints */

export type Endpoint = { path: string; summary: string; example?: string };

/** The public API's endpoints, for llms.txt, llms-full.txt and /methodology. */
export const API_ENDPOINTS: Endpoint[] = [
  { path: "/api/v1", summary: "API index: endpoints, coverage and caveats.", example: "/api/v1" },
  {
    path: "/api/v1/trades",
    summary:
      "Congressional trades, newest first, with whole-match totals. Filters: member_id, member, ticker, action, chamber, party, type, owner, from, to, scans; limit (≤500), offset.",
    example: "/api/v1/trades?ticker=NVDA&action=buy&limit=20",
  },
  {
    path: "/api/v1/members",
    summary: "Members who have traded, with totals. sort, dir, days, limit (≤500).",
    example: "/api/v1/members?sort=trades&limit=20",
  },
  {
    path: "/api/v1/members/{bioguide_id}",
    summary: "One member: whole-record totals, top tickers and recent trades. Append .md for Markdown.",
    example: "/api/v1/members/P000197",
  },
  {
    path: "/api/v1/tickers",
    summary: "Tickers members traded, with totals. sort, dir, days, limit (≤500).",
    example: "/api/v1/tickers?days=90&limit=20",
  },
  {
    path: "/api/v1/tickers/{symbol}",
    summary: "One ticker: totals, the members behind them and recent trades. Append .md for Markdown.",
    example: "/api/v1/tickers/NVDA",
  },
  {
    path: "/api/v1/insiders/{symbol}",
    summary: "SEC Form 4 insider activity for one issuer (separate from congressional data).",
    example: "/api/v1/insiders/LEN",
  },
  {
    path: "/api/v1/track-record",
    summary:
      "Members ranked by how the stocks they traded moved afterwards against SPY (a stock's move, not a profit), from the trade and from the disclosure, with intervals, hit rates and a luck check. horizon = 30, 90 (default) or 180 trading days.",
    example: "/api/v1/track-record?horizon=90",
  },
  { path: "/api/v1/feed.md", summary: "The latest congressional trades and coverage as Markdown.", example: "/api/v1/feed.md" },
];

/* ------------------------------------------------------------------ renderers */

function n(v: number): string {
  return v.toLocaleString("en-US");
}

function span(a: string | null, b: string | null): string {
  return a && b ? `${a} to ${b}` : "none";
}

/** Coverage as Markdown bullets — shared by llms-full.txt and the Markdown views. */
export function coverageLines(c: Coverage): string[] {
  const lines = [
    `- Data as of (last pipeline write): ${c.data_as_of ?? "unknown"}`,
    `- Congressional filings read: ${n(c.congress.filings)} (House ${n(c.congress.filings_house)}, Senate ${n(c.congress.filings_senate)}), filed ${span(c.congress.first_filing_date, c.congress.last_filing_date)}`,
    `- Congressional trades: ${n(c.congress.trades)} by ${n(c.congress.members)} members across ${n(c.congress.tickers)} tickers`,
    `- Trade dates: ${span(c.congress.first_trade_date, c.congress.last_trade_date)} (as filed; late catch-up reports reach back years, and a few mistyped dates lie in the future)`,
    `- Rows transcribed from scanned filings (counted as trades, excluded from every total): ${n(c.congress.transcribed_trades)}`,
    `- Filings that could not be read (not in the data): ${n(c.congress.unreadable_filings)}`,
  ];
  if (c.insiders) {
    lines.push(
      `- SEC Form 4: ${n(c.insiders.trades)} open-market trades in ${n(c.insiders.filings)} filings by ${n(c.insiders.insiders)} insiders at ${n(c.insiders.issuers)} issuers, trade dates ${span(c.insiders.first_trade_date, c.insiders.last_trade_date)}`
    );
  }
  return lines;
}

/** Absolute URL on this deployment. */
function abs(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${path}`;
}

/**
 * `/llms.txt` per llmstxt.org: an H1, a blockquote summary, prose, then H2
 * sections of `- [name](url): description` links. "Optional" is the
 * convention's name for links a short context may skip.
 */
export function llmsTxt(origin: string): string {
  const out: string[] = [];
  out.push(`# ${SITE_NAME}`, "");
  out.push(`> ${SITE_SUMMARY}`, "");
  out.push(
    "Before quoting any figure, read the rules for quoting in llms-full.txt. In short:",
    "",
    ...QUOTING_RULES.slice(0, 5).map((r) => `- ${r.short}`),
    ""
  );
  out.push("## Docs", "");
  out.push(
    `- [Full context for LLMs](${abs(origin, "/llms-full.txt")}): sources, live coverage, data dictionary, API and the rules for quoting, in one file`,
    `- [Methodology](${abs(origin, "/methodology")}): the same rules in plain language for people`,
    `- [OpenAPI 3.1 description](${abs(origin, "/openapi.json")}): machine-readable description of the JSON API`,
    ""
  );
  out.push("## API", "");
  for (const e of API_ENDPOINTS) {
    const href = abs(origin, e.example ?? e.path);
    out.push(`- [${e.path}](${href}): ${e.summary}`);
  }
  out.push("");
  out.push("## Sources", "");
  for (const s of SOURCES) out.push(`- [${s.name}](${s.href}): ${s.what}`);
  out.push("");
  out.push("## Optional", "");
  out.push(
    `- [Dashboard](${abs(origin, "/")}): the human-facing feed`,
    `- [Pipeline status](${abs(origin, "/pipeline")}): coverage, unreadable filings and recent runs`,
    `- [API catalog](${abs(origin, "/.well-known/api-catalog")}): RFC 9727 linkset pointing at the API description`,
    ""
  );
  return out.join("\n");
}

/** `/llms-full.txt`: everything an agent needs, self-contained. */
export function llmsFullTxt(origin: string, coverage: Coverage): string {
  const out: string[] = [];
  out.push(`# ${SITE_NAME} — full context for language models`, "");
  out.push(`> ${SITE_SUMMARY}`, "");
  out.push(`Generated ${coverage.generated_at} from the live database. Canonical copy: ${abs(origin, "/llms-full.txt")}`, "");

  out.push("## Rules for quoting (read first)", "");
  out.push(
    "These rules are not style preferences. Breaking the first three produces false statements, e.g. " +
      "\"Representative X traded $62.5M\" when the filings only disclose brackets whose midpoints sum to an estimate.",
    ""
  );
  QUOTING_RULES.forEach((r, i) => {
    out.push(`${i + 1}. **${r.title}.** ${r.body}`);
  });
  out.push("");
  out.push("### Quoting examples", "");
  out.push(
    "- Right: \"Rep. X disclosed a purchase of NVDA worth $1,001–$15,000 (STOCK Act bracket), traded 2026-03-02 and filed 2026-04-10.\"",
    "- Right: \"Senator Y's 2026 disclosures total $1.2M–$3.4M; the midpoint estimate is about $2.3M.\"",
    "- Right: \"The total is at least $50,000,000 (one trade is in the open-ended top bracket).\"",
    "- Wrong: \"Rep. X bought $8,000 of NVDA.\" (a bracket midpoint stated as a fact)",
    "- Wrong: \"Senator Y traded $2.3M.\" (an estimate without its label or range)",
    "- Wrong: adding an insider's Form 4 value to a member's congressional total.",
    ""
  );

  out.push("## What this is", "");
  out.push(
    `${SITE_NAME} collects public stock-trade disclosures from three official sources, parses them, and reproduces ` +
      "them as filed. Disagreements inside a filing are flagged, not corrected.",
    ""
  );
  out.push("## Sources", "");
  for (const s of SOURCES) {
    out.push(`- **${s.name}** (${s.href}): ${s.what} ${s.how}`);
  }
  out.push("");

  out.push("## Coverage and freshness (live)", "");
  out.push(...coverageLines(coverage), "");
  out.push("### Update cadence", "");
  out.push(...UPDATE_CADENCE.map((l) => `- ${l}`), "");
  out.push("### Known gaps", "");
  out.push(...KNOWN_GAPS.map((l) => `- ${l}`), "");

  out.push("## Data dictionary", "");
  for (const g of DATA_DICTIONARY) {
    out.push(`### ${g.object}`, "", g.summary, "", "| Field | Type | Meaning |", "| --- | --- | --- |");
    for (const f of g.fields) out.push(`| \`${f.name}\` | ${f.type} | ${f.description.replace(/\|/g, "\\|")} |`);
    out.push("");
  }

  out.push("## JSON API", "");
  out.push(
    `Read-only, no key, CORS-enabled, GET only. Base: ${abs(origin, "/api/v1")}. Described in ${abs(origin, "/openapi.json")} (OpenAPI 3.1).`,
    "Every response is `{ data, meta }`; `meta` carries `generated_at`, `data_as_of`, `caveats` (the rules above, one line each) and `docs`.",
    "Unknown parameters and malformed values are rejected with HTTP 400 rather than ignored; `limit` above the maximum is clamped and the clamp is reported in `meta.notices`.",
    ""
  );
  for (const e of API_ENDPOINTS) out.push(`- \`GET ${e.path}\`: ${e.summary}${e.example ? ` Example: ${abs(origin, e.example)}` : ""}`);
  out.push("");
  out.push(
    "Members are keyed by their Bioguide ID (e.g. P000197), the identifier Congress itself uses; `GET /api/v1/members` lists them. " +
      "Dashboard pages are linked from each object's `url` field; link to those rather than constructing page URLs.",
    ""
  );
  out.push("## Disclaimer", "");
  out.push("Public disclosures, shown for information. Not investment advice. A disclosed trade is not evidence of wrongdoing.", "");
  return out.join("\n");
}
