import assert from "node:assert/strict";
import { test } from "node:test";

import * as q from "./queries.ts";
import * as iq from "./insider-queries.ts";
import * as sq from "./scan-queries.ts";
import * as aq from "./alert-queries.ts";

// Every query the dashboard runs, executed against the committed database.
// A page renders its error inside a 200 response, so a broken query is
// invisible to a status check: the Insiders tab shipped "no such column:
// f.parse_method" for a day because a shared value helper gained a clause
// that only the congressional tables can satisfy. This is the guard.
const calls: Array<[string, () => Promise<unknown>]> = [
  ["getTickers", () => q.getTickers(90, 5)],
  ["getConsensusTickers", () => q.getConsensusTickers(90, 6)],
  ["getTransactions", () => q.getTransactions({ limit: 5 })],
  ["getTransactions(buy)", () => q.getTransactions({ action: "buy", limit: 5 })],
  ["getPoliticians", () => q.getPoliticians(undefined, 5)],
  ["getPoliticianTotals", () => q.getPoliticianTotals()],
  ["getPoliticianDetail", () => q.getPoliticianDetail("Nancy Pelosi")],
  ["getPoliticianTickers", () => q.getPoliticianTickers("Nancy Pelosi", 5)],
  ["getTickerDetail", () => q.getTickerDetail("NVDA")],
  ["getPipeline", () => q.getPipeline()],
  ["getInsiderTotals", () => iq.getInsiderTotals()],
  ["getInsiderIssuers", () => iq.getInsiderIssuers(30, 5)],
  ["getInsiderIssuer", () => iq.getInsiderIssuer("LEN")],
  ["getInsiderClusters", () => iq.getInsiderClusters(30, 3, 5)],
  ["getInsiderTrades", () => iq.getInsiderTrades({ limit: 5 })],
  ["getIssuerInsiders", () => iq.getIssuerInsiders("LEN")],
  ["getInsiderPipeline", () => iq.getInsiderPipeline()],
  ["getScanFilings", () => sq.getScanFilings()],
  ["getScanFiling", () => sq.getScanFiling("9116308")],
  ["getScanTotals", () => sq.getScanTotals()],
  ["getScanPagePng", () => sq.getScanPagePng(1, 1)],
  ["getAlerts", () => aq.getAlerts({ limit: 5 })],
  ["getAlerts(cluster)", () => aq.getAlerts({ kind: "cluster", limit: 5 })],
  ["getAlertTotals", () => aq.getAlertTotals()],
  ["getAlertsPerWeek", () => aq.getAlertsPerWeek(8)],
];

for (const [name, run] of calls) {
  test(`${name} runs against the committed database`, async () => {
    await assert.doesNotReject(run, `${name} threw`);
  });
}

test("the insider totals are populated, not an error page", async () => {
  const t = await iq.getInsiderTotals();
  assert.ok(t.trades > 0, "insider_transactions is populated in the committed DB");
});
