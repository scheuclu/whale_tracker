import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  exchangeGoogleCode,
  googleAuthorizeUrl,
  googleEmailFromIdToken,
  isSameOrigin,
  newOAuthState,
  openOAuthState,
  pkceChallenge,
  readLoginToken,
  readSession,
  safeNextPath,
  sealOAuthState,
  signLoginToken,
  signSession,
  stateMatches,
  withSignedInFlag,
} from "./auth.ts";
import { signSubscriptionToken } from "./subscription-token.ts";

const SECRET = "test-alerts-secret-at-least-16-bytes";
const NOW = 1_800_000_000;
const CLIENT = "client-123.apps.googleusercontent.com";

function idToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
}

const GOOD_CLAIMS = {
  iss: "https://accounts.google.com",
  aud: CLIENT,
  exp: NOW + 600,
  email: "Reader@Gmail.com",
  email_verified: true,
};

describe("auth: redirects", () => {
  it("keeps same-site paths and refuses everything that could leave the site", () => {
    assert.equal(safeNextPath("/tickers/NVDA?w=30"), "/tickers/NVDA?w=30");
    assert.equal(safeNextPath(undefined), "/account");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "evil", "/api/account", "/a\nb"]) {
      assert.equal(safeNextPath(bad), "/account", bad);
    }
  });

  it("adds the signed-in flag without losing the query or fragment", () => {
    assert.equal(withSignedInFlag("/?watch=NVDA#trades", "google"), "/?watch=NVDA&signed_in=google#trades");
  });
});

describe("auth: tokens", () => {
  it("round-trips a session and refuses it once expired", () => {
    const token = signSession("Reader@Example.com", SECRET, NOW);
    assert.deepEqual(readSession(token, SECRET, NOW + 60), { email: "reader@example.com" });
    assert.equal(readSession(token, SECRET, NOW + 31 * 86400), null);
    assert.equal(readSession(token, "another-secret-of-16-bytes!", NOW), null);
  });

  it("never accepts one purpose's token as another's", () => {
    const login = signLoginToken("reader@example.com", SECRET, NOW);
    assert.equal(readSession(login, SECRET, NOW), null);
    const manage = signSubscriptionToken({ purpose: "manage", email: "reader@example.com" }, SECRET);
    assert.equal(readSession(manage, SECRET, NOW), null);
    assert.equal(readLoginToken(manage, SECRET, NOW), null);
    assert.equal(readLoginToken(signSession("reader@example.com", SECRET, NOW), SECRET, NOW), null);
  });

  it("expires the emailed link after 15 minutes", () => {
    const login = signLoginToken("reader@example.com", SECRET, NOW);
    assert.equal(readLoginToken(login, SECRET, NOW + 14 * 60), "reader@example.com");
    assert.equal(readLoginToken(login, SECRET, NOW + 16 * 60), null);
  });
});

describe("auth: same-origin guard", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://www.fatcatwatch.com/api/account", { method: "POST", headers });
  it("accepts our origin and refuses another or none", () => {
    assert.equal(isSameOrigin(req({ origin: "https://www.fatcatwatch.com" })), true);
    assert.equal(isSameOrigin(req({ origin: "https://evil.example" })), false);
    assert.equal(isSameOrigin(req({ "sec-fetch-site": "same-origin" })), true);
    assert.equal(isSameOrigin(req({})), false);
  });
});

describe("auth: Google", () => {
  it("asks only for openid email, with PKCE", () => {
    const url = new URL(
      googleAuthorizeUrl({ clientId: CLIENT, redirectUri: "https://x/cb", state: "s", verifier: "v" })
    );
    assert.equal(url.searchParams.get("scope"), "openid email");
    assert.equal(url.searchParams.get("code_challenge"), pkceChallenge("v"));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  });

  it("seals the round-trip state and refuses a forged, stale or mismatched one", () => {
    const st = newOAuthState("/tickers/NVDA");
    const sealed = sealOAuthState(st, SECRET, NOW);
    assert.deepEqual(openOAuthState(sealed, SECRET, NOW + 60), st);
    assert.equal(openOAuthState(sealed, SECRET, NOW + 11 * 60), null);
    assert.equal(openOAuthState(`${sealed.split(".")[0]}.AAAA`, SECRET, NOW), null);
    assert.equal(stateMatches(st.state, st.state), true);
    assert.equal(stateMatches("other", st.state), false);
    assert.equal(stateMatches(null, st.state), false);
  });

  it("accepts only a verified address issued by Google for our client", () => {
    assert.equal(googleEmailFromIdToken(idToken(GOOD_CLAIMS), CLIENT, NOW), "reader@gmail.com");
    const bad: Record<string, unknown>[] = [
      { ...GOOD_CLAIMS, aud: "someone-else" },
      { ...GOOD_CLAIMS, iss: "https://evil.example" },
      { ...GOOD_CLAIMS, exp: NOW - 1 },
      { ...GOOD_CLAIMS, email_verified: false },
      { ...GOOD_CLAIMS, email: "nope" },
    ];
    for (const c of bad) assert.equal(googleEmailFromIdToken(idToken(c), CLIENT, NOW), null, JSON.stringify(c));
    assert.equal(googleEmailFromIdToken("garbage", CLIENT, NOW), null);
  });

  it("exchanges the code with the verifier and reads the email", async () => {
    let sent: URLSearchParams | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = init.body as URLSearchParams;
      return new Response(JSON.stringify({ id_token: idToken({ ...GOOD_CLAIMS, exp: Math.floor(Date.now() / 1000) + 600 }) }));
    }) as unknown as typeof fetch;
    const email = await exchangeGoogleCode({
      code: "c",
      verifier: "v",
      redirectUri: "https://x/cb",
      clientId: CLIENT,
      clientSecret: "s",
      fetchImpl,
    });
    assert.equal(email, "reader@gmail.com");
    assert.equal(sent!.get("code_verifier"), "v");
    const refused = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    assert.equal(
      await exchangeGoogleCode({ code: "c", verifier: "v", redirectUri: "r", clientId: CLIENT, clientSecret: "s", fetchImpl: refused }),
      null
    );
  });
});
