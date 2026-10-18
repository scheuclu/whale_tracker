import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FLUKE_PATH, SEA_PATH, markSvg } from "./brand.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// app/icon.svg is a static file (the favicon has to be one to stay a crisp
// vector), so it cannot import the mark. This keeps it from drifting from the
// header, apple-icon and social cards when the drawing is changed.
test("app/icon.svg draws the same mark as lib/brand.ts", () => {
  const icon = fs.readFileSync(path.join(here, "..", "app", "icon.svg"), "utf8");
  assert.ok(icon.includes(`d="${FLUKE_PATH}"`), "icon.svg fluke path differs from FLUKE_PATH");
  assert.ok(icon.includes(`d="${SEA_PATH}"`), "icon.svg sea path differs from SEA_PATH");
});

test("markSvg is a standalone SVG document", () => {
  const svg = markSvg({ size: 180, radius: 0 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="180" height="180"/);
  assert.match(svg, /rx="0"/);
});
