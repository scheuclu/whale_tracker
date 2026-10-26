"use client";

import { trackEvent } from "@/lib/analytics";
import {
  EMPTY_WATCHLIST,
  WATCHLIST_STORAGE_KEY,
  sanitizeWatchlistState,
  type WatchlistState,
} from "@/lib/watchlist";

/**
 * Browser-side state for the watchlist and the reader's account.
 *
 * Following needs an account. The account (`/api/account`) is the source of
 * truth and localStorage is its mirror, so every component reads one place
 * without waiting on the network: each follow is sent to the account item by
 * item, and the stored lists are copied back. Signed out, the watchlist reads
 * as empty and a Follow click is kept as a pending follow (`PENDING_KEY`)
 * while the reader signs in, then applied.
 *
 * A list a browser kept from before following needed an account is merged
 * into the first account that signs in on it; after that (`OWNER_KEY` names
 * the account) the account wins, so something unfollowed on another device
 * is not re-added from here. Signing out clears the mirror: a shared computer
 * should not keep showing someone's follows.
 *
 * Account state is fetched here rather than rendered by the server because
 * pages are cached on the CDN by URL; see `lib/auth.ts`.
 */

export const WATCHLIST_EVENT = "fatcat:watchlist-change";
const ACCOUNT_EVENT = "fatcat:account-change";
const OWNER_KEY = "fatcat_watchlist_owner_v1";
const PENDING_KEY = "fatcat_pending_follow_v1";
/** A pending follow older than this is dropped: the reader gave up on signing in. */
const PENDING_TTL_MS = 60 * 60 * 1000;
const HINT_COOKIE = "fcw_signed_in";

export interface Account {
  email: string;
  members: string[];
  tickers: string[];
  clusters: boolean;
  weeklyDigest: boolean;
  emailAlerts: boolean;
}

export type AccountState =
  | { status: "loading"; account: null }
  | { status: "signed_out"; account: null }
  | { status: "signed_in"; account: Account };

// --- watchlist storage -------------------------------------------------------

export function readWatchlist(): WatchlistState {
  if (typeof window === "undefined") return EMPTY_WATCHLIST;
  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return EMPTY_WATCHLIST;
    return sanitizeWatchlistState(JSON.parse(raw));
  } catch {
    return EMPTY_WATCHLIST;
  }
}

export function writeWatchlist(next: WatchlistState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(WATCHLIST_EVENT));
  } catch {
    /* localStorage unavailable or quota exceeded */
  }
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* unavailable */
  }
}

/** Copies the account's lists into localStorage, keeping remembered labels. */
function mirror(account: Account): void {
  writeWatchlist({ members: account.members, tickers: account.tickers, labels: readWatchlist().labels });
}

// --- account store -----------------------------------------------------------

let state: AccountState = { status: "loading", account: null };
let started = false;
/** Follow changes made while the account was still loading, sent once it has. */
let queued: WatchChange[] = [];

type WatchChange = {
  add?: { members?: string[]; tickers?: string[] };
  remove?: { members?: string[]; tickers?: string[] };
};

function setState(next: AccountState): void {
  state = next;
  window.dispatchEvent(new CustomEvent(ACCOUNT_EVENT));
}

export function getAccountState(): AccountState {
  return state;
}

export function subscribeAccount(cb: () => void): () => void {
  window.addEventListener(ACCOUNT_EVENT, cb);
  return () => window.removeEventListener(ACCOUNT_EVENT, cb);
}

const SERVER_STATE: AccountState = { status: "loading", account: null };
export function getServerAccountState(): AccountState {
  return SERVER_STATE;
}

function hasHintCookie(): boolean {
  return document.cookie.split(/;\s*/).some((c) => c === `${HINT_COOKIE}=1`);
}

async function api(path: string, init?: RequestInit): Promise<{ account?: Account } | null> {
  const res = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (res.status === 401) {
    setState({ status: "signed_out", account: null });
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { account?: Account };
}

/** Reads `?signed_in=<method>` left by the sign-in redirect, counts it, and tidies the URL. */
function consumeSignedInFlag(): void {
  const url = new URL(window.location.href);
  const method = url.searchParams.get("signed_in");
  if (!method) return;
  trackEvent("sign_in_complete", { method });
  url.searchParams.delete("signed_in");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/** Loads the account once per page load; signed-out visitors make no request. */
export function startAccount(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  consumeSignedInFlag();
  if (!hasHintCookie()) {
    setState({ status: "signed_out", account: null });
    return;
  }
  void (async () => {
    try {
      const data = await api("/api/account");
      if (!data?.account) return;
      let account = data.account;
      // What to add: a pre-account list on its first sign-in here, and the
      // follow that sent the reader to sign in.
      const add = takePendingFollow();
      if (storageGet(OWNER_KEY) !== account.email) {
        const local = readWatchlist();
        add.members.push(...local.members);
        add.tickers.push(...local.tickers);
        storageSet(OWNER_KEY, account.email);
      }
      const members = [...new Set(add.members)].filter((m) => !account.members.includes(m));
      const tickers = [...new Set(add.tickers)].filter((t) => !account.tickers.includes(t));
      if (members.length || tickers.length) {
        const merged = await api("/api/account/watch", {
          method: "POST",
          body: JSON.stringify({ add: { members, tickers } }),
        });
        if (merged?.account) account = merged.account;
      }
      mirror(account);
      setState({ status: "signed_in", account });
      const pending = queued;
      queued = [];
      pending.forEach(pushWatchChange);
    } catch {
      // The account could not be read (network, store outage): keep working
      // from this device's list rather than claiming the reader signed out.
      setState({ status: "signed_out", account: null });
    }
  })();
}

function takePendingFollow(): { members: string[]; tickers: string[] } {
  const raw = storageGet(PENDING_KEY);
  storageSet(PENDING_KEY, null);
  try {
    const p = raw ? (JSON.parse(raw) as { members?: unknown; tickers?: unknown; at?: unknown }) : null;
    if (!p || typeof p.at !== "number" || Date.now() - p.at > PENDING_TTL_MS) return { members: [], tickers: [] };
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { members: strings(p.members), tickers: strings(p.tickers) };
  } catch {
    return { members: [], tickers: [] };
  }
}

/**
 * A follow asked for while signed out: remembered, then the reader goes to
 * sign in and comes back here, where `startAccount` applies it.
 */
export function followAfterSignIn(add: { members?: string[]; tickers?: string[] }, from: string): void {
  storageSet(PENDING_KEY, JSON.stringify({ members: add.members ?? [], tickers: add.tickers ?? [], at: Date.now() }));
  trackEvent("sign_in_start", { from });
  window.location.assign(signInHref());
}

/** Sends a follow change to the account when signed in; a no-op signed out. */
export function pushWatchChange(change: WatchChange): void {
  if (state.status === "loading") {
    queued.push(change);
    return;
  }
  if (state.status !== "signed_in") return;
  void api("/api/account/watch", { method: "POST", body: JSON.stringify(change) })
    .then((data) => {
      if (data?.account) {
        mirror(data.account);
        setState({ status: "signed_in", account: data.account });
      }
    })
    .catch(() => {
      /* the local change stands; the next page load re-reads the account */
    });
}

/** A follow change the caller waits for (the dashboard re-renders after it). */
export async function changeFollows(change: WatchChange): Promise<boolean> {
  if (state.status !== "signed_in") return false;
  try {
    const data = await api("/api/account/watch", { method: "POST", body: JSON.stringify(change) });
    if (!data?.account) return false;
    mirror(data.account);
    setState({ status: "signed_in", account: data.account });
    return true;
  } catch {
    return false;
  }
}

export async function saveAccountSettings(
  settings: Partial<Pick<Account, "emailAlerts" | "clusters" | "weeklyDigest">>
): Promise<boolean> {
  if (state.status !== "signed_in") return false;
  // Shown at once and put back if the save fails, so a checkbox answers the click.
  const before = state.account;
  setState({ status: "signed_in", account: { ...before, ...settings } });
  try {
    const data = await api("/api/account", { method: "POST", body: JSON.stringify(settings) });
    if (!data?.account) return false;
    setState({ status: "signed_in", account: data.account });
    return true;
  } catch {
    setState({ status: "signed_in", account: before });
    return false;
  }
}

function forget(): void {
  queued = [];
  storageSet(OWNER_KEY, null);
  writeWatchlist(EMPTY_WATCHLIST);
  setState({ status: "signed_out", account: null });
}

export async function signOut(): Promise<void> {
  await fetch("/api/auth/signout", { method: "POST", cache: "no-store" }).catch(() => null);
  trackEvent("sign_out");
  forget();
}

export async function deleteAccount(): Promise<boolean> {
  const res = await fetch("/api/account", { method: "DELETE", cache: "no-store" }).catch(() => null);
  if (!res?.ok) return false;
  trackEvent("account_deleted");
  forget();
  return true;
}

/** `/signin?next=<this page>`, for a "Sign in" link anywhere on the site. */
export function signInHref(): string {
  if (typeof window === "undefined") return "/signin";
  const here = `${window.location.pathname}${window.location.search}`;
  return here === "/" || here.startsWith("/signin") ? "/signin" : `/signin?next=${encodeURIComponent(here)}`;
}
