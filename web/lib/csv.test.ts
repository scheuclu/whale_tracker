import assert from "node:assert/strict";
import { test } from "node:test";

import { TRANSACTION_CSV_COLUMNS, csvCell, dollars, transactionCsvRow, transactionsCsv } from "./csv.ts";
import type { TransactionRow } from "./queries.ts";

const base: TransactionRow = {
  id: 1,
  tx_date: "2026-03-02",
  notification_date: "2026-03-02",
  action: "purchase",
  ticker: "NVDA",
  asset_name: 'NVIDIA Corporation, "Common" Stock',
  asset_type: "ST",
  owner: null,
  amount_min_cents: 100_100,
  amount_max_cents: 1_500_000,
  amount_exact_cents: null,
  member_name: "Nancy Pelosi",
  party: "D",
  state: "CA",
  district: "11",
  chamber: "house",
  pdf_url: "https://example.test/f.pdf",
  filing_date: "2026-03-20",
  delay_days: 18,
  lag_days: 0,
  dates_inconsistent: 0,
  transcribed: 0,
  doc_id: "20031234",
};

test("the header names every amount as a bracket bound; the one point figure says estimate", () => {
  const header = transactionsCsv([]).split("\r\n")[0];
  assert.equal(header, TRANSACTION_CSV_COLUMNS.join(","));
  assert.ok(header.includes("amount_min_usd") && header.includes("amount_max_usd"));
  const single = TRANSACTION_CSV_COLUMNS.filter((c) => /mid|point|avg|mean/.test(c));
  for (const c of single) assert.ok(c.includes("estimate"), `${c} collapses a bracket without saying so`);
});

test("a bracket exports as floor and ceiling, midpoint labelled", () => {
  const r = transactionCsvRow(base);
  assert.equal(r.amount_min_usd, "1001");
  assert.equal(r.amount_max_usd, "15000");
  assert.equal(r.amount_exact_usd, "");
  assert.equal(r.amount_open_ended, 0);
  assert.equal(r.amount_midpoint_estimate_usd, "8000.50");
});

test("the open-ended top bracket keeps a blank ceiling and the floor as its estimate", () => {
  const r = transactionCsvRow({ ...base, amount_min_cents: 5_000_000_100, amount_max_cents: null });
  assert.equal(r.amount_max_usd, "");
  assert.equal(r.amount_open_ended, 1);
  assert.equal(r.amount_midpoint_estimate_usd, "50000001");
});

test("an exact figure is exported as itself, never as an invented range", () => {
  const r = transactionCsvRow({ ...base, amount_min_cents: 1500, amount_max_cents: 1500, amount_exact_cents: 1500 });
  assert.equal(r.amount_exact_usd, "15");
  assert.equal(r.amount_midpoint_estimate_usd, "15");
  assert.equal(r.amount_open_ended, 0);
});

test("a transcribed row keeps its bracket as read but has no estimate", () => {
  const r = transactionCsvRow({ ...base, transcribed: 1 });
  assert.equal(r.transcribed_from_scan, 1);
  assert.equal(r.amount_min_usd, "1001");
  assert.equal(r.amount_midpoint_estimate_usd, "");
  assert.equal(r.amount_open_ended, 0);
});

test("cells with commas, quotes and newlines are quoted; formula prefixes are neutralised", () => {
  assert.equal(csvCell('a, "b"'), '"a, ""b"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(42), "42");
  const line = transactionsCsv([base]).split("\r\n")[1];
  assert.ok(line.includes('"NVIDIA Corporation, ""Common"" Stock"'));
  assert.equal(line.split(",").length >= TRANSACTION_CSV_COLUMNS.length, true);
});

test("dollars: whole dollars stay whole, cents keep two places, NULL is blank", () => {
  assert.equal(dollars(100_000), "1000");
  assert.equal(dollars(100_050), "1000.50");
  assert.equal(dollars(null), "");
});
