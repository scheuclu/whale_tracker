import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ISSUER_SORT,
  POLITICIAN_SORT,
  TICKER_SORT,
  isDefaultSort,
  nextSort,
  orderBy,
  parseLimit,
  parseSort,
  sortParams,
  type SortSpec,
} from "./table-sort.ts";
import { stickyShift } from "./sticky-head.ts";
import * as q from "./queries.ts";
import * as iq from "./insider-queries.ts";

// The leaderboards sort from URL parameters. A parameter must never reach
// SQL, the order must hold over the whole result (not the rendered slice),
// and an unknown value (NULL) sorts last whichever way the column goes.

// --- the whitelist -----------------------------------------------------------

test("an unknown or hostile sort key falls back to the default", () => {
  for (const bad of ["volume_mid; DROP TABLE filings", "constructor", "__proto__", "toString", "", "VOLUME"]) {
    const s = parseSort(POLITICIAN_SORT, { sort: bad, dir: "asc" });
    assert.equal(s.key, "volume", `"${bad}" was accepted as a key`);
  }
});

test("a bad direction becomes the column's own first direction", () => {
  assert.deepEqual(parseSort(POLITICIAN_SORT, { sort: "member", dir: "sideways" }), { key: "member", dir: "asc" });
  assert.deepEqual(parseSort(POLITICIAN_SORT, { sort: "trades", dir: "1; --" }), { key: "trades", dir: "desc" });
  assert.deepEqual(parseSort(POLITICIAN_SORT, {}), { key: "volume", dir: "desc" });
});

test("a repeated parameter uses its first value", () => {
  assert.deepEqual(parseSort(TICKER_SORT, { sort: ["trades", "volume"], dir: ["asc", "desc"] }), {
    key: "trades",
    dir: "asc",
  });
});

test("orderBy emits only spec text, whatever the Sort object claims", () => {
  const forged = { key: "1); DELETE FROM transactions; --", dir: "asc" } as never;
  const sql = orderBy(POLITICIAN_SORT, forged);
  assert.ok(!sql.includes("DELETE"), sql);
  assert.ok(sql.startsWith("ORDER BY volume_mid ASC"), sql);
  assert.equal(orderBy(POLITICIAN_SORT, { key: "trades", dir: "evil" as never }).split(",")[0], "ORDER BY trades DESC");
});

test("nullable columns put NULL last in both directions", () => {
  for (const dir of ["asc", "desc"] as const) {
    const sql = orderBy(POLITICIAN_SORT, { key: "delay", dir });
    assert.match(sql, /^ORDER BY \(avg_delay\) IS NULL, avg_delay (ASC|DESC)/);
  }
  assert.ok(!orderBy(POLITICIAN_SORT, { key: "trades", dir: "asc" }).includes("IS NULL"));
});

test("every spec's default is one of its columns", () => {
  for (const spec of [POLITICIAN_SORT, TICKER_SORT, ISSUER_SORT] as SortSpec[]) {
    assert.ok(spec.columns[spec.default], spec.default);
  }
});

test("congressional volume sorts on the midpoint column the table prints, labelled est.", () => {
  assert.equal(POLITICIAN_SORT.columns.volume.expr, "volume_mid");
  assert.equal(TICKER_SORT.columns.volume.expr, "volume_mid");
});

// --- header links ----------------------------------------------------------

test("clicking the active column flips it; another column starts at its first direction", () => {
  const cur = { key: "trades", dir: "desc" } as const;
  assert.deepEqual(nextSort(POLITICIAN_SORT, cur, "trades"), { sort: "trades", dir: "asc" });
  assert.deepEqual(nextSort(POLITICIAN_SORT, cur, "member"), { sort: "member" });
  assert.deepEqual(nextSort(POLITICIAN_SORT, cur, "delay"), { sort: "delay" });
});

test("the default order is spelled as no parameters", () => {
  assert.deepEqual(nextSort(POLITICIAN_SORT, { key: "trades", dir: "desc" }, "volume"), {});
  assert.deepEqual(nextSort(POLITICIAN_SORT, { key: "volume", dir: "desc" }, "volume"), { sort: "volume", dir: "asc" });
  assert.deepEqual(sortParams(TICKER_SORT, { key: "volume", dir: "desc" }), {});
  assert.ok(isDefaultSort(ISSUER_SORT, parseSort(ISSUER_SORT, {})));
});

test("the row limit accepts only its own values", () => {
  assert.equal(parseLimit(undefined).limit, 40);
  assert.equal(parseLimit("200").limit, 200);
  assert.equal(parseLimit("all").n, "all");
  assert.equal(parseLimit("999999").limit, 40);
  assert.equal(parseLimit("-1").limit, 40);
});

// --- the sticky header geometry ---------------------------------------------

test("the header shifts by how far the table slid under the site header, clamped to the table", () => {
  const base = { top: 110, tableHeight: 1000, headHeight: 40 };
  assert.equal(stickyShift({ ...base, tableTop: 300 }), 0, "table below the header: no shift");
  assert.equal(stickyShift({ ...base, tableTop: 10 }), 100);
  assert.equal(stickyShift({ ...base, tableTop: -2000 }), 960, "never past the table's last row");
  assert.equal(stickyShift({ ...base, tableHeight: 20, tableTop: -50 }), 0, "a table shorter than its header");
});

// --- against the committed database -----------------------------------------

type Row = Record<string, unknown>;

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).toLowerCase() < String(b).toLowerCase() ? -1 : String(a).toLowerCase() > String(b).toLowerCase() ? 1 : 0;
}

/** Monotone in `dir`, with every NULL after every value. */
function assertOrdered(rows: Row[], value: (r: Row) => unknown, dir: "asc" | "desc", label: string) {
  let seenNull = false;
  let prev: unknown = undefined;
  rows.forEach((r, i) => {
    const v = value(r);
    if (v == null) {
      seenNull = true;
      return;
    }
    assert.ok(!seenNull, `${label}: a value at row ${i} after a NULL`);
    if (prev !== undefined) {
      const c = cmp(prev, v);
      assert.ok(dir === "asc" ? c <= 0 : c >= 0, `${label}: row ${i} out of order (${String(prev)} then ${String(v)})`);
    }
    prev = v;
  });
}

const buyShare = (r: Row) => {
  const n = (r.buys as number) + (r.sells as number);
  return n ? (r.buys as number) / n : null;
};
const nz = (k: string) => (r: Row) => ((r[k] as number) || null);

const politicianValue: Record<string, (r: Row) => unknown> = {
  member: (r) => r.member_name,
  trades: (r) => r.trades,
  tickers: (r) => r.tickers,
  buysell: buyShare,
  volume: (r) => r.volume_mid,
  delay: (r) => r.avg_delay,
  late: (r) => r.late_count,
  lag: (r) => r.avg_lag,
};

for (const key of Object.keys(POLITICIAN_SORT.columns) as (keyof typeof politicianValue)[]) {
  for (const dir of ["asc", "desc"] as const) {
    test(`members sort by ${key} ${dir}`, async () => {
      const rows = (await q.getPoliticians(undefined, 5000, { key: key as never, dir })) as unknown as Row[];
      assert.ok(rows.length > 10);
      assertOrdered(rows, politicianValue[key], dir, `members/${key}/${dir}`);
    });
  }
}

test("the sort is applied before the limit, over every member", async () => {
  const all = await q.getPoliticians(undefined, 5000, { key: "trades", dir: "asc" });
  const top = await q.getPoliticians(undefined, 5, { key: "trades", dir: "asc" });
  assert.deepEqual(top.map((r) => r.member_name), all.slice(0, 5).map((r) => r.member_name));
  assert.equal(top[0].trades, Math.min(...all.map((r) => r.trades)));
});

test("a member with no measurable delay sorts last both ways", async () => {
  const asc = await q.getPoliticians(undefined, 5000, { key: "delay", dir: "asc" });
  const desc = await q.getPoliticians(undefined, 5000, { key: "delay", dir: "desc" });
  const nulls = asc.filter((r) => r.avg_delay == null).length;
  if (nulls) {
    assert.equal(asc.at(-1)!.avg_delay, null);
    assert.equal(desc.at(-1)!.avg_delay, null);
  }
});

test("the default member order is unchanged: estimated volume, largest first", async () => {
  const rows = await q.getPoliticians(undefined, 5000);
  assertOrdered(rows as unknown as Row[], (r) => r.volume_mid, "desc", "default");
});

const tickerValue: Record<string, (r: Row) => unknown> = {
  ticker: (r) => r.ticker,
  asset: (r) => r.asset_name,
  members: (r) => r.politicians,
  trades: (r) => r.trades,
  buysell: buyShare,
  volume: (r) => r.volume_mid,
  range: (r) => r.volume_min,
};

for (const key of Object.keys(TICKER_SORT.columns)) {
  for (const dir of ["asc", "desc"] as const) {
    test(`tickers sort by ${key} ${dir}, over the whole window`, async () => {
      const all = (await q.getTickers(365, 5000, { key: key as never, dir })) as unknown as Row[];
      const top = (await q.getTickers(365, 40, { key: key as never, dir })) as unknown as Row[];
      assertOrdered(all, tickerValue[key], dir, `tickers/${key}/${dir}`);
      assert.deepEqual(top.map((r) => r.ticker), all.slice(0, 40).map((r) => r.ticker), "limit after sort");
      assert.equal(top[0].total_rows, all.length, "total_rows counts the window, not the page");
    });
  }
}

const issuerValue: Record<string, (r: Row) => unknown> = {
  value: (r) => (r.buy_value as number) + (r.sell_value as number),
  ticker: (r) => r.ticker,
  issuer: (r) => r.issuer_name,
  insiders: (r) => r.insiders,
  filings: (r) => r.filings,
  buysell: buyShare,
  bought: nz("buy_value"),
  sold: nz("sell_value"),
  last: (r) => r.last_tx_date,
};

for (const key of Object.keys(ISSUER_SORT.columns)) {
  for (const dir of ["asc", "desc"] as const) {
    test(`insider issuers sort by ${key} ${dir}, unpriced last`, async () => {
      const all = (await iq.getInsiderIssuers(90, 5000, { key: key as never, dir })) as unknown as Row[];
      const top = (await iq.getInsiderIssuers(90, 40, { key: key as never, dir })) as unknown as Row[];
      assertOrdered(all, issuerValue[key], dir, `issuers/${key}/${dir}`);
      assert.deepEqual(top.map((r) => r.issuer_cik), all.slice(0, 40).map((r) => r.issuer_cik), "limit after sort");
    });
  }
}

test("an issuer with nothing bought is never ranked as the smallest purchase", async () => {
  const asc = await iq.getInsiderIssuers(90, 5000, { key: "bought", dir: "asc" });
  const firstZero = asc.findIndex((r) => !r.buy_value);
  assert.ok(firstZero > 0, "the committed data has both buyers and non-buyers");
  assert.ok(asc.slice(firstZero).every((r) => !r.buy_value), "every zero/unpriced row is at the end");
});

test("the issuers' bar scale is the window's largest value in either direction", async () => {
  const all = await iq.getInsiderIssuers(90, 5000);
  const max = Math.max(...all.map((r) => Math.max(r.buy_value, r.sell_value)));
  const top = await iq.getInsiderIssuers(90, 5, { key: "insiders", dir: "asc" });
  assert.equal(top[0].max_value, max);
});
