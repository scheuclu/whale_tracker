import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dataTools } from "./data-tools.ts";
import { MCP_INSTRUCTIONS, MCP_PROTOCOL_VERSIONS, MCP_ROWS, handleMcpBody, handleMcpMessage } from "./mcp.ts";
import { CAVEATS, llmsFullTxt, llmsTxt, MCP_SERVER } from "./methodology.ts";

const CTX = { origin: "https://example.test" };
const req = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

describe("MCP server", () => {
  it("negotiates the protocol version and describes itself", async () => {
    const r = (await handleMcpMessage(req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }), CTX)) as {
      result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string }; instructions: string };
    };
    assert.equal(r.result.protocolVersion, "2025-06-18");
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
    assert.equal(r.result.serverInfo.name, "fatcatwatch");
    for (const c of CAVEATS) assert.ok(r.result.instructions.includes(c));
    const unknown = (await handleMcpMessage(req("initialize", { protocolVersion: "1999-01-01" }), CTX)) as { result: { protocolVersion: string } };
    assert.equal(unknown.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
    assert.ok(MCP_INSTRUCTIONS.includes("search_site"));
  });

  it("lists the chat's tools, read-only, with their schemas", async () => {
    const r = (await handleMcpMessage(req("tools/list"), CTX)) as {
      result: { tools: { name: string; inputSchema: unknown; annotations: { readOnlyHint: boolean } }[] };
    };
    const expected = dataTools(MCP_ROWS);
    assert.deepEqual(
      r.result.tools.map((t) => t.name),
      expected.map((t) => t.name)
    );
    for (const t of r.result.tools) {
      assert.equal(t.annotations.readOnlyHint, true);
      assert.deepEqual(t.inputSchema, expected.find((e) => e.name === t.name)!.parameters);
    }
  });

  it("calls a tool and returns the API's own body, caveats included (committed database)", async () => {
    const r = (await handleMcpMessage(req("tools/call", { name: "get_member", arguments: { bioguide_id: "P000197", limit: 2 } }), CTX)) as {
      result: { content: { type: string; text: string }[]; isError: boolean };
    };
    assert.equal(r.result.isError, false);
    assert.equal(r.result.content[0].type, "text");
    const body = JSON.parse(r.result.content[0].text) as { data: { member: { bioguide_id: string }; recent_trades: unknown[] }; meta: { caveats: string[] } };
    assert.equal(body.data.member.bioguide_id, "P000197");
    assert.equal(body.data.recent_trades.length, 2);
    assert.deepEqual(body.meta.caveats, CAVEATS);
  });

  it("reports a tool's own failure as a result, and an unknown tool as a protocol error", async () => {
    const bad = (await handleMcpMessage(req("tools/call", { name: "list_trades", arguments: { from: "yesterday" } }), CTX)) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /from must be a date/);
    const unknown = (await handleMcpMessage(req("tools/call", { name: "rm_rf" }), CTX)) as { error: { code: number } };
    assert.equal(unknown.error.code, -32602);
    const noArgs = (await handleMcpMessage(req("tools/call", { name: "list_trades", arguments: [1] }), CTX)) as { error: { code: number } };
    assert.equal(noArgs.error.code, -32602);
  });

  it("answers ping, refuses unknown methods, and owes nothing for notifications", async () => {
    assert.deepEqual(await handleMcpMessage(req("ping", undefined, "p"), CTX), { jsonrpc: "2.0", id: "p", result: {} });
    const nf = (await handleMcpMessage(req("resources/list"), CTX)) as { error: { code: number } };
    assert.equal(nf.error.code, -32601);
    assert.equal(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, CTX), null);
    assert.equal(await handleMcpMessage({ jsonrpc: "2.0", id: 9, result: {} }, CTX), null);
    const junk = (await handleMcpMessage({ hello: "world" }, CTX)) as { error: { code: number } };
    assert.equal(junk.error.code, -32600);
  });

  it("handles a batch, dropping notifications", async () => {
    const out = (await handleMcpBody([req("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, req("ping", undefined, 2)], CTX)) as {
      id: number;
    }[];
    assert.deepEqual(
      out.map((r) => r.id),
      [1, 2]
    );
    assert.equal(await handleMcpBody([{ jsonrpc: "2.0", method: "notifications/initialized" }], CTX), null);
  });

  it("is listed for agents in llms.txt and llms-full.txt", () => {
    assert.ok(llmsTxt(CTX.origin).includes(`${CTX.origin}${MCP_SERVER.path}`));
    const coverage = {
      generated_at: "x",
      data_as_of: null,
      congress: {
        filings: 0, filings_house: 0, filings_senate: 0, first_filing_date: null, last_filing_date: null, trades: 0,
        members: 0, tickers: 0, first_trade_date: null, last_trade_date: null, transcribed_trades: 0, unreadable_filings: 0,
      },
      insiders: null,
    };
    assert.ok(llmsFullTxt(CTX.origin, coverage as never).includes(`POST ${MCP_SERVER.path}`));
  });
});
