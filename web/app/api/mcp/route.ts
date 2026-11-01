import type { NextRequest } from "next/server";
import { originOf } from "@/lib/api-route";
import { PARSE_ERROR, handleMcpBody, rpcError } from "@/lib/mcp";

/**
 * The MCP endpoint (Streamable HTTP, stateless JSON). The protocol lives in
 * lib/mcp.ts; this only reads the body and writes the answer. Public and
 * keyless like `/api/v1`, CORS open so browser-based MCP inspectors work,
 * never cached (every call is a POST).
 */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

const HEADERS = { ...CORS, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(rpcError(null, -32600, "request too large"), 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(rpcError(null, PARSE_ERROR, "invalid JSON"), 400);
  }
  const answer = await handleMcpBody(body, { origin: originOf(req) });
  if (answer === null) return new Response(null, { status: 202, headers: HEADERS });
  return json(answer);
}

/** No server-to-client stream: the transport lets a server answer GET with 405. */
export function GET() {
  return new Response("This MCP server answers JSON-RPC over POST; it has no event stream.\n", {
    status: 405,
    headers: { ...HEADERS, Allow: "POST, OPTIONS", "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Stateless: there is no session to end. */
export function DELETE() {
  return new Response(null, { status: 405, headers: { ...HEADERS, Allow: "POST, OPTIONS" } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
