"use client";

import React, { useEffect, useState } from "react";
import { Check, LogOut, Mail, Trash2, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";
import { BUTTON, BUTTON_PRIMARY, FIELD } from "./ui";
import { Card, SectionTitle } from "./charts";
import { ICON_BUTTON } from "./nav";
import { useAccount } from "./watchlist-client";
import { deleteAccount, saveAccountSettings, signInHref, signOut, type Account } from "./account-store";

/**
 * Masthead account control: a person icon to /signin when signed out, the
 * account's initial to /watchlist when signed in. Rendered after hydration
 * only (pages are CDN-cached and identical for everyone); until then it holds
 * its place so the toolbar does not shift.
 */
export function HeaderAccountButton() {
  const account = useAccount();
  const [href, setHref] = useState("/signin");
  useEffect(() => setHref(signInHref()), []);

  if (account.status === "signed_in") {
    const initial = account.account.email.charAt(0).toUpperCase();
    return (
      <a
        href="/watchlist"
        className={ICON_BUTTON}
        aria-label={`Your account (${account.account.email})`}
        title={account.account.email}
        onClick={() => trackEvent("header_account_click", { signed_in: true })}
      >
        <span className="flex size-6.5 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
          {initial}
        </span>
      </a>
    );
  }
  return (
    <a
      href={href}
      className={cn(ICON_BUTTON, account.status === "loading" && "opacity-0")}
      aria-label="Sign in"
      title="Sign in"
      onClick={() => trackEvent("header_account_click", { signed_in: false })}
    >
      <UserRound className="size-4" aria-hidden />
    </a>
  );
}

const ERRORS: Record<string, string> = {
  expired: "That sign-in has expired. Please try again.",
  cancelled: "Google sign-in was cancelled.",
  failed: "Sign-in did not complete. Please try again.",
  unavailable: "Sign-in is not configured on this deployment.",
  google_unavailable: "Google sign-in is not configured on this deployment. Use the email link instead.",
};

/** The `/signin` form: Google, or a link by email. */
export function SignInPanel({
  next,
  error,
  googleEnabled,
  emailEnabled,
}: {
  next: string;
  error: string | null;
  googleEnabled: boolean;
  emailEnabled: boolean;
}) {
  const account = useAccount();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(
    error ? { tone: "err", text: ERRORS[error] ?? ERRORS.failed } : null
  );
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (account.status === "signed_in") {
    return (
      <Card className="space-y-4">
        <p className="text-[15px] text-foreground">
          You are signed in as <strong className="font-semibold">{account.account.email}</strong>.
        </p>
        <div className="flex flex-wrap gap-2">
          <a href={next} className={BUTTON_PRIMARY}>
            Continue
          </a>
          <a href="/watchlist" className={BUTTON}>
            Account &amp; watchlist
          </a>
        </div>
      </Card>
    );
  }

  const sendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setNotice(null);
    trackEvent("sign_in_start", { method: "email" });
    try {
      const res = await fetch("/api/auth/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setSentTo(email.trim());
      } else {
        setNotice({ tone: "err", text: data.error ?? "Could not send the sign-in email." });
      }
    } catch {
      setNotice({ tone: "err", text: "Network error while sending the sign-in email." });
    } finally {
      setSending(false);
    }
  };

  if (sentTo) {
    return (
      <Card className="space-y-3">
        <p className="flex items-center gap-2 text-[17px] font-semibold tracking-[-0.015em] text-foreground">
          <Mail className="size-4.5" aria-hidden />
          Check your inbox
        </p>
        <p className="text-[14px] leading-relaxed text-ink-2">
          We sent a sign-in link to <strong className="font-semibold text-foreground">{sentTo}</strong>. It expires
          in 15 minutes. Open it on any device; you will be signed in there.
        </p>
        <button type="button" onClick={() => setSentTo(null)} className={cn(BUTTON, "h-8 text-[12.5px]")}>
          Use a different address
        </button>
      </Card>
    );
  }

  return (
    <Card className="space-y-5">
      {notice ? (
        <p role="status" className="rounded-[14px] bg-fill/65 px-3.5 py-2.5 text-[13.5px] font-medium text-foreground">
          {notice.text}
        </p>
      ) : null}

      {googleEnabled ? (
        <a
          href={`/api/auth/google${next !== "/watchlist" ? `?next=${encodeURIComponent(next)}` : ""}`}
          onClick={() => trackEvent("sign_in_start", { method: "google" })}
          className={cn(BUTTON, "h-11 w-full text-[15px]")}
        >
          <GoogleG />
          Continue with Google
        </a>
      ) : null}

      {googleEnabled && emailEnabled ? (
        <div className="flex items-center gap-3 text-[12px] uppercase tracking-[0.06em] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}

      {emailEnabled ? (
        <form onSubmit={sendLink} className="space-y-3">
          <label className="block pl-1 text-[13px] font-medium text-muted-foreground">
            Email address
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={cn(FIELD, "mt-1.5 h-11 text-[15px]")}
            />
          </label>
          <button type="submit" disabled={sending} className={cn(BUTTON_PRIMARY, "h-11 w-full text-[15px]")}>
            <Mail className="size-4" aria-hidden />
            {sending ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      ) : null}

      {!googleEnabled && !emailEnabled ? (
        <p className="text-[14px] text-ink-2">Sign-in is not configured on this deployment.</p>
      ) : null}

      <p className="border-t border-border/70 pt-4 text-[12.5px] leading-relaxed text-muted-foreground">
        No password. Your account is your email address: we keep what you follow and email you a daily digest
        when it files new trades (at most one a day; turn it off anytime). See{" "}
        <a href="/privacy" className="ink-link">
          privacy
        </a>
        .
      </p>
    </Card>
  );
}

/** Google's "G", in its own colours as its branding guidelines require. */
function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" className="size-4.5" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/**
 * `/watchlist`'s account section: who is signed in, the email settings
 * (saved as they change), sign out and delete. Signed out, an invitation to
 * sign in instead.
 */
export function AccountPanel({ emailEnabled }: { emailEnabled: boolean }) {
  const account = useAccount();
  const [href, setHref] = useState("/signin");
  useEffect(() => setHref(signInHref()), []);

  if (account.status === "loading") {
    return (
      <Card className="space-y-4">
        <p className="text-[14px] text-muted-foreground">Checking your account…</p>
      </Card>
    );
  }

  if (account.status === "signed_out") {
    return (
      <Card className="space-y-4">
        <p className="text-[14px] leading-relaxed text-ink-2">
          Sign in to keep your watchlist on every device and get a daily email when anything you follow files a new
          STOCK Act report or SEC Form 4, or a cluster forms. No password: Google, or a link by email.
        </p>
        <a href={href} onClick={() => trackEvent("sign_in_start", { from: "watchlist_page" })} className={BUTTON_PRIMARY}>
          <UserRound className="size-3.5" aria-hidden />
          Sign in
        </a>
        {!emailEnabled ? (
          <p className="text-[12px] text-muted-foreground">
            Email digests are not configured on this deployment; signing in still syncs your watchlist.
          </p>
        ) : null}
      </Card>
    );
  }

  return <SignedInPanel account={account.account} />;
}

function SignedInPanel({ account }: { account: Account }) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (key: "emailAlerts" | "clusters" | "weeklyDigest", on: boolean) => {
    setSaving(true);
    setNotice(null);
    const ok = await saveAccountSettings({ [key]: on });
    setSaving(false);
    setNotice(ok ? "Saved." : "Could not save that change. Please try again.");
    trackEvent(key === "emailAlerts" ? "email_alerts_toggle" : "account_setting_toggle", {
      setting: key,
      on,
      from: "watchlist_page",
      ok,
    });
  };

  const onDelete = async () => {
    setSaving(true);
    const ok = await deleteAccount();
    setSaving(false);
    if (!ok) setNotice("Could not delete the account. Please try again.");
  };

  const followed = account.members.length + account.tickers.length;

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-[15px] font-semibold text-primary-foreground">
            {account.email.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-foreground">{account.email}</p>
            <p className="text-[12.5px] text-muted-foreground">
              Following {followed} · synced to this account
            </p>
          </div>
        </div>
        <button type="button" onClick={() => void signOut()} className={cn(BUTTON, "h-8 text-[12.5px]")}>
          <LogOut className="size-3.5" aria-hidden />
          Sign out
        </button>
      </div>

      <div className="space-y-2.5 border-t border-border/70 pt-4 text-[14px]">
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={account.emailAlerts}
            disabled={saving}
            onChange={(e) => save("emailAlerts", e.target.checked)}
            className="mt-1 size-4 accent-foreground"
          />
          <span>
            <strong className="font-semibold">Daily email digest</strong> — at most one email a day when a member or
            ticker you follow files new trades
          </span>
        </label>
        <label className={cn("flex cursor-pointer items-start gap-2.5", !account.emailAlerts && "opacity-50")}>
          <input
            type="checkbox"
            checked={account.clusters}
            disabled={saving || !account.emailAlerts}
            onChange={(e) => save("clusters", e.target.checked)}
            className="mt-1 size-4 accent-foreground"
          />
          <span>
            <strong className="font-semibold">Cluster alerts</strong> — several members of Congress or corporate
            insiders trading the same ticker in one direction
          </span>
        </label>
        <label className={cn("flex cursor-pointer items-start gap-2.5", !account.emailAlerts && "opacity-50")}>
          <input
            type="checkbox"
            checked={account.weeklyDigest}
            disabled={saving || !account.emailAlerts}
            onChange={(e) => save("weeklyDigest", e.target.checked)}
            className="mt-1 size-4 accent-foreground"
          />
          <span>
            <strong className="font-semibold">Weekly roundup</strong> — a summary of the week&apos;s clusters
          </span>
        </label>
        {notice ? (
          <p role="status" className="flex items-center gap-1.5 pl-6.5 text-[12.5px] text-muted-foreground">
            <Check className="size-3.5" aria-hidden />
            {notice}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
        {confirmDelete ? (
          <>
            <span className="text-[13px] text-ink-2">Delete the account and everything it follows?</span>
            <button type="button" disabled={saving} onClick={onDelete} className={cn(BUTTON_PRIMARY, "h-8 text-[12.5px]")}>
              Delete
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className={cn(BUTTON, "h-8 text-[12.5px]")}>
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className={cn(BUTTON, "h-8 text-[12.5px] text-ink-2")}
          >
            <Trash2 className="size-3.5" aria-hidden />
            Delete account
          </button>
        )}
      </div>
    </Card>
  );
}
