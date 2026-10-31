import { expect, test } from "./fixtures";

/**
 * The MCP server over real HTTP: the handshake an MCP client makes, a tool
 * call against the committed database, and the transport's edges (no event
 * stream on GET, 202 for a notification, a parse error for junk).
 */
const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const ACCEPT = { Accept: "application/json, text/event-stream" };

test("an MCP client can connect, list the tools and call one", async ({ request }) => {
  const init = await request.post("/api/mcp", {
    headers: ACCEPT,
    data: rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } }),
  });
  expect(init.status()).toBe(200);
  expect(init.headers()["cache-control"]).toBe("no-store");
  expect((await init.json()).result.protocolVersion).toBe("2025-06-18");

  const note = await request.post("/api/mcp", { headers: ACCEPT, data: { jsonrpc: "2.0", method: "notifications/initialized" } });
  expect(note.status()).toBe(202);

  const list = await request.post("/api/mcp", { headers: ACCEPT, data: rpc("tools/list", undefined, 2) });
  const names = (await list.json()).result.tools.map((t: { name: string }) => t.name);
  expect(names).toContain("search_site");
  expect(names).toContain("get_insider_activity");

  const call = await request.post("/api/mcp", {
    headers: ACCEPT,
    data: rpc("tools/call", { name: "search_site", arguments: { query: "pelosi" } }, 3),
  });
  const result = (await call.json()).result;
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content[0].text).members[0].bioguide_id).toBe("P000197");
});

test("the MCP endpoint has no event stream and refuses junk", async ({ request }) => {
  const get = await request.get("/api/mcp");
  expect(get.status()).toBe(405);
  expect(get.headers()["allow"]).toContain("POST");
  const junk = await request.post("/api/mcp", { headers: { "Content-Type": "application/json" }, data: Buffer.from("{not json") });
  expect(junk.status()).toBe(400);
  expect((await junk.json()).error.code).toBe(-32700);
});
