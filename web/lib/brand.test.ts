import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BOW_TIE_PATH, BRAND_INK, FACE_PATH, markGlyph, markSvg } from "./brand.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// app/icon.svg is a static file (the favicon has to be one to stay a crisp
// vector), so it cannot import the mark. This keeps it from drifting from the
// header, apple-icon and social cards when the drawing is changed.
test("app/icon.svg draws the same mark as lib/brand.ts", () => {
  const icon = fs.readFileSync(path.join(here, "..", "app", "icon.svg"), "utf8");
  assert.ok(icon.includes(`d="${FACE_PATH}"`), "icon.svg face path differs from FACE_PATH");
  assert.ok(icon.includes(`d="${BOW_TIE_PATH}"`), "icon.svg bow-tie path differs from BOW_TIE_PATH");
  assert.ok(icon.includes(markGlyph()), "icon.svg glyph (fills, fill-rule) differs from markGlyph()");
});

test("markSvg is a standalone SVG document", () => {
  const svg = markSvg({ size: 180, radius: 0 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="180" height="180"/);
  assert.match(svg, /rx="0"/);
});

test("the icon is the v2 identity: a paper cat on an ink tile, no gradient", () => {
  const icon = fs.readFileSync(path.join(here, "..", "app", "icon.svg"), "utf8");
  assert.ok(icon.includes(`fill="${BRAND_INK}"`), "icon.svg tile is not the brand ink");
  assert.ok(!/Gradient/.test(icon), "icon.svg still carries a gradient");
  assert.ok(!/Gradient/.test(markSvg()), "markSvg still carries a gradient");
});

test("the face's eyes and nose are cut out", () => {
  // The cut-outs need evenodd: under the default nonzero rule they fill in.
  assert.match(markGlyph(), /fill-rule="evenodd"/);
});
