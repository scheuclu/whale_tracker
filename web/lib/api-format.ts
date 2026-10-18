/**
 * The public API's building blocks, free of database access so the tests
 * can exercise them directly: the amount and volume objects that carry the
 * bracket rules in machine-readable form, parameter whitelisting, and the
 * response envelope.
 *
 * Amounts arrive in cents from the query layer (`queries.ts`), which owns
 * every definition — what counts, what a midpoint is, when a total is
 * open-ended. This module only reshapes those results; it never re-derives
 * them from raw rows.
 */

import { CAVEATS } from "./methodology";

/* -------------------------------------------------------------------- money */

/** Cents → dollars, keeping cents only where the figure has them. */
export function dollars(cents: number | null | undefined): number | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  return Math.round(cents) / 100;
}

/** "$1,001", "$2,722.50" — full precision, for quoting. Not the compact `usd`. */
export function fullUsd(cents: number): string {
  const whole = cents % 100 === 0;
  const d = cents / 100;
  return `${d < 0 ? "-" : ""}$${Math.abs(d).toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export type AmountKind = "range" | "open_ended" | "exact" | "unknown";

export type AmountJson = {
  kind: AmountKind;
  min_usd: number | null;
  max_usd: number | null;
  exact_usd: number | null;
  disclosed: string | null;
  midpoint_estimate_usd: number | null;
};

/**
 * One congressional row's disclosed amount. Mirrors `Amount` in
 * src/whale/amounts.py: an exact figure only when the filing printed one,
 * no midpoint for the open-ended top bracket (any would be invented).
 */
export function amountJson(min: number | null, max: number | null, exact: number | null): AmountJson {
  if (exact != null) {
    return {
      kind: "exact",
      min_usd: dollars(exact),
      max_usd: dollars(exact),
      exact_usd: dollars(exact),
      disclosed: fullUsd(exact),
      midpoint_estimate_usd: dollars(exact),
    };
  }
  if (min == null) {
    return { kind: "unknown", min_usd: null, max_usd: null, exact_usd: null, disclosed: null, midpoint_estimate_usd: null };
  }
  if (max == null) {
    return {
      kind: "open_ended",
      min_usd: dollars(min),
      max_usd: null,
      exact_usd: null,
      disclosed: `≥${fullUsd(min)}`,
      midpoint_estimate_usd: null,
    };
  }
  return {
    kind: "range",
    min_usd: dollars(min),
    max_usd: dollars(max),
    exact_usd: null,
    disclosed: min === max ? fullUsd(min) : `${fullUsd(min)}–${fullUsd(max)}`,
    midpoint_estimate_usd: dollars(Math.floor((min + max) / 2)),
  };
}

export type VolumeJson = {
  min_usd: number;
  max_usd: number | null;
  open_ended: boolean;
  disclosed: string;
  midpoint_estimate_usd: number;
  transcribed_rows_excluded: number;
};

/**
 * A congressional total from the query layer's `volume_min` / `volume_max`
 * / `volume_mid` (cents) — already computed over counted rows only, with
 * the ceiling NULL once any row is open-ended.
 */
export function volumeJson(v: {
  volume_min?: number | null;
  volume_max?: number | null;
  volume_mid?: number | null;
  transcribed?: number | null;
}): VolumeJson {
  const min = v.volume_min ?? 0;
  const open = v.volume_max == null;
  return {
    min_usd: dollars(min) ?? 0,
    max_usd: open ? null : dollars(v.volume_max),
    open_ended: open,
    disclosed: open ? `≥${fullUsd(min)}` : min === v.volume_max ? fullUsd(min) : `${fullUsd(min)}–${fullUsd(v.volume_max as number)}`,
    midpoint_estimate_usd: dollars(v.volume_mid ?? 0) ?? 0,
    transcribed_rows_excluded: v.transcribed ?? 0,
  };
}

export const OWNER_JSON: Record<string, string> = { SP: "spouse", JT: "joint", DC: "dependent_child" };

export function ownerJson(code: string | null): string {
  if (!code) return "self";
  return OWNER_JSON[code] ?? code;
}

/* --------------------------------------------------------------- parameters */

export type ParamSpec =
  | { kind: "int"; min: number; max: number; default?: number; clamp?: boolean }
  | { kind: "enum"; values: readonly string[]; default?: string }
  | { kind: "pattern"; re: RegExp; maxLength: number; transform?: (s: string) => string }
  | { kind: "text"; maxLength: number }
  | { kind: "date" };

export type ParsedParams = {
  values: Record<string, string | number>;
  errors: string[];
  notices: string[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whitelist a query string. An unknown key, a repeated key or a value that
 * does not fit its spec is an error (HTTP 400), never silently ignored: a
 * typo'd filter that quietly matches everything is the failure this
 * project exists to avoid. An integer above its ceiling is clamped when the
 * spec allows it, and the clamp is reported.
 */
export function parseParams(search: URLSearchParams, spec: Record<string, ParamSpec>): ParsedParams {
  const values: Record<string, string | number> = {};
  const errors: string[] = [];
  const notices: string[] = [];
  const seen = new Set<string>();

  for (const [key, raw] of search) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) {
      errors.push(`unknown parameter: ${truncate(key)}`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`parameter given more than once: ${key}`);
      continue;
    }
    seen.add(key);
    const s = spec[key];
    const v = raw.trim();
    if (v === "") continue;
    switch (s.kind) {
      case "int": {
        if (!/^\d+$/.test(v)) {
          errors.push(`${key} must be a non-negative integer`);
          break;
        }
        // Past 15 digits a Number loses integer precision; it is over any ceiling anyway.
        let num = v.length > 15 ? Number.MAX_SAFE_INTEGER : Number(v);
        if (num < s.min) {
          errors.push(`${key} must be at least ${s.min}`);
          break;
        }
        if (num > s.max) {
          if (!s.clamp) {
            errors.push(`${key} must be at most ${s.max}`);
            break;
          }
          notices.push(`${key}=${truncate(v)} clamped to ${s.max}`);
          num = s.max;
        }
        values[key] = num;
        break;
      }
      case "enum":
        if (s.values.includes(v)) values[key] = v;
        else errors.push(`${key} must be one of: ${s.values.join(", ")}`);
        break;
      case "pattern": {
        const t = s.transform ? s.transform(v) : v;
        if (t.length <= s.maxLength && s.re.test(t)) values[key] = t;
        else errors.push(`${key} is malformed`);
        break;
      }
      case "text":
        if (v.length <= s.maxLength) values[key] = v;
        else errors.push(`${key} is longer than ${s.maxLength} characters`);
        break;
      case "date":
        // Round-tripped: Date.parse accepts 2026-02-30 and rolls it into March.
        if (ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v) values[key] = v;
        else errors.push(`${key} must be a date, YYYY-MM-DD`);
        break;
    }
  }
  for (const [key, s] of Object.entries(spec)) {
    if (values[key] === undefined && "default" in s && s.default !== undefined) values[key] = s.default;
  }
  return { values, errors, notices };
}

function truncate(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** Ticker symbols as filed: letters, digits, `.`, `-`, `/`, `:` (ASX:LNW). */
export const SYMBOL = /^[A-Z0-9][A-Z0-9.\-/:]{0,14}$/;
/** Congress's own member identifier: one letter, six digits. */
export const BIOGUIDE = /^[A-Z]\d{6}$/;

export function upper(s: string): string {
  return s.toUpperCase();
}

/** A path segment, with an optional `.md` suffix selecting Markdown. */
export function splitFormat(segment: string): { id: string; markdown: boolean } {
  const decoded = safeDecode(segment);
  if (decoded.endsWith(".md")) return { id: decoded.slice(0, -3), markdown: true };
  return { id: decoded, markdown: false };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/* ----------------------------------------------------------------- envelope */

export type Meta = {
  generated_at: string;
  data_as_of: string | null;
  caveats: string[];
  docs: { llms_full: string; openapi: string; methodology: string };
  notices?: string[];
  [k: string]: unknown;
};

export function meta(origin: string, dataAsOf: string | null, extra: Record<string, unknown> = {}): Meta {
  return {
    generated_at: new Date().toISOString(),
    data_as_of: dataAsOf,
    caveats: CAVEATS,
    docs: {
      llms_full: `${origin}/llms-full.txt`,
      openapi: `${origin}/openapi.json`,
      methodology: `${origin}/methodology`,
    },
    ...extra,
  };
}

/** Responses for a public, read-only API: any origin may GET. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
};

/**
 * The data changes when the pipeline commits (every few hours at best), and
 * the server re-reads the database at most every two minutes; five minutes
 * at the CDN with a stale window keeps load off the function without
 * serving anything meaningfully old. Set here, per response, so a change to
 * the app's global caching does not silently change the API's.
 */
export const CACHE_OK = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
export const CACHE_ERROR = "no-store";

export function headers(contentType: string, ok: boolean, origin: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": ok ? CACHE_OK : CACHE_ERROR,
    Link: `<${origin}/openapi.json>; rel="service-desc"; type="application/json", <${origin}/llms-full.txt>; rel="describedby"; type="text/plain"`,
    "X-Content-Type-Options": "nosniff",
    ...CORS_HEADERS,
  };
}

export type ApiResult =
  | { status: 200; body: unknown }
  | { status: 400 | 404 | 503; body: { error: { status: number; message: string; details?: string[] }; meta: Meta } };

export function apiError(
  origin: string,
  status: 400 | 404 | 503,
  message: string,
  details?: string[]
): ApiResult {
  return {
    status,
    body: { error: { status, message, ...(details?.length ? { details } : {}) }, meta: meta(origin, null) },
  };
}

export function jsonResponse(result: ApiResult, origin: string): Response {
  return new Response(`${JSON.stringify(result.body, null, 2)}\n`, {
    status: result.status,
    headers: headers("application/json; charset=utf-8", result.status === 200, origin),
  });
}

export function textResponse(body: string, contentType: string, status: number, origin: string): Response {
  return new Response(body.endsWith("\n") ? body : `${body}\n`, {
    status,
    headers: headers(contentType, status === 200, origin),
  });
}

export function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=86400" } });
}
