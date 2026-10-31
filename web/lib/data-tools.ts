/**
 * The site's data as tools a language model can call: the reader chat
 * (`/api/chat`, Gemini function calling) and the MCP endpoint both use this
 * list, so the two cannot describe or compute anything differently.
 *
 * Every tool is a `/api/v1` builder (or the search page's own queries) with
 * the same parameter whitelist, run in-process: no SQL is written here and
 * no figure is re-derived, so every amount reaches the model as the API's
 * range object (`kind`, `min_usd`, `max_usd`, `disclosed`,
 * `midpoint_estimate_usd`) and every total as its `Volume`, transcribed rows
 * already left out. A model that can only call these cannot collapse a
 * bracket or add a transcribed row into a total; it can only misquote one,
 * which the chat's instructions (`chat-prompt.ts`) address.
 *
 * Schemas use the subset of JSON Schema both Gemini's function declarations
 * and MCP's `inputSchema` accept: `type`, `description`, `enum`, `minimum`,
 * `maximum`, `required`. Formats and patterns live in the descriptions and
 * are enforced by the builders' own parameter check, whose 400 the model
 * reads and corrects.
 */

import type { ApiResult, ParamSpec } from "./api-format";
import {
  PARAMS,
  buildIndex,
  buildInsiders,
  buildMember,
  buildMembers,
  buildTicker,
  buildTickers,
  buildTrackRecord,
  buildTrades,
} from "./api-v1";
import { insiderIssuerHref, memberHref, tickerHref } from "./format";
import { searchInsiderIssuers } from "./insider-queries";
import { PARAM_DOCS } from "./openapi";
import { publicErrorMessage } from "./public-error";
import { searchMembers, searchRoster, searchTickers } from "./queries";

export type PropSchema = {
  type: "string" | "integer";
  description: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
};

export type ToolSchema = {
  type: "object";
  properties: Record<string, PropSchema>;
  required?: string[];
};

export type ToolContext = {
  /** The site's canonical origin, for the absolute page links in results. */
  origin: string;
  /** Rows a list returns when the caller names no `limit`, and the most it may ask for. */
  defaultRows: number;
  maxRows: number;
};

export type ToolOutcome = { ok: boolean; body: unknown };
export type ToolArgs = Record<string, unknown>;

export type DataTool = {
  name: string;
  description: string;
  parameters: ToolSchema;
  /** What the reader is shown while it runs ("Looking up NVDA"). Built from validated arguments only. */
  label: (args: ToolArgs) => string;
  run: (args: ToolArgs, ctx: ToolContext) => Promise<ToolOutcome>;
};

/* ------------------------------------------------------------------ schemas */

const SORT_DOCS = {
  members:
    "member (name), trades, tickers, buysell (share of trades that are buys), volume (bracket-midpoint ESTIMATE), " +
    "delay (average disclosure delay in days), late (trades disclosed after the 45-day deadline), lag (notification lag). Default volume.",
  tickers:
    "ticker, asset (name), members (distinct members who traded it), trades, buysell (share of buys), " +
    "volume (bracket-midpoint ESTIMATE), range (disclosed floor). Default volume.",
};

function rowsDoc(ctx: Pick<ToolContext, "defaultRows" | "maxRows">): string {
  return `Rows to return (default ${ctx.defaultRows}, at most ${ctx.maxRows}).`;
}

function propFromSpec(name: string, s: ParamSpec, doc?: string): PropSchema {
  const description = doc ?? PARAM_DOCS[name] ?? name;
  switch (s.kind) {
    case "int":
      return { type: "integer", description, minimum: s.min, ...(s.clamp ? {} : { maximum: s.max }) };
    case "enum":
      return { type: "string", description, enum: [...s.values] };
    case "date":
      return { type: "string", description: `${description} Format YYYY-MM-DD.` };
    case "pattern":
    case "text":
      return { type: "string", description };
  }
}

/** Every key of an API endpoint's whitelist as a tool property; `limit` is described per caller. */
function propsFor(spec: Record<string, ParamSpec>, docs: Record<string, string> = {}): Record<string, PropSchema> {
  const out: Record<string, PropSchema> = {};
  for (const [name, s] of Object.entries(spec)) out[name] = propFromSpec(name, s, docs[name]);
  return out;
}

/* ------------------------------------------------------------------ helpers */

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  return null;
}

function shortLabel(v: unknown): string {
  const s = str(v) ?? "";
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * Tool arguments → the endpoint's query string. An argument the tool does not
 * declare is refused (the model reads the error and corrects); `limit` gets
 * the caller's default and ceiling, and a clamp is reported back.
 */
function toSearch(
  args: ToolArgs,
  declared: Record<string, PropSchema>,
  ctx: ToolContext,
  skip: string[] = []
): { search: URLSearchParams; errors: string[]; notices: string[] } {
  const search = new URLSearchParams();
  const errors: string[] = [];
  const notices: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(declared, k)) {
      errors.push(`unknown argument: ${k}`);
      continue;
    }
    if (skip.includes(k) || v == null) continue;
    const s = str(v);
    if (s === null) {
      if (typeof v === "string") continue;
      errors.push(`${k} must be a string or an integer`);
      continue;
    }
    search.set(k, s);
  }
  if ("limit" in declared && !skip.includes("limit")) {
    const asked = Number(search.get("limit") ?? ctx.defaultRows);
    if (Number.isFinite(asked) && asked > ctx.maxRows) {
      notices.push(`limit=${asked} lowered to ${ctx.maxRows}`);
      search.set("limit", String(ctx.maxRows));
    } else if (!search.has("limit")) {
      search.set("limit", String(ctx.defaultRows));
    }
  }
  return { search, errors, notices };
}

function argError(errors: string[]): ToolOutcome {
  return { ok: false, body: { error: "invalid arguments", details: errors } };
}

function fromApi(result: ApiResult, notices: string[]): ToolOutcome {
  if (result.status !== 200) {
    const e = (result.body as { error: { message: string; details?: string[] } }).error;
    return { ok: false, body: { error: e.message, ...(e.details?.length ? { details: e.details } : {}) } };
  }
  if (!notices.length) return { ok: true, body: result.body };
  const body = result.body as { meta?: { notices?: string[] } };
  return {
    ok: true,
    body: { ...body, meta: { ...body.meta, notices: [...(body.meta?.notices ?? []), ...notices] } },
  };
}

type Builder = (origin: string, search: URLSearchParams) => Promise<ApiResult>;
type PathBuilder = (origin: string, id: string, search: URLSearchParams) => Promise<ApiResult>;

function apiTool(o: {
  name: string;
  description: string;
  properties: Record<string, PropSchema>;
  build: Builder;
  label: DataTool["label"];
}): DataTool {
  return {
    name: o.name,
    description: o.description,
    parameters: { type: "object", properties: o.properties },
    label: o.label,
    async run(args, ctx) {
      const { search, errors, notices } = toSearch(args, o.properties, ctx);
      if (errors.length) return argError(errors);
      return fromApi(await o.build(ctx.origin, search), notices);
    },
  };
}

function pathTool(o: {
  name: string;
  description: string;
  id: { name: string; description: string };
  properties: Record<string, PropSchema>;
  build: PathBuilder;
  label: DataTool["label"];
}): DataTool {
  const properties = { [o.id.name]: { type: "string", description: o.id.description } as PropSchema, ...o.properties };
  return {
    name: o.name,
    description: o.description,
    parameters: { type: "object", properties, required: [o.id.name] },
    label: o.label,
    async run(args, ctx) {
      const id = str(args?.[o.id.name]);
      const { search, errors, notices } = toSearch(args, properties, ctx, [o.id.name]);
      if (!id) errors.unshift(`${o.id.name} is required`);
      if (errors.length) return argError(errors);
      return fromApi(await o.build(ctx.origin, id!, search), notices);
    },
  };
}

/* -------------------------------------------------------------------- tools */

const SEARCH_MAX = 80;
const SEARCH_ROWS = 8;

const searchTool: DataTool = {
  name: "search_site",
  description:
    "Find members of Congress, tickers and SEC Form 4 insider issuers by name, symbol or company name. " +
    "Use it first to turn a person's name into a bioguide_id, or a company into its ticker, before calling the other tools.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "A name, symbol or company, e.g. \"pelosi\", \"NVDA\", \"lockheed\"." } },
    required: ["query"],
  },
  label: (a) => `Searching for “${shortLabel(a.query)}”`,
  async run(args, ctx) {
    const unknown = Object.keys(args ?? {}).filter((k) => k !== "query");
    const q = (str(args?.query) ?? "").slice(0, SEARCH_MAX);
    if (unknown.length || !q) {
      return argError([...unknown.map((k) => `unknown argument: ${k}`), ...(q ? [] : ["query is required"])]);
    }
    try {
      const abs = (path: string) => `${ctx.origin}${path}`;
      const [members, roster, tickers, issuers] = await Promise.all([
        searchMembers(q, SEARCH_ROWS),
        searchRoster(q, 5),
        searchTickers(q, SEARCH_ROWS),
        searchInsiderIssuers(q, 5),
      ]);
      return {
        ok: true,
        body: {
          query: q,
          members: members.map((m) => ({
            name: m.member_name,
            bioguide_id: m.bioguide_id ?? null,
            party: m.party,
            state: m.state,
            district: m.district,
            chamber: m.chamber,
            trades: m.trades,
            tickers: m.tickers,
            last_trade_date: m.last_tx_date,
            url: abs(memberHref(m.member_name, m.bioguide_id)),
          })),
          members_without_disclosed_trades: roster.map((r) => ({
            name: r.full_name,
            bioguide_id: r.bioguide_id ?? null,
            party: r.party,
            state: r.state,
            chamber: r.chamber,
          })),
          tickers: tickers.map((t) => ({
            symbol: t.ticker,
            asset_name: t.asset_name,
            members: t.politicians,
            trades: t.trades,
            last_trade_date: t.last_tx_date,
            url: abs(tickerHref(t.ticker)),
          })),
          insider_issuers: issuers.map((i) => ({
            symbol: i.ticker,
            issuer_name: i.issuer_name,
            issuer_cik: i.issuer_cik,
            insiders: i.insiders,
            filings: i.filings,
            trades: i.trades,
            last_trade_date: i.last_tx_date,
            url: i.ticker ? abs(insiderIssuerHref(i.ticker)) : null,
          })),
        },
      };
    } catch (err) {
      return { ok: false, body: { error: `data unavailable: ${publicErrorMessage(err)}` } };
    }
  },
};

/** The tools, in the order a model should think of them. `rows` describes `limit`. */
export function dataTools(rows: Pick<ToolContext, "defaultRows" | "maxRows">): DataTool[] {
  const limit: PropSchema = { type: "integer", description: rowsDoc(rows), minimum: 1, maximum: rows.maxRows };
  const recentLimit: PropSchema = { ...limit, description: `Recent trades to include. ${rowsDoc(rows)}` };
  const trackProps: Record<string, PropSchema> = {
    horizon: {
      type: "string",
      description: "Trading days after the trade: 30, 90 (default) or 180.",
      enum: PARAMS.track.horizon.values.map(String),
    },
    limit: { ...limit, description: `Ranked members to return. ${rowsDoc(rows)}` },
  };

  return [
    searchTool,
    apiTool({
      name: "list_trades",
      description:
        "Congressional trades (STOCK Act filings), newest first, filtered like the site's feed. " +
        "meta.total covers every matching row, not just the rows returned: quote meta.total.volume.disclosed as the range. " +
        "Each trade's amount is a disclosed bracket (amount.disclosed).",
      properties: { ...propsFor(PARAMS.trades), limit },
      build: buildTrades,
      label: (a) => {
        const bits = [a.ticker, a.member_id ?? a.member, a.action === "buy" ? "buys" : a.action === "sell" ? "sales" : null]
          .map(shortLabel)
          .filter(Boolean);
        return bits.length ? `Looking up trades (${bits.join(", ")})` : "Looking up recent trades";
      },
    }),
    apiTool({
      name: "list_members",
      description:
        "Members of Congress who have disclosed trades, with totals, ranked by `sort`. `days` limits it to trades in the last N days.",
      properties: { ...propsFor(PARAMS.members, { sort: `Sort key: ${SORT_DOCS.members}` }), limit },
      build: buildMembers,
      label: () => "Ranking members",
    }),
    pathTool({
      name: "get_member",
      description:
        "One member's whole record: totals, top tickers, recent trades and track record. Needs the bioguide_id (from search_site).",
      id: { name: "bioguide_id", description: "Bioguide ID, e.g. P000197." },
      properties: { limit: recentLimit },
      build: buildMember,
      label: () => "Reading the member's record",
    }),
    apiTool({
      name: "list_tickers",
      description: "Tickers members of Congress traded, with totals, ranked by `sort`. `days` limits it to trades in the last N days.",
      properties: { ...propsFor(PARAMS.tickers, { sort: `Sort key: ${SORT_DOCS.tickers}` }), limit },
      build: buildTickers,
      label: () => "Ranking tickers",
    }),
    pathTool({
      name: "get_ticker",
      description: "One ticker's congressional record: totals, every member who traded it, and recent trades.",
      id: { name: "symbol", description: "Ticker symbol, e.g. NVDA." },
      properties: { limit: recentLimit },
      build: buildTicker,
      label: (a) => `Reading ${shortLabel(a.symbol).toUpperCase()}`,
    }),
    pathTool({
      name: "get_insider_activity",
      description:
        "SEC Form 4 corporate-insider purchases and sales for one issuer: a separate dataset, never to be added to congressional figures. " +
        "Values are shares × reported price.",
      id: { name: "symbol", description: "The issuer's ticker symbol, e.g. LEN." },
      properties: { limit: recentLimit },
      build: buildInsiders,
      label: (a) => `Reading Form 4 insider trades for ${shortLabel(a.symbol).toUpperCase()}`,
    }),
    {
      name: "get_track_record",
      description:
        "Members ranked by how the stocks they traded moved afterwards against SPY (a stock's move, not a profit), " +
        "measured from the trade and from the disclosure, with intervals and hit rates.",
      parameters: { type: "object", properties: trackProps },
      label: () => "Reading the track record",
      async run(args, ctx) {
        const { search, errors, notices } = toSearch(args, trackProps, ctx, ["limit"]);
        if (errors.length) return argError(errors);
        const n = Math.min(Math.max(1, Number(str(args?.limit) ?? ctx.defaultRows) || ctx.defaultRows), ctx.maxRows);
        const out = fromApi(await buildTrackRecord(ctx.origin, search), notices);
        if (!out.ok) return out;
        const body = out.body as { data: { ranked: unknown[]; not_enough_matured_decisions: unknown[] } };
        const { ranked, not_enough_matured_decisions: waiting, ...rest } = body.data;
        return {
          ok: true,
          body: {
            ...body,
            data: { ...rest, ranked_members: ranked.length, ranked: ranked.slice(0, n), members_not_yet_ranked: waiting.length },
          },
        };
      },
    },
    {
      name: "get_coverage",
      description: "What the data covers: filings and trades read, date spans, unreadable filings, and when it was last updated.",
      parameters: { type: "object", properties: {} },
      label: () => "Checking what the data covers",
      async run(args, ctx) {
        const unknown = Object.keys(args ?? {});
        if (unknown.length) return argError(unknown.map((k) => `unknown argument: ${k}`));
        const out = fromApi(await buildIndex(ctx.origin, new URLSearchParams()), []);
        if (!out.ok) return out;
        const body = out.body as { data: { coverage: unknown }; meta: unknown };
        return { ok: true, body: { data: { coverage: body.data.coverage }, meta: body.meta } };
      },
    },
  ];
}

/* ------------------------------------------------------- shaping for a model */

const API_LINK = /\/api\/v1(\/|$|\?)/;

/**
 * A tool result as the chat model reads it: the rules are already in its
 * instructions, so `meta.caveats` / `meta.docs` (repeated on every API
 * response) go, and so do `/api/v1` links it cannot follow. Page links,
 * filing links and every null stay — a null `max_usd` is what makes a
 * bracket open-ended.
 */
export function compactForModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactForModel);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "caveats" || k === "docs" || k === "generated_at") continue;
    if (typeof v === "string" && API_LINK.test(v)) continue;
    out[k] = compactForModel(v);
  }
  return out;
}

/** The longest array in `value` with more than one element, or null. */
function longestArray(value: unknown): unknown[] | null {
  let best: unknown[] | null = null;
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      if (v.length > 1 && (!best || JSON.stringify(v).length > JSON.stringify(best).length)) best = v;
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(visit);
    }
  };
  visit(value);
  return best;
}

/**
 * Cuts a result to `maxChars` of JSON by halving its longest lists, and says
 * so in `truncated` — the model must know a list is partial before it counts
 * anything in it. Totals in `meta.total` are computed over every row and are
 * never cut.
 */
export function fitToChars(value: unknown, maxChars: number): unknown {
  let copy = JSON.parse(JSON.stringify(value ?? null)) as unknown;
  const notes: string[] = [];
  for (let i = 0; i < 40 && JSON.stringify(copy).length > maxChars; i++) {
    const arr = longestArray(copy);
    if (!arr) break;
    const before = arr.length;
    arr.splice(Math.ceil(before / 2));
    notes.push(`a list was cut from ${before} to ${arr.length} items to fit`);
  }
  if (JSON.stringify(copy).length > maxChars) {
    copy = { error: "result too large to read; ask for fewer rows or a narrower filter" };
  }
  if (!notes.length) return copy;
  const merged = notes.length > 1 ? [`lists were cut to fit (${notes.length} halvings); counts in them are partial`] : notes;
  return copy && typeof copy === "object" && !Array.isArray(copy)
    ? { ...(copy as Record<string, unknown>), truncated: merged }
    : { result: copy, truncated: merged };
}
