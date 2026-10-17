import assert from "node:assert/strict";
import { test } from "node:test";

import { PNG_CACHE_SECONDS, parsePageParams, pngHeaders } from "./scan-image.ts";

test("page params are positive integers or nothing", () => {
  assert.deepEqual(parsePageParams({ filingId: "371", page: "2" }), { filingId: 371, page: 2 });
  assert.equal(parsePageParams({ filingId: "371", page: "0" }), null);
  assert.equal(parsePageParams({ filingId: "-1", page: "1" }), null);
  assert.equal(parsePageParams({ filingId: "371", page: "1.5" }), null);
  assert.equal(parsePageParams({ filingId: "abc", page: "1" }), null);
  assert.equal(parsePageParams({ filingId: "1 OR 1=1", page: "1" }), null);
  assert.equal(parsePageParams({}), null);
});

test("png responses are typed, sized and cached for a week", () => {
  const h = pngHeaders(1234);
  assert.equal(h["Content-Type"], "image/png");
  assert.equal(h["Content-Length"], "1234");
  assert.equal(h["Cache-Control"], `public, max-age=${PNG_CACHE_SECONDS}`);
  assert.equal(PNG_CACHE_SECONDS, 604800);
});
