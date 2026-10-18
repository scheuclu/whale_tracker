/**
 * Glue between the `/api/v1` builders and Next route handlers: the
 * canonical origin, JSON or Markdown, and the CORS preflight. Every handler
 * is `force-dynamic` (the database is fetched at request time) and sets its
 * own `Cache-Control` — see `CACHE_OK` in api-format.ts.
 */

import type { NextRequest } from "next/server";
import { jsonResponse, optionsResponse, textResponse, type ApiResult } from "./api-format";
import { siteUrl } from "./site-url";

export function originOf(request: NextRequest): string {
  return siteUrl(request.nextUrl.origin);
}

export async function sendJson(
  request: NextRequest,
  build: (origin: string, search: URLSearchParams) => Promise<ApiResult>
): Promise<Response> {
  const origin = originOf(request);
  return jsonResponse(await build(origin, request.nextUrl.searchParams), origin);
}

/** A Markdown view: on success, `render` turns the builder's data into text;
 *  an error stays JSON, which says what was wrong more precisely. */
export async function sendMarkdown<T>(
  request: NextRequest,
  build: (origin: string, search: URLSearchParams) => Promise<ApiResult>,
  render: (data: T, origin: string, dataAsOf: string | null) => string
): Promise<Response> {
  const origin = originOf(request);
  const result = await build(origin, request.nextUrl.searchParams);
  if (result.status !== 200) return jsonResponse(result, origin);
  const body = result.body as { data: T; meta: { data_as_of: string | null } };
  return textResponse(render(body.data, origin, body.meta.data_as_of), "text/markdown; charset=utf-8", 200, origin);
}

export function OPTIONS(): Response {
  return optionsResponse();
}
