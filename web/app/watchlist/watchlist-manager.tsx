"use client";

import React, { useEffect, useState } from "react";
import { Bell, Check, Mail, Plus, Sparkles, Star, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";
import { BUTTON, BUTTON_PRIMARY, FIELD } from "../ui";
import { Card, SectionTitle } from "../charts";
import { useAccount, useWatchlist } from "../watchlist-client";
import { AccountPanel } from "../account-client";
import { isBioguideId, isWatchTicker, watchlistFeedHref } from "@/lib/watchlist";

export interface ManagedSubscriptionProps {
  email: string;
  verified: boolean;
  members: string[];
  tickers: string[];
  clusters: boolean;
  weeklyDigest: boolean;
}

export function WatchlistManager({
  token,
  initialSub,
  statusCode,
  statusNotice,
  emailEnabled,
}: {
  token?: string;
  initialSub?: ManagedSubscriptionProps | null;
  statusCode?: string | null;
  statusNotice?: string | null;
  emailEnabled: boolean;
}) {
  const { state, mounted, toggle, clear } = useWatchlist();
  const signedIn = useAccount().status === "signed_in";
  const [addInput, setAddInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    if (statusCode === "verified") {
      trackEvent("alert_email_verified");
    } else if (statusCode === "unsubscribed") {
      trackEvent("alert_unsubscribed", { source: "email_link" });
    }
  }, [statusCode]);

  // Preferences opened from an email link (`?token=`)
  const [subMembers, setSubMembers] = useState<string[]>(initialSub?.members ?? []);
  const [subTickers, setSubTickers] = useState<string[]>(initialSub?.tickers ?? []);
  const [clusters, setClusters] = useState(initialSub?.clusters ?? true);
  const [weeklyDigest, setWeeklyDigest] = useState(initialSub?.weeklyDigest ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(
    statusNotice ? { tone: "ok", text: statusNotice } : null
  );

  const handleAddLocal = (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    const raw = addInput.trim().toUpperCase();
    if (!raw) return;
    if (isBioguideId(raw)) {
      if (!state.members.includes(raw)) toggle({ kind: "member", id: raw });
      setAddInput("");
      return;
    }
    if (isWatchTicker(raw)) {
      if (!state.tickers.includes(raw)) toggle({ kind: "ticker", id: raw });
      setAddInput("");
      return;
    }
    setAddError("Enter a stock ticker (e.g. NVDA, BRK.B) or a Bioguide ID (e.g. P000197).");
  };

  const handleSaveTokenPreferences = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/alerts/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          members: subMembers,
          tickers: subTickers,
          clusters,
          weeklyDigest,
          // Saving the digest's settings is asking for the digest, so it
          // undoes an earlier unsubscribe link.
          emailAlerts: true,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setFeedback({ tone: "err", text: data.error ?? "Could not save preferences." });
      } else {
        trackEvent("alert_preferences_saved", {
          members: subMembers.length,
          tickers: subTickers.length,
          clusters,
          weeklyDigest,
        });
        setFeedback({ tone: "ok", text: "Your daily email alert preferences have been saved." });
      }
    } catch {
      setFeedback({ tone: "err", text: "Network error while saving preferences." });
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnsubscribeToken = async () => {
    if (!token) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/alerts/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, unsubscribeAll: true }),
      });
      if (res.ok) {
        trackEvent("alert_unsubscribed");
        setSubMembers([]);
        setSubTickers([]);
        setClusters(false);
        setWeeklyDigest(false);
        setFeedback({ tone: "ok", text: "You have been unsubscribed from all email alerts." });
      } else {
        setFeedback({ tone: "err", text: "Could not unsubscribe." });
      }
    } catch {
      setFeedback({ tone: "err", text: "Network error while unsubscribing." });
    } finally {
      setSubmitting(false);
    }
  };

  const totalLocal = mounted ? state.members.length + state.tickers.length : 0;
  const feedHref = watchlistFeedHref(state);

  return (
    <div className="space-y-10">
      {feedback ? (
        <div
          role="status"
          className={cn(
            "rounded-[18px] px-4 py-3 text-[14px] font-medium ring-1",
            feedback.tone === "ok"
              ? "bg-card text-foreground ring-black/[0.08] dark:ring-white/[0.12]"
              : "bg-card text-foreground ring-border-strong"
          )}
        >
          {feedback.text}
        </div>
      ) : null}

      {initialSub && token ? (
        <section>
          <SectionTitle
            kicker="Verified Email Preferences"
            right={<span className="text-muted-foreground">{initialSub.email}</span>}
          >
            Manage daily email digest
          </SectionTitle>
          <Card className="space-y-5">
            <p className="text-[14px] leading-relaxed text-ink-2">
              We send at most one combined daily email when new congressional STOCK Act filings, SEC Form 4 insider filings, or high-signal clusters match your selections.
            </p>
            <form onSubmit={handleSaveTokenPreferences} className="space-y-5">
              <div>
                <p className="text-[13px] font-semibold text-foreground">Followed Members ({subMembers.length})</p>
                {subMembers.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {subMembers.map((m) => (
                      <span
                        key={m}
                        className="inline-flex items-center gap-1.5 rounded-full bg-fill px-3 py-1 text-[13px] font-medium text-foreground"
                      >
                        <span>{m}</span>
                        <button
                          type="button"
                          onClick={() => setSubMembers((prev) => prev.filter((x) => x !== m))}
                          aria-label={`Remove ${m}`}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="size-3.5" aria-hidden />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[13px] text-muted-foreground">No specific members selected.</p>
                )}
              </div>

              <div>
                <p className="text-[13px] font-semibold text-foreground">
                  Followed Tickers ({subTickers.length}) — Congress &amp; SEC Form 4
                </p>
                {subTickers.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {subTickers.map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-1.5 rounded-full bg-fill px-3 py-1 font-mono text-[13px] font-semibold text-foreground"
                      >
                        <span>{t}</span>
                        <button
                          type="button"
                          onClick={() => setSubTickers((prev) => prev.filter((x) => x !== t))}
                          aria-label={`Remove ${t}`}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="size-3.5" aria-hidden />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[13px] text-muted-foreground">No specific tickers selected.</p>
                )}
              </div>

              <div className="space-y-2.5 border-t border-border/70 pt-4">
                <label className="flex cursor-pointer items-center gap-2.5 text-[14px]">
                  <input
                    type="checkbox"
                    checked={clusters}
                    onChange={(e) => setClusters(e.target.checked)}
                    className="size-4 accent-foreground"
                  />
                  <span>
                    <strong className="font-semibold">High-signal cluster alerts</strong> — 2+ members of Congress or 3+ corporate insiders trading the same ticker in one direction
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-2.5 text-[14px]">
                  <input
                    type="checkbox"
                    checked={weeklyDigest}
                    onChange={(e) => setWeeklyDigest(e.target.checked)}
                    className="size-4 accent-foreground"
                  />
                  <span>
                    <strong className="font-semibold">Weekly roundup</strong> — summary of top bipartisan consensus and insider clusters
                  </span>
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleUnsubscribeToken}
                  className={cn(BUTTON, "text-ink-2")}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  Unsubscribe from all emails
                </button>
                <button type="submit" disabled={submitting} className={BUTTON_PRIMARY}>
                  <Check className="size-3.5" aria-hidden />
                  {submitting ? "Saving…" : "Save preferences"}
                </button>
              </div>
            </form>
          </Card>
        </section>
      ) : null}

      <section className="grid gap-8 lg:grid-cols-2 lg:gap-5">
        <div className="flex flex-col [&>:last-child]:flex-1">
          <SectionTitle
            kicker={signedIn ? "Synced Watchlist" : "On-Device Watchlist"}
            right={
              totalLocal > 0 ? (
                <a href={feedHref} className="ink-link text-[13px]">
                  Open Following feed →
                </a>
              ) : undefined
            }
          >
            Followed politicians &amp; stocks
          </SectionTitle>
          <Card className="space-y-5">
            <p className="text-[14px] leading-relaxed text-ink-2">
              Follow any member of Congress or stock symbol across the site with the <strong>★ Follow</strong> button, or add a ticker / Bioguide ID directly below.
            </p>

            <form onSubmit={handleAddLocal} className="flex items-center gap-2">
              <input
                type="text"
                value={addInput}
                onChange={(e) => setAddInput(e.target.value)}
                placeholder="Ticker (e.g. NVDA) or Bioguide ID (e.g. P000197)"
                aria-label="Add ticker or Bioguide ID to watchlist"
                className={FIELD}
              />
              <button type="submit" className={BUTTON_PRIMARY}>
                <Plus className="size-3.5" aria-hidden />
                Add
              </button>
            </form>
            {addError ? <p className="text-[12.5px] text-ink-2">{addError}</p> : null}

            {mounted && totalLocal > 0 ? (
              <div className="space-y-4 pt-1">
                {state.members.length > 0 ? (
                  <div>
                    <p className="text-[12px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                      Members ({state.members.length})
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {state.members.map((m) => (
                        <span
                          key={m}
                          className="inline-flex items-center gap-1.5 rounded-full bg-fill px-3 py-1 text-[13px] font-medium text-foreground"
                        >
                          <span>{state.labels[m] ? `${state.labels[m]} (${m})` : m}</span>
                          <button
                            type="button"
                            onClick={() => toggle({ kind: "member", id: m })}
                            aria-label={`Unfollow ${m}`}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <X className="size-3.5" aria-hidden />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {state.tickers.length > 0 ? (
                  <div>
                    <p className="text-[12px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                      Tickers ({state.tickers.length})
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {state.tickers.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-1.5 rounded-full bg-fill px-3 py-1 font-mono text-[13px] font-semibold text-foreground"
                        >
                          <a href={`/tickers/${encodeURIComponent(t)}`} className="hover:underline">
                            {t}
                          </a>
                          <button
                            type="button"
                            onClick={() => toggle({ kind: "ticker", id: t })}
                            aria-label={`Unfollow ${t}`}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <X className="size-3.5" aria-hidden />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-4">
                  <button type="button" onClick={clear} className={cn(BUTTON, "h-8 px-3 text-[12.5px]")}>
                    Clear watchlist
                  </button>
                  <a href={feedHref} className={cn(BUTTON_PRIMARY, "h-8 px-4 text-[13px]")}>
                    <Star className="size-3.5 fill-current" aria-hidden />
                    View Following feed ({totalLocal})
                  </a>
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                {signedIn ? "Your watchlist is empty." : "Your watchlist on this device is empty."} Follow members on <a href="/politicians" className="ink-link">/politicians</a> or stocks on <a href="/tickers" className="ink-link">/tickers</a>.
              </p>
            )}
          </Card>
        </div>

        <div className="flex flex-col [&>:last-child]:flex-1">
          <SectionTitle
            kicker="Account & Email Digest"
            right={<span className="text-muted-foreground">At most 1 email / day</span>}
          >
            Your account
          </SectionTitle>
          <AccountPanel emailEnabled={emailEnabled} />
        </div>
      </section>
    </div>
  );
}
