import assert from "node:assert/strict";
import { test } from "node:test";

import { revealOffset, sameEdges, scrollEdges } from "./scroll-edges.ts";

test("content that fits reports no overflow and both edges reached", () => {
  assert.deepEqual(scrollEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }), {
    overflow: false,
    atStart: true,
    atEnd: true,
  });
});

test("a sub-pixel difference between content and viewport is not an overflow", () => {
  // Chrome reports integer scrollWidth but fractional layout widths; a
  // 0.5px excess must not show a "scroll for more" fade.
  assert.equal(scrollEdges({ scrollLeft: 0, scrollWidth: 301, clientWidth: 300 }).overflow, false);
  assert.equal(scrollEdges({ scrollLeft: 0, scrollWidth: 302, clientWidth: 300 }).overflow, true);
});

test("an overflowing container at scrollLeft 0 is at the start only", () => {
  assert.deepEqual(scrollEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 300 }), {
    overflow: true,
    atStart: true,
    atEnd: false,
  });
});

test("mid-scroll is at neither edge", () => {
  assert.deepEqual(scrollEdges({ scrollLeft: 150, scrollWidth: 600, clientWidth: 300 }), {
    overflow: true,
    atStart: false,
    atEnd: false,
  });
});

test("the end is reached within a pixel of the true maximum", () => {
  // iOS reports scrollLeft as a float; 299.4 + 300 is 599.4 against a
  // scrollWidth of 600 and must still count as the end.
  assert.equal(scrollEdges({ scrollLeft: 299.4, scrollWidth: 600, clientWidth: 300 }).atEnd, true);
  assert.equal(scrollEdges({ scrollLeft: 297, scrollWidth: 600, clientWidth: 300 }).atEnd, false);
});

test("sameEdges compares all three flags", () => {
  const a = { overflow: true, atStart: true, atEnd: false };
  assert.equal(sameEdges(a, { ...a }), true);
  assert.equal(sameEdges(a, { ...a, atEnd: true }), false);
  assert.equal(sameEdges(a, { ...a, atStart: false }), false);
  assert.equal(sameEdges(a, { ...a, overflow: false }), false);
});

test("revealOffset leaves a fully visible item alone", () => {
  assert.equal(revealOffset({ scrollLeft: 100, clientWidth: 300, itemLeft: 150, itemWidth: 80 }), 100);
});

test("revealOffset centres an item hidden past the right edge", () => {
  // Item spans 500..600 in content space; a 300px viewport centred on 550
  // starts at 400.
  assert.equal(revealOffset({ scrollLeft: 0, clientWidth: 300, itemLeft: 500, itemWidth: 100 }), 400);
});

test("revealOffset never asks for a negative scroll position", () => {
  assert.equal(revealOffset({ scrollLeft: 400, clientWidth: 300, itemLeft: 10, itemWidth: 60 }), 0);
});

test("revealOffset treats an item within the edge margin as hidden", () => {
  // Item ends at 295 of a 300px viewport: inside, but under the 16px fade.
  const out = revealOffset({ scrollLeft: 0, clientWidth: 300, itemLeft: 215, itemWidth: 80 });
  assert.notEqual(out, 0);
  // Calling again from the new position is a fixed point: no oscillation.
  assert.equal(revealOffset({ scrollLeft: out, clientWidth: 300, itemLeft: 215, itemWidth: 80 }), out);
});
