/**
 * The response headers every path carries (next.config.ts `headers()`), and
 * the Content-Security-Policy among them.
 *
 * Why the CSP allows inline scripts rather than using a nonce
 * ----------------------------------------------------------
 * Next's strict option is a per-request nonce (node_modules/next/dist/docs/
 * 01-app/02-guides/content-security-policy.md). A nonce must be unique per
 * response, but every page here is held on Vercel's CDN for a minute
 * (lib/cache-policy.ts): a cached page would replay one nonce to every
 * reader, which is no nonce at all, and dropping the CDN layer to get one
 * would undo the staleness/cost budget that file sets. Hashes cannot stand in
 * either: the App Router streams the RSC payload as inline
 * `self.__next_f.push(…)` scripts whose content differs per page and per data
 * change, and next-themes injects its own inline script before paint.
 *
 * So `script-src` is `'self' 'unsafe-inline'` and everything else is locked to
 * this origin: no third-party script, style, font, image, frame or fetch
 * origin is allowed, objects are off, `<base>` cannot be repointed, forms
 * post only here, and no other site may frame a page. The residual risk is an
 * injected inline script — which needs an HTML-injection bug first; React
 * escapes every rendered string and nothing here sets raw HTML from data
 * (the JSON-LD blocks escape `<`, `>` and `&`: `serializeLd`,
 * lib/structured-data.ts).
 *
 * Every allowance below is deliberate. A new third-party origin (a script, an
 * embed, a client-side fetch) is a CSP change made here, on purpose, with the
 * privacy page updated in the same PR — never a wildcard.
 */

export type CspEnv = {
  /** `next dev`: React needs eval for its debug stacks, Analytics loads its debug script from Vercel's CDN. */
  dev?: boolean;
  /** A Vercel preview deployment: the Vercel Toolbar (comments, flags) is injected from vercel.live. */
  preview?: boolean;
};

type Directives = Record<string, string[]>;

export function cspDirectives({ dev = false, preview = false }: CspEnv = {}): Directives {
  const d: Directives = {
    "default-src": ["'self'"],
    // 'unsafe-inline': see the note above. Vercel Web Analytics is served
    // from this origin (/_vercel/insights/… or its seeded first-party path),
    // so 'self' covers it in production.
    "script-src": ["'self'", "'unsafe-inline'"],
    // React `style` props, next/font's @font-face and the theme script's
    // colour-scheme all arrive inline.
    "style-src": ["'self'", "'unsafe-inline'"],
    // Portraits come through the optimizer (/_next/image, same origin), the
    // brand mark is a data: URI, the share card and scan pages are same-origin
    // routes. blob: for an image a client component builds locally.
    "img-src": ["'self'", "data:", "blob:"],
    // next/font self-hosts Geist at build time: no request reaches Google.
    "font-src": ["'self'"],
    // Analytics beacons and RSC navigations; nothing else is fetched client-side.
    "connect-src": ["'self'"],
    "manifest-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    // The operator's sign-in to /admin may post to our own auth route, which
    // answers with a redirect to the identity provider — and Chrome applies
    // form-action to that redirect. Google or Vercel, whichever the admin
    // uses; drop the other once that is settled. Reader sign-in
    // (/api/auth/google) is a link, not a form, so it needs nothing here;
    // Google is still listed for the admin.
    "form-action": ["'self'", "https://accounts.google.com", "https://vercel.com"],
    // No site may frame a page (clickjacking); X-Frame-Options says the same
    // for browsers that predate CSP 2.
    "frame-ancestors": ["'none'"],
  };
  if (dev) {
    d["script-src"].push("'unsafe-eval'", "https://va.vercel-scripts.com");
    // HMR websocket on the dev server's own host.
    d["connect-src"].push("ws:", "wss:");
  }
  if (preview) {
    // The Vercel Toolbar's documented allowances (vercel.com/docs/vercel-toolbar/managing-toolbar).
    // Preview builds only: production never loads it.
    d["script-src"].push("https://vercel.live");
    d["style-src"].push("https://vercel.live");
    d["img-src"].push("https://vercel.live", "https://vercel.com");
    d["font-src"].push("https://vercel.live", "https://assets.vercel.com");
    d["connect-src"].push("https://vercel.live", "wss://ws-us3.pusher.com");
    d["frame-src"] = ["https://vercel.live"];
  }
  return d;
}

export function contentSecurityPolicy(env: CspEnv = {}): string {
  return Object.entries(cspDirectives(env))
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

/**
 * Two years, subdomains included, without `preload`: submitting the domain
 * to the browsers' preload list is a one-way decision for the owner, so it is
 * proposed rather than made here.
 */
export const HSTS = "max-age=63072000; includeSubDomains";

/**
 * Powerful features the site never uses, switched off for it and for anything
 * it could embed. Only features every current browser recognises — an
 * unknown token is logged as a console error on every page. `web-share` and
 * `clipboard-write` stay at their defaults: the share buttons use both.
 */
export const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "bluetooth=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "browsing-topics=()",
].join(", ");

/** Every response, pages and API alike. */
export function securityHeaders(env: CspEnv = {}): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(env) },
    { key: "Strict-Transport-Security", value: HSTS },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "X-Frame-Options", value: "DENY" },
  ];
}

/** The path every security header applies to: all of them. */
export const SECURITY_SOURCE = "/:path*";
