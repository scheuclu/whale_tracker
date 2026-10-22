import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BOW_TIE_FILL, BOW_TIE_PATH, FACE_PATH, SQUIRCLE_PATH, markGlyph, markSvg } from "./brand.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const iconSvg = () => fs.readFileSync(path.join(here, "..", "app", "icon.svg"), "utf8").trim();

// app/icon.svg is a static file (the favicon has to be one to stay a crisp
// vector), so it cannot import the mark. This keeps it from drifting from the
// header, apple-icon and social cards when the drawing is changed.
test("app/icon.svg is exactly markSvg()", () => {
  const icon = iconSvg();
  assert.ok(icon.includes(`d="${FACE_PATH}"`), "icon.svg face path differs from FACE_PATH");
  assert.ok(icon.includes(`d="${BOW_TIE_PATH}"`), "icon.svg bow-tie path differs from BOW_TIE_PATH");
  assert.equal(icon, markSvg().replace(/ width="32" height="32"/, ""), "regenerate app/icon.svg from markSvg()");
});

test("markSvg is a standalone SVG document", () => {
  const svg = markSvg({ size: 180, shape: "square" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="180" height="180"/);
  assert.match(svg, /<rect width="32" height="32"/, "the full-bleed variant is a square");
  assert.ok(!svg.includes(SQUIRCLE_PATH));
});

test("the icon is the v3 identity: a white cat on a graphite squircle, gold tie", () => {
  const svg = markSvg();
  assert.ok(svg.includes(`d="${SQUIRCLE_PATH}"`), "the favicon tile is the squircle");
  assert.ok(svg.includes(`fill="${BOW_TIE_FILL}"`), "the tie is gold");
  // The gradient is the icon's only one, and it is graphite: no hue that
  // could read as buy (blue) or sell (red).
  for (const [, hex] of svg.matchAll(/stop-color="#([0-9a-f]{6})"/gi)) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 8, `gradient stop #${hex} is not a neutral grey`);
  }
});

test("the face's eyes and nose are cut out", () => {
  // The cut-outs need evenodd: under the default nonzero rule they fill in.
  assert.match(markGlyph(), /fill-rule="evenodd"/);
});
