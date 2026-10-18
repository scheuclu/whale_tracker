"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Bell,
  Briefcase,
  Landmark,
  LineChart,
  Moon,
  Receipt,
  ScanLine,
  Search,
  Sun,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { revealOffset } from "@/lib/scroll-edges";
import { ScrollX } from "./scroll-area";

const TABS = [
  { href: "/", label: "Feed", icon: Receipt },
  { href: "/tickers", label: "Tickers", icon: LineChart },
  { href: "/politicians", label: "Politicians", icon: Landmark },
  { href: "/insiders", label: "Insiders", icon: Briefcase },
  { href: "/scans", label: "Scans", icon: ScanLine },
  { href: "/pipeline", label: "Pipeline", icon: Activity },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/trends", label: "Trends", icon: TrendingUp },
];

/**
 * Six labelled tabs are ~610px: wider than a phone. The strip scrolls
 * sideways behind an edge fade rather than wrapping or shedding its labels
 * (the icons alone do not say "Scans" or "Pipeline"), and the active tab is
 * scrolled into view on arrival so the reader can see where they are.
 */
export function Tabs() {
  const pathname = usePathname();
  const viewport = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const vp = viewport.current;
    const active = vp?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!vp || !active) return;
    vp.scrollLeft = revealOffset({
      scrollLeft: vp.scrollLeft,
      clientWidth: vp.clientWidth,
      itemLeft: active.offsetLeft,
      itemWidth: active.offsetWidth,
    });
  }, [pathname]);

  return (
    <nav aria-label="Sections" className="min-w-0 max-w-full">
      <ScrollX viewportRef={viewport} viewportClassName="scrollbar-none flex gap-0.5 px-0.5 pt-0.5">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group/tab relative flex h-10 shrink-0 items-center whitespace-nowrap px-1 pb-0.5 text-[13px] font-medium outline-none",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {/* The hover/focus/pressed surface is an inner box, so the active
                  underline can run the tab's full width along the header's edge. */}
              <span
                className={cn(
                  "flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 transition-[background-color,color] duration-150 ease-out",
                  "group-hover/tab:bg-foreground/[0.05] group-active/tab:bg-foreground/[0.08]",
                  "group-focus-visible/tab:outline-solid group-focus-visible/tab:outline-2 group-focus-visible/tab:outline-primary"
                )}
              >
                <Icon
                  className={cn(
                    "size-3.5 transition-colors duration-150",
                    active ? "text-primary" : "text-muted-foreground/80 group-hover/tab:text-foreground"
                  )}
                  aria-hidden
                />
                {label}
              </span>
              <span
                aria-hidden
                className={cn(
                  "absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary transition-opacity duration-150",
                  active ? "opacity-100" : "opacity-0"
                )}
              />
            </Link>
          );
        })}
      </ScrollX>
    </nav>
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <button
      type="button"
      className={cn(
        "group flex size-8 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground",
        "transition-[background-color,color] duration-150 ease-out hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1]",
        "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      )}
      aria-label={mounted ? `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme` : "Toggle theme"}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {/* Both icons render; the `.dark` class next-themes sets before paint
          picks one, so the button never flashes the wrong icon on load. */}
      <Sun className="hidden size-4 transition-transform duration-300 motion-safe:group-hover:rotate-45 dark:block" aria-hidden />
      <Moon className="size-4 transition-transform duration-300 motion-safe:group-hover:-rotate-12 dark:hidden" aria-hidden />
    </button>
  );
}

/**
 * Global search: members, tickers and insider issuers. A plain GET form to
 * /search, so it works before hydration and the result is a URL. ⌘K / Ctrl K
 * (and "/" outside a text field) focus it; the hint appears once hydrated,
 * because the shortcut only exists then.
 */
export function SearchForm({ className }: { className?: string }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    setHint(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K");
    const onKey = (e: KeyboardEvent) => {
      const el = input.current;
      if (!el) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, select, [contenteditable='true']");
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        el.focus();
        el.select();
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        el.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form method="get" action="/search" role="search" className={cn("relative flex items-center", className)}>
      <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden />
      <input
        ref={input}
        type="search"
        name="q"
        maxLength={80}
        placeholder="Search members, tickers, issuers"
        aria-label="Search members, tickers and insider issuers"
        aria-keyshortcuts={hint ? "Meta+K Control+K /" : undefined}
        className={cn(
          "peer h-8 w-full rounded-[8px] border border-border bg-foreground/[0.03] pl-8 pr-14 text-[13px] text-foreground",
          "transition-[border-color,background-color,box-shadow] duration-150 ease-out [&::-webkit-search-cancel-button]:hidden",
          "placeholder:text-muted-foreground hover:border-foreground/20 hover:bg-foreground/[0.05]",
          "focus:border-primary/60 focus:bg-[var(--card-solid)] focus:outline-none focus:ring-[3px] focus:ring-primary/30"
        )}
      />
      {hint ? (
        <kbd
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2 hidden h-5 items-center rounded-[5px] border border-border bg-[var(--card-solid)] px-1.5",
            "font-sans text-[10.5px] font-medium text-muted-foreground sm:inline-flex",
            "peer-focus:opacity-0 peer-[:not(:placeholder-shown)]:opacity-0"
          )}
        >
          {hint}
        </kbd>
      ) : null}
    </form>
  );
}

/**
 * When the pipeline last wrote, as a quiet dot and a relative time; links to
 * /pipeline. Past STALE_AFTER_HOURS the dot turns amber and a screen reader
 * hears "stale" — the colour is never the only signal.
 */
export function SyncStatus({
  synced,
  syncedAt,
  tone,
}: {
  synced: string;
  syncedAt: string | null;
  tone: "fresh" | "stale" | "unknown";
}) {
  return (
    <Link
      href="/pipeline"
      title={syncedAt ? `Last pipeline write: ${syncedAt} — open Pipeline` : "Open Pipeline"}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-2 rounded-[8px] px-2.5 text-xs text-muted-foreground",
        "transition-[background-color,color] duration-150 ease-out hover:bg-foreground/[0.05] hover:text-foreground active:bg-foreground/[0.08]",
        "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full ring-[3px]",
          tone === "fresh" && "bg-emerald-500 ring-emerald-500/15",
          tone === "stale" && "bg-amber-500 ring-amber-500/20",
          tone === "unknown" && "bg-muted-foreground/60 ring-muted-foreground/15"
        )}
      />
      <span className="tabular">
        <span className="sr-only sm:not-sr-only">synced </span>
        {synced}
        {tone === "stale" ? <span className="text-amber-700 dark:text-amber-300"> · stale</span> : null}
      </span>
    </Link>
  );
}
