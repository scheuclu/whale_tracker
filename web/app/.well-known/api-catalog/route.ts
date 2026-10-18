import type { NextRequest } from "next/server";
import { CACHE_OK, CORS_HEADERS, optionsResponse } from "@/lib/api-format";
import { originOf } from "@/lib/api-route";

export const dynamic = "force-dynamic";

/**
 * RFC 9727 API catalog: a Linkset (RFC 9264) naming the API, its
 * machine-readable description (service-desc) and its human documentation
 * (service-doc). Chosen because it is a published IETF standard for exactly
 * this; nothing here is an invented convention.
 */
function catalog(origin: string) {
  return {
    linkset: [
      {
        anchor: `${origin}/api/v1`,
        "service-desc": [{ href: `${origin}/openapi.json`, type: "application/json" }],
        "service-doc": [
          { href: `${origin}/methodology`, type: "text/html", title: "Methodology and rules for quoting" },
          { href: `${origin}/llms-full.txt`, type: "text/plain", title: "Full context for language models" },
        ],
      },
    ],
  };
}

function headers(origin: string): Record<string, string> {
  return {
    "Content-Type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    "Cache-Control": CACHE_OK,
    Link: `<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
    ...CORS_HEADERS,
  };
}

export function GET(request: NextRequest) {
  const origin = originOf(request);
  return new Response(`${JSON.stringify(catalog(origin), null, 2)}\n`, { headers: headers(origin) });
}

export function HEAD(request: NextRequest) {
  return new Response(null, { headers: headers(originOf(request)) });
}

export function OPTIONS() {
  return optionsResponse();
}
