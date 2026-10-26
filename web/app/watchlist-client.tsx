"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Bookmark, Check, ExternalLink, Mail, Sparkles, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";
import { BUTTON, BUTTON_PRIMARY, FIELD, FOCUS_RING } from "./ui";
import {
  EMPTY_WATCHLIST,
  WATCHLIST_STORAGE_KEY,
  sanitizeWatchlistState,
  serializeWatchParam,
  toggleWatchItem,
  watchCount,
  watchlistFeedHref,
  type WatchlistState,
} from "@/lib/watchlist";

const WATCHLIST_EVENT = "fatcat:watchlist-change";

function readWatchlist(): WatchlistState {
  if (typeof window === "undefined") return EMPTY_WATCHLIST;
  try {
    const raw = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return EMPTY_WATCHLIST;
    return sanitizeWatchlistState(JSON.parse(raw));
  } catch {
    return EMPTY_WATCHLIST;
  }
}

function writeWatchlist(next: WatchlistState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(WATCHLIST_EVENT));
  } catch {
    /* localStorage unavailable or quota exceeded */
  }
}

export function useWatchlist() {
  const [state, setState] = useState<WatchlistState>(EMPTY_WATCHLIST);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setState(readWatchlist());
    const sync = () => setState(readWatchlist());
    window.addEventListener(WATCHLIST_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(WATCHLIST_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const toggle = useCallback((item: { kind: "member" | "ticker" | "insider"; id: string; label?: string }) => {
    const current = readWatchlist();
    const { next, followed } = toggleWatchItem(current, item);
    writeWatchlist(next);
    setState(next);
    trackEvent("watchlist_toggle", {
      kind: item.kind,
      id: item.kind === "insider" ? item.id.trim() : item.id.toUpperCase(),
      followed,
      total: watchCount(next),
    });
    return followed;
  }, []);

  const clear = useCallback(() => {
    writeWatchlist(EMPTY_WATCHLIST);
    setState(EMPTY_WATCHLIST);
    trackEvent("watchlist_clear");
  }, []);

  return { state, mounted, toggle, clear };
}

/**
 * Tactile Apple capsule button (`★ Follow` / `✓ Following`) mounted on
 * MemberHero, SymbolHero, and Insider issuer/filer headers.
 */
export function FollowButton({
  kind,
  id,
  label,
  className,
}: {
  kind: "member" | "ticker" | "insider";
  id: string;
  label?: string;
  className?: string;
}) {
  const { state, mounted, toggle } = useWatchlist();
  const normId = kind === "insider" ? id.trim() : id.trim().toUpperCase();
  const isFollowed =
    mounted &&
    (kind === "member"
      ? state.members.includes(normId)
      : kind === "insider"
        ? (state.insiders ?? []).includes(normId)
        : state.tickers.includes(normId));

  return (
    <button
      type="button"
      data-follow-kind={kind}
      data-follow-id={normId}
      aria-pressed={isFollowed}
      onClick={() => toggle({ kind, id: normId, label })}
      className={cn(
        isFollowed ? BUTTON_PRIMARY : BUTTON,
        "h-8 px-3.5 text-[13px]",
        className
      )}
      title={
        isFollowed
          ? `Following ${label ?? normId} in your watchlist — click to unfollow`
          : `Follow ${label ?? normId} to filter your feed and alerts`
      }
    >
      {isFollowed ? (
        <>
          <Check className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden />
          <span>Following</span>
        </>
      ) : (
        <>
          <Star className="size-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
          <span>Follow</span>
        </>
      )}
    </button>
  );
}

/**
 * Apple popover button (`Get Alerts`) for subscribing to a politician,
 * insider, ticker, or high-signal cluster alerts via Watchlist, Email, or Atom feed.
 */
export function GetAlertsPopover({
  subject,
  className,
}: {
  subject?: { kind: "member" | "ticker" | "insider"; id: string; label: string };
  className?: string;
}) {
  const { state, mounted, toggle } = useWatchlist();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [clusters, setClusters] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const normId = subject
    ? subject.kind === "insider"
      ? subject.id.trim()
      : subject.id.trim().toUpperCase()
    : undefined;
  const isFollowed =
    mounted &&
    normId != null &&
    (subject?.kind === "member"
      ? state.members.includes(normId)
      : subject?.kind === "insider"
        ? (state.insiders ?? []).includes(normId)
        : state.tickers.includes(normId));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const totalWatched = watchCount(state);
  const feedUrl = watchlistFeedHref(state);

  const handleEmailSubscribe = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setNotice(null);
    const members = [...state.members];
    const tickers = [...state.tickers];
    const insiders = [...(state.insiders ?? [])];
    if (subject && normId) {
      if (subject.kind === "member" && !members.includes(normId)) members.push(normId);
      if (subject.kind === "ticker" && !tickers.includes(normId)) tickers.push(normId);
      if (subject.kind === "insider" && !insiders.includes(normId)) insiders.push(normId);
      if (!isFollowed) toggle({ kind: subject.kind, id: normId, label: subject.label });
    }
    try {
      const res = await fetch("/api/alerts/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          members,
          tickers,
          insiders,
          clusters,
        }),
      });
      const data = (await res.json()) as {
        message?: string;
        error?: string;
        status?: string;
        code?: string;
      };
      trackEvent("alert_email_subscribed", {
        from: normId ?? "global",
        status: res.ok ? (data.status ?? "ok") : (data.code ?? "error"),
        members: members.length,
        tickers: tickers.length,
        insiders: insiders.length,
        clusters,
      });
      if (res.ok) {
        setNotice(data.message ?? "Check your inbox to confirm your daily alert subscription.");
        setEmail("");
      } else {
        setNotice(data.error ?? "Saved to your device watchlist.");
      }
    } catch {
      trackEvent("alert_email_subscribed", {
        from: normId ?? "global",
        status: "network_error",
        members: members.length,
        tickers: tickers.length,
        insiders: insiders.length,
        clusters,
      });
      setNotice("Saved to your device watchlist.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div ref={wrapRef} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) {
            trackEvent("alerts_popover_open", {
              subject_kind: subject?.kind ?? "global",
              subject_id: normId ?? "all",
            });
          }
        }}
        className={cn(BUTTON, "h-8 px-3.5 text-[13px]")}
      >
        <Bell className="size-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
        <span>Alerts</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Alert and watchlist options"
          className="absolute right-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-[20px] border border-black/[0.08] bg-popover/95 p-4 text-left text-popover-foreground shadow-popover backdrop-blur-2xl dark:border-white/[0.12]"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                Watchlist &amp; Alerts
              </p>
              <p className="mt-0.5 text-[14px] font-semibold tracking-[-0.015em] text-foreground">
                {subject ? `Track ${subject.label}` : "Track politicians, insiders & stocks"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close alerts menu"
              className="flex size-6 items-center justify-center rounded-full bg-fill text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>

          <div className="mt-3 space-y-2.5 text-[13px]">
            {subject && normId ? (
              <div className="rounded-[14px] bg-fill/65 p-3 ring-1 ring-black/[0.04] dark:ring-white/[0.07]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {isFollowed ? `Following ${subject.label}` : `Follow ${subject.label}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle({ kind: subject.kind, id: normId, label: subject.label })}
                    className={cn(isFollowed ? BUTTON : BUTTON_PRIMARY, "h-7 px-3 text-[12px]")}
                  >
                    {isFollowed ? "Unfollow" : "Follow"}
                  </button>
                </div>
                <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
                  Pins {subject.label} to your personal Following feed on this device.
                </p>
              </div>
            ) : null}

            <form
              onSubmit={handleEmailSubscribe}
              className="rounded-[14px] bg-fill/65 p-3 ring-1 ring-black/[0.04] dark:ring-white/[0.07]"
            >
              <p className="font-medium text-foreground">Daily Email Digest</p>
              <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                At most 1 email/day when{" "}
                {subject ? `${subject.label} or your watchlist` : "your watchlist"} files new trades.
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  aria-label="Email address for daily digest alerts"
                  className={cn(FIELD, "h-8 text-[12.5px]")}
                />
                <button
                  type="submit"
                  disabled={submitting}
                  className={cn(BUTTON_PRIMARY, "h-8 px-3 text-[12px]")}
                >
                  <Mail className="size-3" aria-hidden />
                  <span>{submitting ? "…" : "Subscribe"}</span>
                </button>
              </div>
              <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-2">
                <input
                  type="checkbox"
                  checked={clusters}
                  onChange={(e) => setClusters(e.target.checked)}
                  className="size-3.5 accent-foreground"
                />
                <span>Also include high-signal cluster alerts</span>
              </label>
              {notice ? <p className="mt-2 text-[12px] font-medium text-foreground">{notice}</p> : null}
            </form>

            <div className="flex items-center justify-between border-t border-border/60 pt-2.5 text-[12px]">
              <a
                href="/watchlist"
                onClick={() => setOpen(false)}
                className="font-semibold text-foreground underline decoration-border-strong underline-offset-[3px]"
              >
                Manage watchlist {totalWatched > 0 ? `(${totalWatched})` : ""}
              </a>
              <a
                href={totalWatched > 0 ? feedUrl : "/alerts"}
                onClick={() => {
                  trackEvent("alerts_log_click", { from: normId ?? "global" });
                  setOpen(false);
                }}
                className="inline-flex items-center gap-1 font-medium text-ink-2 hover:text-foreground"
              >
                {totalWatched > 0 ? "Following feed →" : "Alert log"}
                {totalWatched === 0 ? <ExternalLink className="size-3" aria-hidden /> : null}
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Header Watchlist badge (`★ N`) shown in the masthead toolbar once the
 * visitor follows at least one politician, insider, or stock.
 */
export function HeaderWatchlistPill() {
  const { state, mounted } = useWatchlist();
  if (!mounted) return null;
  const count = watchCount(state);
  if (count === 0) return null;

  const href = watchlistFeedHref(state);
  return (
    <a
      href={href}
      onClick={() => trackEvent("header_watchlist_click", { count })}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-fill/85 px-3 text-[12.5px] font-semibold text-foreground ring-1 ring-black/[0.05] transition-colors hover:bg-foreground/[0.1] dark:ring-white/[0.08]",
        FOCUS_RING
      )}
      title={`View feed for your ${count} followed item${count === 1 ? "" : "s"}`}
      aria-label={`Watchlist (${count} followed)`}
    >
      <Star className="size-3.5 fill-current" aria-hidden />
      <span className="tabular">{count}</span>
    </a>
  );
}

/**
 * Toolbar toggle on the homepage feed (`★ Following (N)`) + active watchlist
 * management banner when `?watch=...` is present in the URL.
 */
export function FeedWatchlistToggle({
  activeWatch,
  allHref,
}: {
  activeWatch?: { members: string[]; tickers: string[]; insiders?: string[] };
  allHref: string;
}) {
  const { state, mounted } = useWatchlist();
  const isFiltered = Boolean(activeWatch && watchCount(activeWatch) > 0);
  const localCount = mounted ? watchCount(state) : 0;

  if (!isFiltered && localCount === 0) {
    return null;
  }

  const targetHref = isFiltered ? allHref : watchlistFeedHref(state);
  const count = isFiltered && activeWatch ? watchCount(activeWatch) : localCount;

  return (
    <a
      href={targetHref}
      aria-current={isFiltered ? "page" : undefined}
      onClick={() =>
        trackEvent("feed_watchlist_filter", {
          active: !isFiltered,
          count,
        })
      }
      className={cn(
        isFiltered ? BUTTON_PRIMARY : BUTTON,
        "h-8 px-3.5 text-[13px]"
      )}
      title={isFiltered ? "Showing only your watchlist — click to show all trades" : "Filter feed to your followed politicians, insiders, and tickers"}
    >
      <Star className={cn("size-3.5 shrink-0", isFiltered && "fill-current")} strokeWidth={2.2} aria-hidden />
      <span>Following</span>
      <span className="tabular opacity-80">({count})</span>
    </a>
  );
}

/**
 * Active watchlist banner shown above the feed when `?watch=...` is active,
 * allowing one-click removal of items or saving a shared watchlist URL to localStorage.
 */
export function ActiveWatchlistBanner({
  activeWatch,
  clearHref,
}: {
  activeWatch?: { members: string[]; tickers: string[]; insiders?: string[] };
  clearHref: string;
}) {
  const { state, mounted, toggle } = useWatchlist();
  if (!activeWatch || watchCount(activeWatch) === 0) {
    return null;
  }

  const insiders = activeWatch.insiders ?? [];
  const tokens = [...activeWatch.members, ...insiders, ...activeWatch.tickers];
  const localParam = mounted ? serializeWatchParam(state) : "";
  const urlParam = serializeWatchParam(activeWatch);
  const isUnsavedShared = mounted && urlParam !== localParam;

  const saveSharedToLocal = () => {
    const mergedMembers = Array.from(new Set([...state.members, ...activeWatch.members]));
    const mergedTickers = Array.from(new Set([...state.tickers, ...activeWatch.tickers]));
    const mergedInsiders = Array.from(new Set([...(state.insiders ?? []), ...insiders]));
    writeWatchlist({
      members: mergedMembers,
      tickers: mergedTickers,
      ...(mergedInsiders.length ? { insiders: mergedInsiders } : {}),
      labels: state.labels,
    });
    trackEvent("watchlist_import_shared", { count: tokens.length });
  };

  return (
    <div
      data-watchlist-banner
      className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[18px] bg-fill/65 px-4 py-3 text-[13px] ring-1 ring-black/[0.05] dark:ring-white/[0.08]"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 inline-flex items-center gap-1.5 font-semibold text-foreground">
          <Bookmark className="size-3.5" aria-hidden />
          Following filter:
        </span>
        {activeWatch.members.map((m) => (
          <a
            key={m}
            href={`/politicians`}
            onClick={(e) => {
              if (mounted && state.members.includes(m)) {
                e.preventDefault();
                toggle({ kind: "member", id: m });
              }
            }}
            className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-0.5 text-[12px] font-medium text-foreground shadow-segment ring-1 ring-black/[0.05] dark:ring-white/[0.08]"
            title={mounted && state.labels[m] ? `${state.labels[m]} (${m})` : `Member ${m}`}
          >
            <span>{mounted && state.labels[m] ? state.labels[m] : m}</span>
          </a>
        ))}
        {insiders.map((c) => (
          <a
            key={c}
            href={`/insiders?cik=${encodeURIComponent(c)}`}
            onClick={(e) => {
              if (mounted && (state.insiders ?? []).includes(c)) {
                e.preventDefault();
                toggle({ kind: "insider", id: c });
              }
            }}
            className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-0.5 text-[12px] font-medium text-foreground shadow-segment ring-1 ring-black/[0.05] dark:ring-white/[0.08]"
            title={mounted && state.labels[c] ? `${state.labels[c]} (CIK ${c})` : `Insider CIK ${c}`}
          >
            <span>{mounted && state.labels[c] ? state.labels[c] : `CIK ${c}`}</span>
          </a>
        ))}
        {activeWatch.tickers.map((t) => (
          <a
            key={t}
            href={`/tickers/${encodeURIComponent(t)}`}
            className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-0.5 font-mono text-[12px] font-semibold text-foreground shadow-segment ring-1 ring-black/[0.05] dark:ring-white/[0.08]"
          >
            {t}
          </a>
        ))}
      </div>
      <div className="flex items-center gap-2">
        {isUnsavedShared ? (
          <button
            type="button"
            onClick={saveSharedToLocal}
            className={cn(BUTTON_PRIMARY, "h-7 px-3 text-[12px]")}
          >
            <Sparkles className="size-3" aria-hidden />
            Save to my watchlist
          </button>
        ) : null}
        <a
          href={clearHref}
          className="text-[12px] font-medium text-muted-foreground underline decoration-border-strong underline-offset-[3px] hover:text-foreground"
        >
          Show all trades
        </a>
      </div>
    </div>
  );
}

export type StarterFollowItem = {
  kind: "member" | "ticker" | "insider";
  id: string;
  label: string;
  sub: string;
  badge?: string;
  href: string;
};

/**
 * Interactive Alert & Watchlist Builder mounted on the `/` command-center
 * landing page. Visitors can one-click follow suggested top-rated politicians,
 * high-conviction C-suite corporate insiders, and convergence stocks, then
 * subscribe to the Daily Email Digest & Cluster Alerts in one step.
 */
export function LandingAlertBuilder({
  politicians,
  insiders,
  tickers,
}: {
  politicians: StarterFollowItem[];
  insiders: StarterFollowItem[];
  tickers: StarterFollowItem[];
}) {
  const { state, mounted, toggle } = useWatchlist();
  const [email, setEmail] = useState("");
  const [clusters, setClusters] = useState(true);
  const [weeklyDigest, setWeeklyDigest] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const totalCount = mounted ? watchCount(state) : 0;
  const feedHref = watchlistFeedHref(state);

  const isFollowed = (item: StarterFollowItem) => {
    if (!mounted) return false;
    const norm = item.kind === "insider" ? item.id.trim() : item.id.trim().toUpperCase();
    if (item.kind === "member") return state.members.includes(norm);
    if (item.kind === "insider") return (state.insiders ?? []).includes(norm);
    return state.tickers.includes(norm);
  };

  const handleSubscribe = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setNotice(null);
    const members = [...state.members];
    const watchedTickers = [...state.tickers];
    const watchedInsiders = [...(state.insiders ?? [])];

    try {
      const res = await fetch("/api/alerts/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          members,
          tickers: watchedTickers,
          insiders: watchedInsiders,
          clusters,
          weeklyDigest,
        }),
      });
      const data = (await res.json()) as {
        message?: string;
        error?: string;
        status?: string;
        code?: string;
      };
      trackEvent("landing_alert_builder_subscribe", {
        status: res.ok ? (data.status ?? "ok") : (data.code ?? "error"),
        members: members.length,
        insiders: watchedInsiders.length,
        tickers: watchedTickers.length,
        clusters,
        weeklyDigest,
      });
      if (res.ok) {
        setNotice(data.message ?? "Check your inbox to confirm your daily alert subscription.");
        setEmail("");
      } else {
        setNotice(data.error ?? "Your selections are saved to your watchlist on this device.");
      }
    } catch {
      trackEvent("landing_alert_builder_subscribe", {
        status: "network_error",
        members: members.length,
        insiders: watchedInsiders.length,
        tickers: watchedTickers.length,
      });
      setNotice("Your selections are saved to your watchlist on this device.");
    } finally {
      setSubmitting(false);
    }
  };

  const renderGroup = (title: string, subtitle: string, items: StarterFollowItem[]) => (
    <div className="min-w-0 rounded-[16px] bg-fill/55 p-3.5 ring-1 ring-black/[0.04] dark:ring-white/[0.07]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {title}
        </p>
        <span className="text-[11px] text-muted-foreground">{subtitle}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {items.map((item) => {
          const active = isFollowed(item);
          return (
            <button
              key={`${item.kind}:${item.id}`}
              type="button"
              aria-pressed={active}
              onClick={() =>
                toggle({
                  kind: item.kind,
                  id: item.id,
                  label: item.label,
                })
              }
              className={cn(
                "group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 text-left text-[12.5px] transition-all",
                active
                  ? "bg-foreground text-background shadow-segment font-semibold"
                  : "bg-card text-foreground ring-1 ring-black/[0.06] hover:bg-foreground/[0.06] dark:ring-white/[0.1]",
                FOCUS_RING
              )}
              title={`${active ? "Following" : "Follow"} ${item.label} (${item.sub})`}
            >
              {active ? (
                <Check className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden />
              ) : (
                <Star className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" strokeWidth={2.2} aria-hidden />
              )}
              <span className={cn("min-w-0 truncate", item.kind === "ticker" && "font-mono font-semibold")}>{item.label}</span>
              {item.badge ? (
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10.5px] font-semibold tabular",
                    active
                      ? "bg-background/20 text-background"
                      : "bg-fill text-ink-2"
                  )}
                >
                  {item.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div
      data-landing-alert-builder
      className="rounded-[24px] bg-card p-5 shadow-card ring-1 ring-black/[0.04] dark:ring-white/[0.07] sm:p-6"
    >
      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                1. Build your radar
              </p>
              <h2 className="mt-0.5 text-[18px] font-semibold tracking-[-0.02em] text-foreground">
                Follow rated politicians, C-suite insiders &amp; convergence stocks
              </h2>
            </div>
            {totalCount > 0 ? (
              <a
                href={feedHref}
                className={cn(BUTTON_PRIMARY, "h-8 px-3.5 text-[12.5px]")}
              >
                <Star className="size-3.5 fill-current" aria-hidden />
                <span>Following feed ({totalCount}) →</span>
              </a>
            ) : null}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
            Tap any name or ticker below to pin them to your personal watchlist. We track both Congressional STOCK Act disclosures and SEC Form 4 corporate insider filings.
          </p>

          <div className="mt-3.5 grid gap-2.5">
            {renderGroup("Top-Rated Congress", "90d vs SPY", politicians)}
            {renderGroup("High-Conviction Insiders", "Form 4 buyers", insiders)}
            {renderGroup("Convergence Tickers", "Both books", tickers)}
          </div>
        </div>

        <form
          onSubmit={handleSubscribe}
          className="flex min-w-0 flex-col justify-between rounded-[18px] bg-fill/65 p-4 ring-1 ring-black/[0.05] dark:ring-white/[0.08] sm:p-5"
        >
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              2. Get trade alerts
            </p>
            <h3 className="mt-0.5 text-[16px] font-semibold tracking-[-0.015em] text-foreground">
              Daily Email Digest &amp; Cluster Signals
            </h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
              Get at most one combined daily email when your followed politicians, corporate insiders, or stocks file new disclosures—plus multi-filer cluster alerts.
            </p>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-label="Email address for trade alerts"
                className={cn(FIELD, "h-9 flex-1 bg-card text-[13px]")}
              />
              <button
                type="submit"
                disabled={submitting}
                className={cn(BUTTON_PRIMARY, "h-9 px-4 text-[13px]")}
              >
                <Mail className="size-3.5 shrink-0" aria-hidden />
                <span>{submitting ? "Subscribing…" : "Get Alerts"}</span>
              </button>
            </div>

            <div className="mt-3 space-y-1.5 text-[12px] text-ink-2">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={clusters}
                  onChange={(e) => setClusters(e.target.checked)}
                  className="size-3.5 accent-foreground"
                />
                <span>Include multi-member &amp; C-suite cluster buy alerts</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={weeklyDigest}
                  onChange={(e) => setWeeklyDigest(e.target.checked)}
                  className="size-3.5 accent-foreground"
                />
                <span>Include weekly convergence &amp; rating digest</span>
              </label>
            </div>

            {notice ? (
              <p className="mt-2.5 rounded-[10px] bg-card px-3 py-2 text-[12px] font-medium text-foreground ring-1 ring-black/[0.05] dark:ring-white/[0.08]">
                {notice}
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[12px]">
            <span className="text-muted-foreground">
              {totalCount > 0
                ? `${totalCount} item${totalCount === 1 ? "" : "s"} selected on this device`
                : "No account required · 1-click unsubscribe"}
            </span>
            <div className="flex items-center gap-3">
              <a
                href="/watchlist"
                className="font-semibold text-foreground underline decoration-border-strong underline-offset-[3px]"
              >
                Watchlist
              </a>
              <a
                href="/alerts"
                className="font-semibold text-foreground underline decoration-border-strong underline-offset-[3px]"
              >
                Alert log &amp; RSS →
              </a>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
