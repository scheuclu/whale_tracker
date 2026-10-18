import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { mock, test } from "node:test";

import { DB_TTL_SECONDS } from "./cache-policy.ts";

// The remote database is re-checked every DB_TTL_SECONDS, and that is only
// cheap because the check is conditional: an unchanged file must come back as
// a 304 and keep the open handle, not be downloaded (18 MB) and reopened.
// A stand-in for the GitHub contents API serves the committed file with an
// ETag; node:test runs each test file in its own process, so the env set here
// stays here.
test("an unchanged remote database is a 304 that keeps the handle; a new one is fetched", async () => {
  const body = fs.readFileSync(path.join(process.cwd(), "..", "data", "trades.sqlite3"));
  let etag = '"v1"';
  const seen: Array<{ status: number; ifNoneMatch: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    const ifNoneMatch = req.headers["if-none-match"];
    const status = ifNoneMatch === etag ? 304 : 200;
    seen.push({ status, ifNoneMatch });
    res.writeHead(status, { ETag: etag });
    res.end(status === 200 ? body : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.TRADES_DB_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/trades.sqlite3`;
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const { getDb } = await import("./db.ts");

    const first = await getDb();
    assert.deepEqual(seen, [{ status: 200, ifNoneMatch: undefined }]);

    // Within the TTL: no request at all.
    mock.timers.tick(DB_TTL_SECONDS * 1000 - 1);
    assert.equal(await getDb(), first);
    assert.equal(seen.length, 1);

    // Past it, unchanged: a conditional request, a 304, the same handle.
    mock.timers.tick(2);
    assert.equal(await getDb(), first);
    assert.deepEqual(seen[1], { status: 304, ifNoneMatch: '"v1"' });

    // The 304 restarted the TTL.
    mock.timers.tick(DB_TTL_SECONDS * 1000 - 1);
    await getDb();
    assert.equal(seen.length, 2);

    // The pipeline commits: the next check downloads and opens the new copy.
    etag = '"v2"';
    mock.timers.tick(2);
    const second = await getDb();
    assert.notEqual(second, first);
    assert.deepEqual(seen[2], { status: 200, ifNoneMatch: '"v1"' });
    assert.ok((second.prepare("SELECT COUNT(*) AS n FROM filings").get() as { n: number }).n > 0);
  } finally {
    mock.timers.reset();
    server.close();
  }
});
