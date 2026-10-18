import assert from "node:assert/strict";
import { test } from "node:test";

import * as fmt from "./api-format.ts";
import * as api from "./api-v1.ts";
import * as md from "./api-markdown.ts";
import * as m from "./methodology.ts";
import { openApiDocument } from "./openapi.ts";
import * as q from "./queries.ts";
import * as iq from "./insider-queries.ts";

const ORIGIN = "https://example.test";

/* ----------------------------------------------------------- amount object */

test("a bracket is a range with a labelled midpoint estimate", () => {
  const a = fmt.amountJson(100100, 1500000, null);
  assert.deepEqual(a, {
    kind: "range",
    min_usd: 1001,
    max_usd: 15000,
    exact_usd: null,
    disclosed: "$1,001–$15,000",
    midpoint_estimate_usd: 8000.5,
  });
});

test("the open-ended top bracket has no ceiling and no midpoint", () => {
  const a = fmt.amountJson(5000000000, null, null);
  assert.equal(a.kind, "open_ended");
  assert.equal(a.max_usd, null);
  assert.equal(a.midpoint_estimate_usd, null);
  assert.equal(a.disclosed, "≥$50,000,000");
});

test("an exact figure only when the filing printed one", () => {
  const a = fmt.amountJson(272250, 272250, 272250);
  assert.equal(a.kind, "exact");
  assert.equal(a.exact_usd, 2722.5);
  assert.equal(a.disclosed, "$2,722.50");
  // The same min = max without an exact figure is still a (degenerate) bracket.
  assert.equal(fmt.amountJson(272250, 272250, null).exact_usd, null);
});

test("no amount filed is unknown, never zero", () => {
  const a = fmt.amountJson(null, null, null);
  assert.equal(a.kind, "unknown");
  assert.equal(a.min_usd, null);
  assert.equal(a.disclosed, null);
});

test("a total containing an open-ended row is ≥ its floor", () => {
  const v = fmt.volumeJson({ volume_min: 5000100100, volume_max: null, volume_mid: 5000800000, transcribed: 2 });
  assert.equal(v.open_ended, true);
  assert.equal(v.max_usd, null);
  assert.equal(v.disclosed, "≥$50,001,001");
  assert.equal(v.transcribed_rows_excluded, 2);
  const closed = fmt.volumeJson({ volume_min: 100100, volume_max: 1500000, volume_mid: 800050 });
  assert.equal(closed.disclosed, "$1,001–$15,000");
  assert.equal(closed.open_ended, false);
});

/* ------------------------------------------------------------- parameters */

const spec = api.PARAMS.trades;

test("unknown and repeated parameters are rejected", () => {
  const p = fmt.parseParams(new URLSearchParams("tickr=NVDA&action=buy&action=sell"), spec);
  assert.ok(p.errors.some((e) => e.includes("unknown parameter: tickr")));
  assert.ok(p.errors.some((e) => e.includes("more than once: action")));
});

test("SQL-ish values never pass the whitelist", () => {
  for (const qs of [
    "ticker=' OR 1=1--",
    "ticker=NVDA;DROP TABLE transactions",
    "member_id=P000197' OR '1'='1",
    "action=buy' OR 1=1",
    "from=2026-01-01' OR 1=1",
    "type=ST OR 1",
    "limit=1;DROP",
    "offset=-1",
  ]) {
    const p = fmt.parseParams(new URLSearchParams(qs), spec);
    assert.ok(p.errors.length > 0, `${qs} should be rejected`);
  }
});

test("limit is clamped and the clamp reported; malformed limits are errors", () => {
  const p = fmt.parseParams(new URLSearchParams("limit=999999"), spec);
  assert.equal(p.values.limit, api.MAX_LIMIT);
  assert.equal(p.notices.length, 1);
  assert.equal(fmt.parseParams(new URLSearchParams("limit=0"), spec).errors.length, 1);
  assert.equal(fmt.parseParams(new URLSearchParams("limit=1e3"), spec).errors.length, 1);
  assert.equal(fmt.parseParams(new URLSearchParams(""), spec).values.limit, 50);
});

test("values are normalised: ticker and bioguide upper-cased, dates checked", () => {
  const p = fmt.parseParams(new URLSearchParams("ticker=brk.b&member_id=p000197&from=2026-01-01"), spec);
  assert.deepEqual(p.errors, []);
  assert.equal(p.values.ticker, "BRK.B");
  assert.equal(p.values.member_id, "P000197");
  assert.equal(fmt.parseParams(new URLSearchParams("from=2026-13-45"), spec).errors.length, 1);
  // Date.parse rolls Feb 30 into March; the API refuses it instead.
  assert.equal(fmt.parseParams(new URLSearchParams("from=2026-02-30"), spec).errors.length, 1);
  assert.equal(fmt.parseParams(new URLSearchParams("limit=10000000000000000000"), spec).values.limit, api.MAX_LIMIT);
});

test("a .md suffix selects Markdown", () => {
  assert.deepEqual(fmt.splitFormat("P000197.md"), { id: "P000197", markdown: true });
  assert.deepEqual(fmt.splitFormat("BRK.B"), { id: "BRK.B", markdown: false });
  assert.deepEqual(fmt.splitFormat("BRK.B.md"), { id: "BRK.B", markdown: true });
});

/* -------------------------------------------- builders against the database */

type Body = { data: any; meta: any; error?: any };

async function ok(p: Promise<fmt.ApiResult>): Promise<Body> {
  const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  return r.body as Body;
}

test("hostile requests are 400s with reasons", async () => {
  for (const qs of ["ticker=' OR 1=1--", "nope=1", "member=Nancy%20Pelosi&member_id=P000197", "owner=SP"]) {
    const r = await api.buildTrades(ORIGIN, new URLSearchParams(qs));
    assert.equal(r.status, 400, qs);
    assert.ok((r.body as Body).error.details.length > 0);
  }
  assert.equal((await api.buildMember(ORIGIN, "1 OR 1", new URLSearchParams())).status, 400);
  assert.equal((await api.buildTicker(ORIGIN, "'; --", new URLSearchParams())).status, 400);
  assert.equal((await api.buildMember(ORIGIN, "Z999999", new URLSearchParams())).status, 404);
  assert.equal((await api.buildMembers(ORIGIN, new URLSearchParams("sort=volume_mid;drop"))).status, 400);
});

test("every response carries the caveats and freshness", async () => {
  const b = await ok(api.buildTrades(ORIGIN, new URLSearchParams("limit=1")));
  assert.deepEqual(b.meta.caveats, m.CAVEATS);
  assert.ok(b.meta.data_as_of);
  assert.equal(b.meta.docs.llms_full, `${ORIGIN}/llms-full.txt`);
});

test("member totals agree with the member page's", async () => {
  const b = await ok(api.buildMember(ORIGIN, "P000197", new URLSearchParams("limit=5")));
  const page = await q.getPoliticianDetail("Nancy Pelosi");
  assert.ok(page);
  assert.equal(b.data.member.trades, page.trades);
  assert.equal(b.data.member.volume.min_usd, page.volume_min / 100);
  assert.equal(b.data.member.volume.max_usd, page.volume_max == null ? null : page.volume_max / 100);
  assert.equal(b.data.member.volume.midpoint_estimate_usd, page.volume_mid / 100);
  assert.equal(b.data.recent_trades.length, Math.min(5, page.trades));
  assert.equal(b.data.member.url, `${ORIGIN}/members/nancy-pelosi-p000197`);
});

test("ticker totals agree with the ticker page's", async () => {
  const b = await ok(api.buildTicker(ORIGIN, "nvda", new URLSearchParams()));
  const page = await q.getTickerDetail("NVDA");
  assert.ok(page);
  assert.equal(b.data.ticker.trades, page.trades);
  assert.equal(b.data.ticker.members, page.politicians);
  assert.equal(b.data.ticker.volume.min_usd, page.volume_min / 100);
  assert.equal(b.data.ticker.volume.midpoint_estimate_usd, page.volume_mid / 100);
  assert.equal(b.data.ticker.url, `${ORIGIN}/tickers/NVDA`);
});

test("trade totals agree with the feed's and cover the whole match, not the page", async () => {
  const b = await ok(api.buildTrades(ORIGIN, new URLSearchParams("member_id=P000197&limit=2")));
  const feed = await q.getTransactionTotals({ member: "Nancy Pelosi" });
  assert.equal(b.meta.total.trades, feed.trades);
  assert.equal(b.meta.total.volume.min_usd, feed.volume_min / 100);
  assert.equal(b.data.length, 2);
  assert.ok(b.meta.pagination.next?.includes("offset=2"));
});

test("transcribed rows are listed but not counted, and the sums match", async () => {
  // Tracey Mann's trades all come from scanned filings.
  const b = await ok(api.buildTrades(ORIGIN, new URLSearchParams("member_id=M000871&limit=500")));
  assert.ok(b.data.length > 0);
  for (const t of b.data) {
    assert.equal(t.transcribed, true);
    assert.equal(t.counted_in_totals, false);
  }
  assert.equal(b.meta.total.volume.min_usd, 0);
  assert.equal(b.meta.total.volume.transcribed_rows_excluded, b.data.length);

  // And for any member, the counted rows' floors add up to the total's floor.
  const all = await ok(api.buildTrades(ORIGIN, new URLSearchParams("member_id=P000197&limit=500")));
  assert.ok(all.data.length < 500);
  const floors = all.data
    .filter((t: any) => t.counted_in_totals)
    .reduce((s: number, t: any) => s + Math.round((t.amount.min_usd ?? 0) * 100), 0);
  assert.equal(floors / 100, all.meta.total.volume.min_usd);
});

test("an open-ended trade makes the member total open-ended", async () => {
  const b = await ok(api.buildMember(ORIGIN, "M001163", new URLSearchParams()));
  assert.ok(b.data.recent_trades.some((t: any) => t.amount.kind === "open_ended"));
  assert.equal(b.data.member.volume.open_ended, true);
  assert.equal(b.data.member.volume.max_usd, null);
  assert.ok(b.data.member.volume.disclosed.startsWith("≥"));
});

test("insider values are shares × price, unpriced is null not 0", async () => {
  const b = await ok(api.buildInsiders(ORIGIN, "SBLK", new URLSearchParams()));
  assert.equal(b.data.dataset, "sec_form4");
  const unpriced = b.data.recent_trades.filter((t: any) => t.price_per_share_usd == null || t.value_usd == null);
  assert.ok(unpriced.length > 0);
  for (const t of unpriced) assert.equal(t.value_usd, null);
  assert.ok(b.data.recent_trades.every((t: any) => t.value_basis === "shares × reported price"));
  const issuer = await iq.getInsiderIssuer("LEN");
  const len = await ok(api.buildInsiders(ORIGIN, "LEN", new URLSearchParams()));
  assert.ok(issuer);
  assert.equal(len.data.issuer.insiders, issuer.insiders);
  assert.equal(len.data.issuer.bought.value_usd, issuer.buys ? issuer.buy_value / 100 : 0);
});

test("lists sort through the whitelist and report what was applied", async () => {
  const b = await ok(api.buildMembers(ORIGIN, new URLSearchParams("sort=trades&limit=3")));
  assert.equal(b.data.length, 3);
  assert.deepEqual(b.meta.sort, { key: "trades", dir: "desc" });
  assert.ok(b.data[0].trades >= b.data[1].trades);
  const t = await ok(api.buildTickers(ORIGIN, new URLSearchParams("days=90&limit=2")));
  assert.equal(t.data.length, 2);
  assert.ok(t.meta.total >= 2);
});

/* ------------------------------------------------------ text surfaces */

test("markdown never states a bracket as a bare figure", async () => {
  const b = await ok(api.buildMember(ORIGIN, "P000197", new URLSearchParams("limit=10")));
  const text = md.memberMarkdown(b.data, ORIGIN, b.meta.data_as_of);
  assert.match(text, /^# Nancy Pelosi/);
  assert.match(text, /estimate from bracket midpoints, not a disclosed figure/);
  assert.match(text, /\(bracket\)/);
  // Every "≈$" estimate in a table is labelled "(est.)".
  for (const line of text.split("\n").filter((l) => l.includes("≈$") && l.startsWith("|"))) {
    assert.match(line, /\(est\.\)/);
  }
});

test("llms.txt follows the llmstxt.org shape", () => {
  const t = m.llmsTxt(ORIGIN);
  const lines = t.split("\n");
  assert.match(lines[0], /^# \S/);
  assert.equal(lines.filter((l) => l.startsWith("# ")).length, 1);
  assert.match(lines[2], /^> \S/);
  const sections = lines.filter((l) => l.startsWith("## "));
  assert.ok(sections.includes("## Docs") && sections.includes("## Optional"));
  for (const l of lines.filter((x) => x.startsWith("- ["))) assert.match(l, /^- \[[^\]]+\]\(https?:\/\/[^)]+\)(: .+)?$/);
});

test("llms-full.txt carries every rule and the live coverage", async () => {
  const { getCoverage } = await import("./api-queries.ts");
  const c = await getCoverage();
  const t = m.llmsFullTxt(ORIGIN, c);
  for (const r of m.QUOTING_RULES) assert.ok(t.includes(r.title), r.id);
  assert.ok(t.includes(c.congress.trades.toLocaleString("en-US")));
  for (const s of m.SOURCES) assert.ok(t.includes(s.name));
  assert.ok(t.includes("not investment advice") || t.includes("Not investment advice"));
});

test("the OpenAPI document covers every endpoint and parameter", () => {
  const doc = openApiDocument(ORIGIN) as any;
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.servers[0].url, ORIGIN);
  for (const e of m.API_ENDPOINTS) assert.ok(doc.paths[e.path], e.path);
  const names = (path: string) => doc.paths[path].get.parameters.map((p: any) => p.name).sort();
  assert.deepEqual(names("/api/v1/trades"), Object.keys(api.PARAMS.trades).sort());
  assert.deepEqual(names("/api/v1/members"), Object.keys(api.PARAMS.members).sort());
  assert.ok(doc.info.description.includes(m.QUOTING_RULES[0].short));
});
