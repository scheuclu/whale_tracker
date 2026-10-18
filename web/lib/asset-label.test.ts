import assert from "node:assert/strict";
import { test } from "node:test";

import { assetLabel } from "./asset-label.ts";

// Every input below is a real `transactions.asset_name` from
// data/trades.sqlite3, with the ticker the row carries. assetLabel is
// display-only: the stored name is never touched, and callers keep the
// original in a title.

const cases: [name: string, ticker: string | null, label: string][] = [
  // Plain-equity boilerplate, with and without a dash, any case.
  ["Intel Corporation - Common Stock", "INTC", "Intel Corporation"],
  ["Procter & Gamble Company", "PG", "Procter & Gamble Company"],
  ["FedEx Corporation Common Stock", "FDX", "FedEx Corporation"],
  ["Arcutis Biotherapeutics, Inc. - Common stock", "ARQT", "Arcutis Biotherapeutics, Inc."],
  ["Ferrari N.V. Common Shares", "RACE", "Ferrari N.V."],
  ["Linde plc - Ordinary Shares", "LIN", "Linde plc"],
  ["Amcor plc Ordinary Shares", "AMCR", "Amcor plc"],
  ["UBER TECHNOLOGIES INC. CMN", null, "UBER TECHNOLOGIES INC."],
  ["MARVELL TECHNOLOGY INC, CMN", null, "MARVELL TECHNOLOGY INC"],
  // A share class or series is meaningful and stays.
  ["Bloom Energy Corporation Class A Common Stock", "BE", "Bloom Energy Corporation Class A"],
  ["Palantir Technologies Inc. - Class A Common Stock", "PLTR", "Palantir Technologies Inc. Class A"],
  ["Warner Bros. Discovery, Inc. - Series A Common Stock", "WBD", "Warner Bros. Discovery, Inc. Series A"],
  ["OTC Markets Group Inc. Common Stock Class A", "OTCM", "OTC Markets Group Inc. Class A"],
  ["CHEWY INC CMN CLASS A", null, "CHEWY INC CLASS A"],
  ["Block, Inc. Class A Common Stock,", "XYZ", "Block, Inc. Class A"],
  ["Class A  Common Stock", null, "Class A"],
  // Residue after the asset-type slot is cut; the symbol stays when the
  // row has no ticker of its own to show it.
  ["Vistra Corp. Common Stock (VST) [ST] 1/16/26.", null, "Vistra Corp. (VST)"],
  ["Alphabet Inc. - Class A Common Stock (GOOGL) [ST] 1/16/26.", null, "Alphabet Inc. Class A (GOOGL)"],
  ["REOF XXX, LLC [AB] Francisco, CA.", null, "REOF XXX, LLC"],
  [
    "Philadelphia, PA Municipal Bond [GS] advisors. I have no role in, nor am informed transaction was planned and executed by",
    null,
    "Philadelphia, PA Municipal Bond",
  ],
  [
    "Versant Media Group, Inc. - Class A Common Stock (VSNT) [ST] were surrendered as a result of the spinoff.",
    null,
    "Versant Media Group, Inc. Class A (VSNT)",
  ],
  ["American Funds AMCAP Fund Class A M/F [MF} [OT] M/F (SMCWX) when it should have", null, "American Funds AMCAP Fund Class A M/F"],
  ["Hologic, Inc. [PS] right (CVR) to be paid in 2026-27.", null, "Hologic, Inc."],
  // The row's own ticker is dropped; a different one is kept.
  ["Roper Technologies, Inc. - Common Stock (ROP)", "ROP", "Roper Technologies, Inc."],
  ["Commonwealth Bank Australia Sponsored ADR (CMWAY)", "CMWAY", "Commonwealth Bank Australia Sponsored ADR"],
  ["Atlas Copco AB New Shares Representing Series A Common Stock (Sponsored) (ATLKY)", null, "Atlas Copco AB New Shares Representing Series A Common Stock (Sponsored) (ATLKY)"],
];

for (const [name, ticker, label] of cases) {
  test(`${JSON.stringify(name.slice(0, 60))} → ${JSON.stringify(label)}`, () => {
    assert.equal(assetLabel(name, { ticker }), label);
  });
}

test("meaningful words are never removed", () => {
  const untouched = [
    "Sony Group Corporation American Depositary Shares",
    "Sea Limited American Depositary Shares, each representing one Class A Ordinary Share",
    "British American Tobacco Industries, p.l.c. Common Stock ADR",
    "Sandisk Corporation - Common Stock When-Issued",
    "Central Garden & Pet Company - Class A Common Stock Nonvoting",
    "Cohen & Steers Tax-Advantaged Preferred Securities and Income Fund Common Shares of Beneficial Interest",
    "Alliance Resource Partners, L.P. - Common Units Representing Limited Partnership Interests",
    "California CMNTY Choice Fing Auth 5.00% Due Oct 1, 2056",
    "Fremont IN Cmnty Schs Gen Oblig Bds 4.00% 1/15/2032",
    "Merck & Company, Inc. Common Stock (new)",
    "Owens Corning Inc Common Stock New",
    "US Treasury Note 06/30/27",
  ];
  for (const n of untouched) assert.equal(assetLabel(n, { ticker: null }), n, n);
});

test("'New Common Stock' is left as filed rather than leaving a dangling 'New'", () => {
  assert.equal(
    assetLabel("Berkshire Hathaway Inc. New Common Stock (BRK.B) [ST] sold @ $493.42/share SPY", { ticker: null }),
    "Berkshire Hathaway Inc. New Common Stock (BRK.B)"
  );
});

test("a name that is only boilerplate is returned as filed", () => {
  assert.equal(assetLabel("Common Stock"), "Common Stock");
  assert.equal(assetLabel("Ordinary Shares"), "Ordinary Shares");
});

test("whitespace is collapsed and empty input is empty", () => {
  assert.equal(assetLabel("  Apple   Inc.  "), "Apple Inc.");
  assert.equal(assetLabel(null), "");
  assert.equal(assetLabel(""), "");
});

test("the ticker match ignores case and surrounding space", () => {
  assert.equal(assetLabel("Roper Technologies, Inc. - Common Stock (ROP)", { ticker: " rop " }), "Roper Technologies, Inc.");
});
