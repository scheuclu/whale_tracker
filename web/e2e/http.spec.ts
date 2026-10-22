import { expect, test } from "@playwright/test";
import { DOCUMENTS, LEGACY_REDIRECTS, siteOrigin } from "./routes";

/**
 * Everything checked over plain HTTP, no browser: robots.txt, the sitemap
 * (and a sample of what it lists), legacy redirects, and the public API's
 * shapes and caveats.
 */
test.describe.configure({ mode: "parallel" });

test.describe("crawl surface", () => {
  test("robots.txt allows the site and names the sitemap", async ({ request, baseURL }) => {
    const res = await request.get("/robots.txt");
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^User-Agent: \*$/m);
    // A bare "Disallow: /" would deindex the whole site.
    expect(body).not.toMatch(/^Disallow: \/\s*$/m);
    expect(body).toContain(`Sitemap: ${siteOrigin(baseURL)}/sitemap.xml`);
  });

  test("sitemap.xml is a valid urlset of absolute, unique, live URLs", async ({ request, baseURL }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    const xml = await res.text();
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd()).toMatch(/<\/urlset>$/);

    const urls = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    expect(urls.length, "one <loc> per <url>").toBe((xml.match(/<url>/g) ?? []).length);
    expect(new Set(urls).size, "no duplicate URLs").toBe(urls.length);
    const origin = siteOrigin(baseURL);
    for (const u of urls) expect(u.startsWith(`${origin}/`), u).toBe(true);
    for (const m of xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) expect(m[1]).toMatch(/^\d{4}-\d{2}-\d{2}/);

    const paths = urls.map((u) => u.slice(origin.length));
    for (const section of ["/", "/politicians", "/tickers", "/insiders", "/methodology"]) {
      expect(paths, `sitemap lists ${section}`).toContain(section);
    }
    const members = paths.filter((p) => p.startsWith("/members/"));
    const tickers = paths.filter((p) => p.startsWith("/tickers/"));
    expect(members.length, "member pages in the sitemap").toBeGreaterThan(50);
    expect(tickers.length, "ticker pages in the sitemap").toBeGreaterThan(100);

    // A deterministic sample: every section page, and evenly spaced members
    // and tickers (first and last included).
    const spread = (list: string[], n: number) =>
      list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]);
    const sample = [...paths.filter((p) => !p.startsWith("/members/") && !p.startsWith("/tickers/")), ...spread(members, 6), ...spread(tickers, 6)];
    const results = await Promise.all(
      sample.map(async (p) => ({ p, status: (await request.get(p, { maxRedirects: 0 })).status() }))
    );
    expect(results.filter((r) => r.status !== 200), "sitemap URLs that do not answer 200").toEqual([]);
  });

  for (const doc of DOCUMENTS) {
    test(`serves ${doc.path}`, async ({ request }) => {
      const res = await request.get(doc.path);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toMatch(doc.type);
      expect((await res.body()).length).toBeGreaterThan(100);
    });
  }

  test("llms.txt and openapi.json describe the site", async ({ request }) => {
    const llms = await (await request.get("/llms.txt")).text();
    expect(llms).toMatch(/^# FatCat Watch/);
    expect(llms).toContain("llms-full.txt");

    const spec = await (await request.get("/openapi.json")).json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info?.title).toBeTruthy();
    for (const p of ["/api/v1/trades", "/api/v1/members/{bioguide_id}", "/api/v1/tickers/{symbol}"]) {
      expect(Object.keys(spec.paths), `openapi documents ${p}`).toContain(p);
    }
  });
});

test.describe("legacy URLs", () => {
  for (const { from, to } of LEGACY_REDIRECTS) {
    test(`${from} → 308 ${to}`, async ({ request }) => {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status()).toBe(308);
      expect(new URL(res.headers()["location"], "http://x").pathname).toBe(to);
    });
  }
});

/* ------------------------------------------------------------------ API */

type Amount = {
  kind: "range" | "open_ended" | "exact" | "unknown";
  min_usd: number | null;
  max_usd: number | null;
  exact_usd: number | null;
  disclosed: string | null;
  midpoint_estimate_usd: number | null;
};

/** The amount object obeys the bracket rules it documents. */
function expectAmount(a: Amount, where: string) {
  expect(Object.keys(a).sort(), where).toEqual(
    ["disclosed", "exact_usd", "kind", "max_usd", "midpoint_estimate_usd", "min_usd"].sort()
  );
  switch (a.kind) {
    case "range":
      expect(a.max_usd!, where).toBeGreaterThanOrEqual(a.min_usd!);
      expect(a.exact_usd, where).toBeNull();
      if (a.max_usd !== a.min_usd) expect(a.disclosed, `${where}: a range is quoted as a range`).toContain("–");
      break;
    case "open_ended":
      expect(a.max_usd, `${where}: no invented ceiling`).toBeNull();
      expect(a.midpoint_estimate_usd, `${where}: no midpoint for an open bracket`).toBeNull();
      expect(a.disclosed, where).toMatch(/^≥/);
      break;
    case "exact":
      expect(a.exact_usd, where).not.toBeNull();
      break;
    case "unknown":
      expect(a.min_usd, where).toBeNull();
      break;
    default:
      throw new Error(`${where}: unknown amount kind ${JSON.stringify(a)}`);
  }
}

type Volume = { min_usd: number; max_usd: number | null; open_ended: boolean; disclosed: string; midpoint_estimate_usd: number };

function expectVolume(v: Volume, where: string) {
  expect(typeof v.min_usd, where).toBe("number");
  expect(v.open_ended, where).toBe(v.max_usd === null);
  expect(v.disclosed, where).toMatch(v.open_ended ? /^≥/ : /–|^\$/);
  expect(typeof v.midpoint_estimate_usd, where).toBe("number");
}

function expectMeta(meta: { caveats?: unknown }) {
  expect(Array.isArray(meta.caveats), "meta.caveats is a list").toBe(true);
  const caveats = meta.caveats as string[];
  expect(caveats.length, "meta.caveats non-empty").toBeGreaterThan(0);
  expect(caveats.join(" "), "the bracket caveat is stated").toMatch(/bracket/i);
}

test.describe("API v1", () => {
  test("/api/v1/trades?limit=1", async ({ request }) => {
    const res = await request.get("/api/v1/trades?limit=1");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/json/);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    const t = body.data[0];
    for (const k of ["id", "trade_date", "filing_date", "action", "member", "amount", "counted_in_totals"]) {
      expect(t, `trade has ${k}`).toHaveProperty(k);
    }
    expectAmount(t.amount, "trades[0].amount");
    expectMeta(body.meta);
    expect(body.meta.pagination).toMatchObject({ limit: 1, offset: 0, returned: 1 });
    expectVolume(body.meta.total.volume, "meta.total.volume");
  });

  test("/api/v1/members/P000197", async ({ request }) => {
    const res = await request.get("/api/v1/members/P000197");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.member).toMatchObject({ bioguide_id: "P000197", name: "Nancy Pelosi" });
    expectVolume(body.data.member.volume, "member.volume");
    expect(body.data.recent_trades.length).toBeGreaterThan(0);
    body.data.recent_trades.forEach((t: { amount: Amount }, i: number) => expectAmount(t.amount, `recent_trades[${i}]`));
    expectMeta(body.meta);
  });

  test("/api/v1/tickers/NVDA", async ({ request }) => {
    const res = await request.get("/api/v1/tickers/NVDA");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.ticker.symbol).toBe("NVDA");
    expectVolume(body.data.ticker.volume, "ticker.volume");
    expect(body.data.members.length).toBeGreaterThan(0);
    body.data.recent_trades.forEach((t: { amount: Amount }, i: number) => expectAmount(t.amount, `recent_trades[${i}]`));
    expectMeta(body.meta);
  });

  test("an unknown endpoint is a JSON 404", async ({ request }) => {
    const res = await request.get("/api/v1/no-such-endpoint");
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).toMatch(/json/);
  });
});
