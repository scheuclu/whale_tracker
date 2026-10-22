import assert from "node:assert/strict";
import { test } from "node:test";

import { contentSecurityPolicy, cspDirectives, HSTS, PERMISSIONS_POLICY, securityHeaders } from "./security-headers.ts";

const parse = (csp: string) =>
  Object.fromEntries(
    csp.split("; ").map((d) => {
      const [k, ...v] = d.split(" ");
      return [k, v];
    })
  ) as Record<string, string[]>;

test("production CSP: scripts and every fetch stay on this origin", () => {
  const d = parse(contentSecurityPolicy());
  assert.deepEqual(d["default-src"], ["'self'"]);
  assert.deepEqual(d["script-src"], ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(d["connect-src"], ["'self'"]);
  assert.deepEqual(d["font-src"], ["'self'"]);
  assert.deepEqual(d["object-src"], ["'none'"]);
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  assert.deepEqual(d["base-uri"], ["'self'"]);
});

test("no wildcard, no eval and no http: source anywhere in production", () => {
  const csp = contentSecurityPolicy();
  assert.doesNotMatch(csp, /\*/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /\bhttp:/);
  assert.doesNotMatch(csp, /vercel\.live|vercel-scripts/);
});

test("every third-party origin in production is one of the deliberate ones", () => {
  const origins = Object.values(cspDirectives())
    .flat()
    .filter((s) => s.startsWith("https://"));
  // Only the operator's sign-in redirect (lib/security-headers.ts, form-action).
  assert.deepEqual(origins, ["https://accounts.google.com", "https://vercel.com"]);
  assert.deepEqual(cspDirectives()["form-action"].slice(1), origins);
});

test("dev adds eval and the analytics debug script; preview adds only the Vercel Toolbar", () => {
  const dev = parse(contentSecurityPolicy({ dev: true }));
  assert.ok(dev["script-src"].includes("'unsafe-eval'"));
  assert.ok(dev["script-src"].includes("https://va.vercel-scripts.com"));
  const preview = parse(contentSecurityPolicy({ preview: true }));
  assert.ok(preview["script-src"].includes("https://vercel.live"));
  assert.ok(!preview["script-src"].includes("'unsafe-eval'"));
  assert.deepEqual(preview["frame-src"], ["https://vercel.live"]);
  assert.deepEqual(preview["frame-ancestors"], ["'none'"]);
});

test("cspDirectives returns a fresh object each call (dev never leaks into prod)", () => {
  cspDirectives({ dev: true });
  assert.ok(!cspDirectives()["script-src"].includes("'unsafe-eval'"));
});

test("the header set is complete", () => {
  const keys = securityHeaders().map((h) => h.key);
  assert.deepEqual(keys.sort(), [
    "Content-Security-Policy",
    "Permissions-Policy",
    "Referrer-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
  ]);
  assert.match(HSTS, /max-age=(\d+)/);
  assert.ok(Number(HSTS.match(/max-age=(\d+)/)![1]) >= 31536000);
});

test("Permissions-Policy leaves sharing and clipboard alone", () => {
  assert.doesNotMatch(PERMISSIONS_POLICY, /web-share|clipboard/);
  assert.doesNotMatch(PERMISSIONS_POLICY, /interest-cohort/); // unknown to current browsers: logs an error
});
