import NextAuth from "next-auth";

import { isAllowedAdmin } from "@/lib/admin-auth";

/**
 * "Sign in with Vercel" for /admin, through Auth.js v5.
 *
 * Vercel's identity provider is standard OpenID Connect
 * (https://vercel.com/.well-known/openid-configuration), so it is an Auth.js
 * `oidc` provider: Auth.js discovers the endpoints, sends PKCE (S256), state
 * and nonce, and verifies the ID token's signature, issuer and audience
 * against Vercel's JWKS. No hand-written token exchange.
 *
 * Reads AUTH_SECRET (session encryption), AUTH_VERCEL_ID and
 * AUTH_VERCEL_SECRET (the Vercel App's client ID and secret). The App's
 * callback URL is `<origin>/api/auth/callback/vercel`.
 *
 * JWT sessions, no adapter: a handful of administrators and nothing else to
 * remember about them. Only the identity is kept; Vercel's access and refresh
 * tokens are not stored, because nothing here calls Vercel's API.
 *
 * There is no password or developer login in any environment. Local and
 * end-to-end tests sign in by minting a session cookie with the local
 * AUTH_SECRET (next-auth/jwt `encode`), which exercises exactly the checks
 * production runs.
 *
 * Signing in is not the gate on its own: getAdminSession() re-checks the
 * allowlist on every request, so removing an ID locks that person out on
 * their next click rather than when their session expires.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  // /admin renders its own sign-in panel and its own refusal.
  pages: { signIn: "/admin", error: "/admin" },
  providers: [
    {
      id: "vercel",
      name: "Vercel",
      type: "oidc",
      issuer: "https://vercel.com",
      clientId: process.env.AUTH_VERCEL_ID,
      clientSecret: process.env.AUTH_VERCEL_SECRET,
      checks: ["pkce", "state", "nonce"],
      authorization: { params: { scope: "openid profile email" } },
      profile(p) {
        return { id: String(p.sub), name: (p.name as string) ?? (p.preferred_username as string) ?? null, email: (p.email as string) ?? null, image: (p.picture as string) ?? null };
      },
    },
  ],
  callbacks: {
    signIn({ account, profile }) {
      if (account?.provider !== "vercel") return false;
      return isAllowedAdmin(profile?.sub);
    },
    jwt({ token, profile }) {
      // `sub` is the Vercel user ID; keep it explicit rather than relying on
      // the default mapping.
      if (profile?.sub) token.sub = String(profile.sub);
      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
