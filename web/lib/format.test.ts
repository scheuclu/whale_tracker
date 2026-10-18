import assert from "node:assert/strict";
import { test } from "node:test";

import { range, usd } from "./format.ts";

// `usd` takes cents. The insiders page sums Form 4 values past a billion
// dollars, which used to render as "$2883M"; every unit boundary is pinned
// here so the compact form never reads as a thousand of the smaller unit.

const dollars = (d: number) => d * 100;

test("missing values are a dash, never $0", () => {
  assert.equal(usd(null), "—");
  assert.equal(usd(undefined), "—");
  assert.equal(usd(Number.NaN), "—");
});

test("small figures are whole dollars", () => {
  assert.equal(usd(0), "$0");
  assert.equal(usd(dollars(1_001)), "$1,001");
  assert.equal(usd(dollars(9_999)), "$9,999");
});

test("thousands are k from $10,000", () => {
  assert.equal(usd(dollars(10_000)), "$10k");
  assert.equal(usd(dollars(15_000)), "$15k");
  assert.equal(usd(dollars(750_000)), "$750k");
  assert.equal(usd(dollars(999_400)), "$999k");
});

test("a figure that rounds to 1,000k is $1M", () => {
  assert.equal(usd(dollars(999_600)), "$1M");
});

test("millions keep one decimal and drop a trailing .0", () => {
  assert.equal(usd(dollars(1_000_000)), "$1M");
  assert.equal(usd(dollars(3_000_000)), "$3M");
  assert.equal(usd(dollars(62_500_000)), "$62.5M");
  assert.equal(usd(dollars(101_400_000)), "$101.4M");
});

test("billions are B, not thousands of millions", () => {
  assert.equal(usd(dollars(2_883_000_000)), "$2.9B");
  assert.equal(usd(dollars(16_047_000_000)), "$16B");
  assert.equal(usd(dollars(1_000_000_000)), "$1B");
});

test("a figure that rounds to 1000.0M is $1B", () => {
  assert.equal(usd(dollars(999_960_000)), "$1B");
  assert.equal(usd(dollars(999_940_000)), "$999.9M");
});

test("trillions are T", () => {
  assert.equal(usd(dollars(10_000_000_000_000)), "$10T");
  assert.equal(usd(dollars(999_960_000_000)), "$1T");
});

test("negative values keep their sign in front of the dollar", () => {
  assert.equal(usd(dollars(-2_500_000_000)), "-$2.5B");
});

test("range keeps the open-ended top bracket open", () => {
  assert.equal(range(dollars(50_000_001), null), "≥$50M");
  assert.equal(range(dollars(1_001), dollars(15_000)), "$1,001–$15k");
  assert.equal(range(dollars(1_000_000_000), dollars(5_000_000_000)), "$1B–$5B");
});
