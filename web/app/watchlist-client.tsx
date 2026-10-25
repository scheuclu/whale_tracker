"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Bookmark, Check, ExternalLink, Sparkles, Star, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";
import { BUTTON, BUTTON_PRIMARY, FOCUS_RING } from "./ui";
import {
  EMPTY_WATCHLIST,
  WATCHLIST_STORAGE_KEY,
  sanitizeWatchlistState,
  serializeWatchParam,
  toggleWatchItem,
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

  const toggle = useCallback((item: { kind: "member" | "ticker"; id: string; label?: string }) => {
    const current = readWatchlist();
    const { next, followed } = toggleWatchItem(current, item);
    writeWatchlist(next);
    setState(next);
    trackEvent("watchlist_toggle", {
      kind: item.kind,
      id: item.id.toUpperCase(),
      followed,
      total: next.members.length + next.tickers.length,
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
 * MemberHero, SymbolHero, and Insider issuer headers.
 */
export function FollowButton({
  kind,
  id,
  label,
  className,
}: {
  kind: "member" | "ticker";
  id: string;
  label?: string;
  className?: string;
}) {
  const { state, mounted, toggle } = useWatchlist();
  const normId = id.trim().toUpperCase();
  const isFollowed =
    mounted && (kind === "member" ? state.members.includes(normId) : state.tickers.includes(normId));

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
 * ticker, or high-signal cluster alerts via Watchlist, Telegram, or Markdown/Atom feed.
 */
export function GetAlertsPopover({
  subject,
  className,
}: {
  subject?: { kind: "member" | "ticker"; id: string; label: string };
  className?: string;
}) {
  const { state, mounted, toggle } = useWatchlist();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const normId = subject?.id.trim().toUpperCase();
  const isFollowed =
    mounted &&
    normId != null &&
    (subject?.kind === "member" ? state.members.includes(normId) : state.tickers.includes(normId));

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

  const totalWatched = state.members.length + state.tickers.length;
  const feedUrl = watchlistFeedHref(state);

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
          className="absolute right-0 top-full z-40 mt-2 w-[min(21rem,calc(100vw-2rem))] rounded-[20px] border border-black/[0.08] bg-popover/95 p-4 text-left text-popover-foreground shadow-popover backdrop-blur-2xl dark:border-white/[0.12]"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                Watchlist &amp; Alerts
              </p>
              <p className="mt-0.5 text-[14px] font-semibold tracking-[-0.015em] text-foreground">
                {subject ? `Track ${subject.label}` : "Track politicians & stocks"}
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

            <div className="rounded-[14px] bg-fill/65 p-3 ring-1 ring-black/[0.04] dark:ring-white/[0.07]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">Dispatched Alert Log</span>
                <a
                  href="/alerts"
                  onClick={() => trackEvent("alerts_log_click", { from: normId ?? "global" })}
                  className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-[12px] font-medium text-foreground shadow-segment ring-1 ring-black/[0.05] dark:ring-white/[0.08]"
                >
                  View log
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </div>
              <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
                Every congressional cluster, watched-member filing, late disclosure, and Form 4 C-suite buy as sent.
              </p>
            </div>

            {totalWatched > 0 ? (
              <div className="flex items-center justify-between border-t border-border/60 pt-2.5 text-[12px]">
                <span className="text-muted-foreground">
                  Watching {totalWatched} {totalWatched === 1 ? "item" : "items"}
                </span>
                <a
                  href={feedUrl}
                  onClick={() => setOpen(false)}
                  className="font-semibold text-foreground underline decoration-border-strong underline-offset-[3px]"
                >
                  Open Following feed →
                </a>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Header Watchlist badge (`★ N`) shown in the masthead toolbar once the
 * visitor follows at least one politician or stock.
 */
export function HeaderWatchlistPill() {
  const { state, mounted } = useWatchlist();
  if (!mounted) return null;
  const count = state.members.length + state.tickers.length;
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
  activeWatch?: { members: string[]; tickers: string[] };
  allHref: string;
}) {
  const { state, mounted } = useWatchlist();
  const isFiltered = Boolean(activeWatch && (activeWatch.members.length > 0 || activeWatch.tickers.length > 0));
  const localCount = mounted ? state.members.length + state.tickers.length : 0;

  if (!isFiltered && localCount === 0) {
    return null;
  }

  const targetHref = isFiltered ? allHref : watchlistFeedHref(state);
  const count = isFiltered
    ? (activeWatch?.members.length ?? 0) + (activeWatch?.tickers.length ?? 0)
    : localCount;

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
      title={isFiltered ? "Showing only your watchlist — click to show all trades" : "Filter feed to your followed politicians and tickers"}
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
  activeWatch?: { members: string[]; tickers: string[] };
  clearHref: string;
}) {
  const { state, mounted, toggle } = useWatchlist();
  if (!activeWatch || (activeWatch.members.length === 0 && activeWatch.tickers.length === 0)) {
    return null;
  }

  const tokens = [...activeWatch.members, ...activeWatch.tickers];
  const localParam = mounted ? serializeWatchParam(state) : "";
  const urlParam = serializeWatchParam(activeWatch);
  const isUnsavedShared = mounted && urlParam !== localParam;

  const saveSharedToLocal = () => {
    const mergedMembers = Array.from(new Set([...state.members, ...activeWatch.members]));
    const mergedTickers = Array.from(new Set([...state.tickers, ...activeWatch.tickers]));
    writeWatchlist({
      members: mergedMembers,
      tickers: mergedTickers,
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
