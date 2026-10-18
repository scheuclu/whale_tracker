/**
 * The OpenAPI 3.1 description of `/api/v1`, served at `/openapi.json`.
 *
 * Parameters are generated from the same whitelist the handlers enforce
 * (`PARAMS` in api-v1.ts) and property descriptions come from the data
 * dictionary in methodology.ts, so the document describes what the code
 * does rather than what someone remembered it doing.
 */

import type { ParamSpec } from "./api-format";
import { MAX_LIMIT, PARAMS } from "./api-v1";
import { CAVEATS, QUOTING_RULES, SITE_NAME, SITE_SUMMARY, fieldDescription } from "./methodology";

type Schema = Record<string, unknown>;

const PARAM_DOCS: Record<string, string> = {
  member_id: "Member's Bioguide ID, e.g. P000197. Mutually exclusive with `member`.",
  member: "Member's display name exactly as listed (for a filer the roster did not match).",
  ticker: "Ticker symbol, case-insensitive.",
  action: "`buy` (purchases) or `sell` (full and partial sales).",
  chamber: "Chamber the filing came from.",
  party: "Party on the roster.",
  type: "Two-letter House asset-type code, e.g. ST (stock), OP (option), EF (ETF).",
  owner: "Whose account: the member's own, spouse, joint or dependent child.",
  from: "Earliest trade date, inclusive (YYYY-MM-DD).",
  to: "Latest trade date, inclusive (YYYY-MM-DD).",
  scans: "`only` or `exclude` rows transcribed from scanned paper filings (which never enter totals).",
  limit: `Rows to return, 1–${MAX_LIMIT}. Larger values are clamped to ${MAX_LIMIT} and reported in meta.notices.`,
  offset: "Rows to skip, for pagination; meta.pagination.next carries the next page's URL.",
  sort: "Sort key. `volume` sorts on the midpoint ESTIMATE; `range` (tickers) on the disclosed floor.",
  dir: "Sort direction; defaults to the key's natural direction.",
  days: "Rolling window on trade date, in days back from today (future-dated typos excluded).",
};

function paramSchema(s: ParamSpec): Schema {
  switch (s.kind) {
    case "int":
      return { type: "integer", minimum: s.min, ...(s.clamp ? {} : { maximum: s.max }), ...(s.default !== undefined ? { default: s.default } : {}) };
    case "enum":
      return { type: "string", enum: [...s.values] };
    case "pattern":
      // A transformed value (upper-cased) is checked after the transform, so
      // the raw input is not bound by the pattern's case.
      return s.transform ? { type: "string", maxLength: s.maxLength } : { type: "string", maxLength: s.maxLength, pattern: s.re.source };
    case "text":
      return { type: "string", maxLength: s.maxLength };
    case "date":
      return { type: "string", format: "date" };
  }
}

function queryParams(spec: Record<string, ParamSpec>): Schema[] {
  return Object.entries(spec).map(([name, s]) => ({
    name,
    in: "query",
    required: false,
    description: PARAM_DOCS[name] ?? name,
    schema: paramSchema(s),
  }));
}

const nullable = (type: string) => ({ type: [type, "null"] });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const d = (object: string, name: string) => fieldDescription(object, name);

const RULES_TEXT = QUOTING_RULES.map((r, i) => `${i + 1}. **${r.title}.** ${r.short}`).join("\n");

function okResponse(description: string, dataSchema: Schema, metaExtra: Schema = {}): Schema {
  return {
    description,
    headers: {
      "Cache-Control": { schema: { type: "string" }, description: "Public, cached for five minutes at the CDN." },
      "Access-Control-Allow-Origin": { schema: { type: "string", const: "*" } },
    },
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["data", "meta"],
          properties: {
            data: dataSchema,
            meta: { allOf: [ref("Meta"), { type: "object", properties: metaExtra }] },
          },
        },
      },
    },
  };
}

const ERRORS = {
  "400": { description: "Unknown parameter, repeated parameter or malformed value.", content: { "application/json": { schema: ref("Error") } } },
  "503": { description: "The database could not be read.", content: { "application/json": { schema: ref("Error") } } },
};
const NOT_FOUND = { description: "No such member, ticker or issuer in the data.", content: { "application/json": { schema: ref("Error") } } };

/** The `.md` form of an entity path returns the same data as Markdown. */
function withMarkdown(resp: Schema): Schema {
  const content = resp.content as Schema;
  return {
    ...resp,
    description: `${resp.description}. With \`.md\` appended to the path segment: the same data as Markdown.`,
    content: { ...content, "text/markdown": { schema: { type: "string" } } },
  };
}

export function openApiDocument(origin: string): Schema {
  return {
    openapi: "3.1.0",
    info: {
      title: `${SITE_NAME} API`,
      version: "1.0.0",
      summary: SITE_SUMMARY,
      description:
        "Read-only public API over US congressional STOCK Act disclosures and SEC Form 4 insider trades. " +
        "No key; GET only; CORS open.\n\n**Rules for quoting — every response repeats them in `meta.caveats`:**\n\n" +
        RULES_TEXT +
        `\n\nFull context: ${origin}/llms-full.txt · Methodology: ${origin}/methodology`,
      license: { name: "Public-domain source data (US government filings)", identifier: "CC0-1.0" },
    },
    externalDocs: { description: "Methodology and rules for quoting", url: `${origin}/methodology` },
    servers: [{ url: origin }],
    // Public and keyless: an explicit empty requirement, not an omission.
    security: [],
    tags: [
      { name: "congress", description: "STOCK Act disclosures by members of Congress. Amounts are brackets." },
      { name: "insiders", description: "SEC Form 4 corporate-insider trades. Never combined with congressional data." },
      { name: "meta", description: "Index and coverage." },
    ],
    paths: {
      "/api/v1": {
        get: {
          operationId: "getIndex",
          tags: ["meta"],
          summary: "Endpoints, live coverage and caveats",
          responses: {
            "200": okResponse("Index", {
              type: "object",
              properties: {
                name: { type: "string" },
                version: { type: "string" },
                endpoints: { type: "array", items: { type: "object", properties: { path: { type: "string" }, summary: { type: "string" }, example: nullable("string") } } },
                coverage: ref("Coverage"),
              },
            }),
            ...ERRORS,
          },
        },
      },
      "/api/v1/trades": {
        get: {
          operationId: "listTrades",
          tags: ["congress"],
          summary: "Congressional trades, newest first",
          description:
            "The feed's filters as query parameters. `meta.total` aggregates every matching row, not just the page returned: " +
            "quote `meta.total.volume.disclosed` as the range; `midpoint_estimate_usd` is an estimate.",
          parameters: queryParams(PARAMS.trades),
          responses: {
            "200": okResponse("Matching trades", { type: "array", items: ref("Trade") }, {
              total: { type: "object", properties: { trades: { type: "integer" }, volume: ref("Volume") } },
              pagination: {
                type: "object",
                properties: { limit: { type: "integer" }, offset: { type: "integer" }, returned: { type: "integer" }, next: nullable("string") },
              },
              filters: { type: "object" },
            }),
            "404": NOT_FOUND,
            ...ERRORS,
          },
        },
      },
      "/api/v1/members": {
        get: {
          operationId: "listMembers",
          tags: ["congress"],
          summary: "Members who have disclosed trades",
          parameters: queryParams(PARAMS.members),
          responses: { "200": okResponse("Members", { type: "array", items: ref("Member") }), ...ERRORS },
        },
      },
      "/api/v1/members/{bioguide_id}": {
        get: {
          operationId: "getMember",
          tags: ["congress"],
          summary: "One member's record, top tickers and recent trades",
          description: "Totals are over the member's whole record. Append `.md` to the id for Markdown.",
          parameters: [
            {
              name: "bioguide_id",
              in: "path",
              required: true,
              description: "Bioguide ID, e.g. P000197; append `.md` for Markdown.",
              schema: { type: "string", pattern: "^[A-Za-z]\\d{6}(\\.md)?$" },
            },
            ...queryParams(PARAMS.member),
          ],
          responses: {
            "200": withMarkdown(
              okResponse(
                "Member",
                {
                  type: "object",
                  properties: {
                    member: ref("MemberDetail"),
                    top_tickers: { type: "array", items: ref("MemberTicker") },
                    recent_trades: { type: "array", items: ref("Trade") },
                  },
                },
                { recent_trades_returned: { type: "integer" }, all_trades: { type: "string" }, markdown: { type: "string" } }
              )
            ),
            "404": NOT_FOUND,
            ...ERRORS,
          },
        },
      },
      "/api/v1/tickers": {
        get: {
          operationId: "listTickers",
          tags: ["congress"],
          summary: "Tickers members traded",
          parameters: queryParams(PARAMS.tickers),
          responses: {
            "200": okResponse("Tickers", { type: "array", items: ref("Ticker") }, { total: { type: "integer", description: "Tickers in the whole result before the limit." } }),
            ...ERRORS,
          },
        },
      },
      "/api/v1/tickers/{symbol}": {
        get: {
          operationId: "getTicker",
          tags: ["congress"],
          summary: "One ticker's congressional totals, members and recent trades",
          description: "Congressional data only; Form 4 insider data is at /api/v1/insiders/{symbol}. Append `.md` for Markdown.",
          parameters: [
            { name: "symbol", in: "path", required: true, description: "Ticker symbol; append `.md` for Markdown.", schema: { type: "string", maxLength: 18 } },
            ...queryParams(PARAMS.ticker),
          ],
          responses: {
            "200": withMarkdown(
              okResponse(
                "Ticker",
                {
                  type: "object",
                  properties: {
                    ticker: ref("Ticker"),
                    members: { type: "array", items: ref("TickerMember") },
                    recent_trades: { type: "array", items: ref("Trade") },
                  },
                },
                { recent_trades_returned: { type: "integer" }, all_trades: { type: "string" }, insiders: { type: "string" }, markdown: { type: "string" } }
              )
            ),
            "404": NOT_FOUND,
            ...ERRORS,
          },
        },
      },
      "/api/v1/insiders/{symbol}": {
        get: {
          operationId: "getInsiderIssuer",
          tags: ["insiders"],
          summary: "SEC Form 4 insider activity for one issuer",
          description:
            "Values are shares × reported price (possibly a weighted average), never a disclosed range. An unpriced value is null, never 0. " +
            "Separate dataset: never add these figures to congressional ones.",
          parameters: [
            { name: "symbol", in: "path", required: true, description: "Issuer ticker symbol.", schema: { type: "string", maxLength: 15 } },
            ...queryParams(PARAMS.insiders),
          ],
          responses: {
            "200": okResponse("Issuer", {
              type: "object",
              properties: {
                dataset: { type: "string", const: "sec_form4" },
                issuer: ref("InsiderIssuer"),
                insiders: { type: "array", items: ref("Insider") },
                recent_trades: { type: "array", items: ref("InsiderTrade") },
              },
            }, { dataset_note: { type: "string" }, recent_trades_returned: { type: "integer" } }),
            "404": NOT_FOUND,
            ...ERRORS,
          },
        },
      },
      "/api/v1/feed.md": {
        get: {
          operationId: "getFeedMarkdown",
          tags: ["congress"],
          summary: "Latest trades, top tickers and coverage as Markdown",
          responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } }, ...ERRORS },
        },
      },
    },
    components: {
      schemas: {
        Meta: {
          type: "object",
          required: ["generated_at", "data_as_of", "caveats", "docs"],
          properties: {
            generated_at: { type: "string", format: "date-time", description: "When this response was built." },
            data_as_of: { ...nullable("string"), description: "Time of the last pipeline write: how fresh the data is." },
            caveats: { type: "array", items: { type: "string" }, description: "The rules for quoting, one line each.", examples: [CAVEATS] },
            docs: {
              type: "object",
              properties: { llms_full: { type: "string" }, openapi: { type: "string" }, methodology: { type: "string" } },
            },
            notices: { type: "array", items: { type: "string" }, description: "Adjustments made to the request, e.g. a clamped limit." },
          },
        },
        Error: {
          type: "object",
          required: ["error", "meta"],
          properties: {
            error: {
              type: "object",
              properties: { status: { type: "integer" }, message: { type: "string" }, details: { type: "array", items: { type: "string" } } },
            },
            meta: ref("Meta"),
          },
        },
        Amount: {
          type: "object",
          description: "A congressional trade's disclosed amount. Quote `disclosed`; never present `midpoint_estimate_usd` as the amount.",
          required: ["kind", "min_usd", "max_usd", "exact_usd", "disclosed", "midpoint_estimate_usd"],
          properties: {
            kind: { type: "string", enum: ["range", "open_ended", "exact", "unknown"], description: d("Amount", "kind") },
            min_usd: { ...nullable("number"), description: d("Amount", "min_usd") },
            max_usd: { ...nullable("number"), description: d("Amount", "max_usd") },
            exact_usd: { ...nullable("number"), description: d("Amount", "exact_usd") },
            disclosed: { ...nullable("string"), description: d("Amount", "disclosed"), examples: ["$1,001–$15,000"] },
            midpoint_estimate_usd: { ...nullable("number"), description: d("Amount", "midpoint_estimate_usd") },
          },
        },
        Volume: {
          type: "object",
          description: "A sum of congressional amounts over counted rows (transcribed rows excluded).",
          required: ["min_usd", "max_usd", "open_ended", "disclosed", "midpoint_estimate_usd", "transcribed_rows_excluded"],
          properties: {
            min_usd: { type: "number", description: d("Volume", "min_usd") },
            max_usd: { ...nullable("number"), description: d("Volume", "max_usd") },
            open_ended: { type: "boolean", description: d("Volume", "open_ended") },
            disclosed: { type: "string", description: d("Volume", "disclosed") },
            midpoint_estimate_usd: { type: "number", description: d("Volume", "midpoint_estimate_usd") },
            transcribed_rows_excluded: { type: "integer", description: d("Volume", "transcribed_rows_excluded") },
          },
        },
        MemberRef: {
          type: "object",
          properties: {
            name: { type: "string" },
            bioguide_id: nullable("string"),
            party: nullable("string"),
            state: nullable("string"),
            district: nullable("string"),
            chamber: nullable("string"),
            url: { type: "string", format: "uri" },
            api_url: nullable("string"),
          },
        },
        Trade: {
          type: "object",
          properties: {
            id: { type: "integer", description: d("Trade", "id") },
            trade_date: { ...nullable("string"), description: d("Trade", "trade_date") },
            filing_date: { ...nullable("string"), description: d("Trade", "filing_date") },
            notification_date: { ...nullable("string"), description: d("Trade", "notification_date") },
            disclosure_delay_days: { ...nullable("integer"), description: d("Trade", "disclosure_delay_days") },
            late: { ...nullable("boolean"), description: d("Trade", "late") },
            dates_inconsistent: { type: "boolean", description: d("Trade", "dates_inconsistent") },
            action: { type: "string", enum: ["purchase", "sale", "sale_partial", "exchange"], description: d("Trade", "action") },
            ticker: { ...nullable("string"), description: d("Trade", "ticker") },
            asset_name: { type: "string", description: d("Trade", "asset_name") },
            asset_type: { ...nullable("string"), description: d("Trade", "asset_type") },
            owner: { type: "string", description: d("Trade", "owner") },
            option: {
              description: d("Trade", "option"),
              oneOf: [
                { type: "null" },
                { type: "object", properties: { kind: { type: "string" }, strike_usd: nullable("number"), expiry: nullable("string") } },
              ],
            },
            amount: { ...ref("Amount"), description: d("Trade", "amount") },
            transcribed: { type: "boolean", description: d("Trade", "transcribed") },
            counted_in_totals: { type: "boolean", description: d("Trade", "counted_in_totals") },
            member: { ...ref("MemberRef"), description: d("Trade", "member") },
            industry_group: { ...nullable("string"), description: d("Trade", "industry_group") },
            source_url: { type: "string", format: "uri", description: d("Trade", "source_url") },
            url: { type: "string", format: "uri", description: d("Trade", "url") },
            ticker_url: { ...nullable("string"), description: d("Trade", "ticker_url") },
          },
        },
        Member: {
          type: "object",
          properties: {
            name: { type: "string" },
            bioguide_id: nullable("string"),
            party: nullable("string"),
            state: nullable("string"),
            district: nullable("string"),
            chamber: nullable("string"),
            trades: { type: "integer", description: "Counted trades, transcribed rows included." },
            tickers: { type: "integer" },
            buys: { type: "integer" },
            sells: { type: "integer" },
            volume: ref("Volume"),
            transcribed_trades: { type: "integer" },
            avg_disclosure_delay_days: { ...nullable("number"), description: "Mean days from trade date to filing date." },
            late_trades: { type: "integer", description: "Trades filed more than 45 days after the trade. A reporting fact, not an allegation." },
            url: { type: "string", format: "uri" },
            api_url: nullable("string"),
          },
        },
        MemberDetail: {
          allOf: [
            ref("Member"),
            {
              type: "object",
              properties: {
                filings: { type: "integer" },
                avg_notification_lag_days: { ...nullable("number"), description: "Mean days until the member learned of the trade. Not a compliance measure." },
                first_trade_date: nullable("string"),
                last_trade_date: nullable("string"),
              },
            },
          ],
        },
        MemberTicker: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            asset_name: nullable("string"),
            trades: { type: "integer" },
            buys: { type: "integer" },
            sells: { type: "integer" },
            volume: ref("Volume"),
            last_trade_date: nullable("string"),
            url: { type: "string" },
            api_url: nullable("string"),
          },
        },
        Ticker: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            asset_name: nullable("string"),
            members: { type: "integer", description: "Distinct members who traded it." },
            buy_members: { type: "integer" },
            sell_members: { type: "integer" },
            trades: { type: "integer" },
            buys: { type: "integer" },
            sells: { type: "integer" },
            volume: ref("Volume"),
            transcribed_trades: { type: "integer" },
            last_trade_date: nullable("string"),
            url: { type: "string" },
            api_url: nullable("string"),
          },
        },
        TickerMember: {
          type: "object",
          properties: {
            name: { type: "string" },
            bioguide_id: nullable("string"),
            party: nullable("string"),
            state: nullable("string"),
            district: nullable("string"),
            chamber: nullable("string"),
            trades: { type: "integer" },
            buys: { type: "integer" },
            sells: { type: "integer" },
            volume: ref("Volume"),
            last_trade_date: nullable("string"),
            url: { type: "string" },
            api_url: nullable("string"),
          },
        },
        InsiderSide: {
          type: "object",
          description: "One direction's Form 4 value: shares × reported price summed over priced rows.",
          properties: {
            trades: { type: "integer" },
            value_usd: { ...nullable("number"), description: "Null when no row in this direction has a usable price: unknown, not zero." },
            unpriced_trades: { type: "integer", description: "Rows without a usable price, absent from value_usd." },
            value_is_partial: { type: "boolean", description: "True when some (not all) rows are unpriced, so value_usd understates the direction." },
          },
        },
        InsiderIssuer: {
          type: "object",
          properties: {
            symbol: nullable("string"),
            issuer_name: nullable("string"),
            issuer_cik: { type: "string" },
            insiders: { type: "integer", description: "Distinct primary reporting owners: a joint filing is one decision." },
            buy_insiders: { type: "integer" },
            sell_insiders: { type: "integer" },
            filings: { type: "integer" },
            trades: { type: "integer" },
            bought: ref("InsiderSide"),
            sold: ref("InsiderSide"),
            value_basis: { type: "string", const: "shares × reported price" },
            last_trade_date: nullable("string"),
            url: nullable("string"),
          },
        },
        Insider: {
          type: "object",
          properties: {
            name: { type: "string" },
            cik: { type: "string" },
            is_director: { type: "boolean" },
            is_officer: { type: "boolean" },
            is_ten_percent_owner: { type: "boolean" },
            officer_title: nullable("string"),
            filings: { type: "integer" },
            buys: { type: "integer" },
            sells: { type: "integer" },
            bought_priced_usd: { ...nullable("number"), description: "shares × reported price over this insider's priced purchases only." },
            sold_priced_usd: { ...nullable("number"), description: "shares × reported price over this insider's priced sales only." },
          },
        },
        InsiderTrade: {
          type: "object",
          properties: {
            id: { type: "integer" },
            trade_date: { ...nullable("string"), description: d("InsiderTrade", "trade_date") },
            trade_date_as_filed: nullable("string"),
            filing_date: { type: "string", description: d("InsiderTrade", "filing_date") },
            disclosure_delay_days: nullable("integer"),
            late: { ...nullable("boolean"), description: d("InsiderTrade", "late") },
            timeliness_box: nullable("string"),
            action: { type: "string", enum: ["purchase", "sale"], description: d("InsiderTrade", "action") },
            transaction_code: { type: "string" },
            security_title: nullable("string"),
            shares: { ...nullable("number"), description: d("InsiderTrade", "shares") },
            price_per_share_usd: { ...nullable("number"), description: d("InsiderTrade", "price_per_share_usd") },
            value_usd: { ...nullable("number"), description: d("InsiderTrade", "value_usd") },
            value_basis: { type: "string", const: "shares × reported price", description: d("InsiderTrade", "value_basis") },
            implausible: { type: "boolean", description: "The as-filed value is beyond belief; shown, never counted." },
            counted_in_totals: { type: "boolean" },
            ownership: nullable("string"),
            nature_of_ownership: nullable("string"),
            rule_10b5_1: nullable("boolean"),
            insider: {
              type: "object",
              description: d("InsiderTrade", "insider"),
              properties: {
                name: nullable("string"),
                cik: nullable("string"),
                is_director: { type: "boolean" },
                is_officer: { type: "boolean" },
                is_ten_percent_owner: { type: "boolean" },
                officer_title: nullable("string"),
              },
            },
            reporting_owners_on_filing: { type: "integer" },
            footnotes: { ...nullable("string"), description: d("InsiderTrade", "footnotes") },
            accession: { type: "string" },
            source_url: { type: "string", format: "uri", description: d("InsiderTrade", "source_url") },
          },
        },
        Coverage: {
          type: "object",
          properties: {
            generated_at: { type: "string" },
            data_as_of: nullable("string"),
            congress: { type: "object" },
            insiders: { oneOf: [{ type: "null" }, { type: "object" }] },
          },
        },
      },
    },
  };
}
