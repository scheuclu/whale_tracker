"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { Moon, Search, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The five reader sections. Operator pages (Scans, Pipeline, Alerts) and
 * the reference pages (Methodology, Privacy, Terms) live in the footer's
 * "About the data". Words only — an icon per tab was decoration the label
 * already said. "Members" keeps the /politicians URL.
 */
const TABS = [
  { href: "/", label: "Feed" },
  { href: "/politicians", label: "Members" },
  { href: "/tickers", label: "Tickers" },
  { href: "/insiders", label: "Insiders" },
  { href: "/trends", label: "Trends" },
];

/**
 * Five short words fit a 320px phone on one line, so the strip never
 * scrolls: spread edge to edge on a phone, set left from 640px, inline with
 * the brand from 1024px. The active section is marked three ways — ink
 * text, a gold bar standing on the masthead's rule, and `aria-current`.
 */
export function Tabs({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Sections" className={cn("min-w-0", className)}>
      <ul className="-mx-1 flex items-stretch justify-between sm:-mx-2 sm:justify-start sm:gap-1">
        {TABS.map(({ href, label }) => {
          // A member's page lives at /members/<slug> but belongs to Members.
          const active =
            href === "/"
              ? pathname === "/"
              : pathname.startsWith(href) || (href === "/politicians" && pathname.startsWith("/members/"));
          return (
            <li key={href} className="flex">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group/tab relative flex h-10 items-center whitespace-nowrap px-0.5 text-[14px] font-medium outline-none sm:h-11 sm:px-1 lg:h-[60px]",
                  active ? "text-foreground" : "text-ink-2 hover:text-foreground"
                )}
              >
                <span className="rounded-control px-1 py-1 group-focus-visible/tab:outline-solid group-focus-visible/tab:outline-2 group-focus-visible/tab:outline-ring">
                  {label}
                </span>
                {/* Stands on the masthead's ink rule (the header's border). */}
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-1 -bottom-px h-[3px] transition-opacity duration-150 sm:inset-x-2",
                    active ? "bg-gold opacity-100" : "bg-foreground/25 opacity-0 group-hover/tab:opacity-100"
                  )}
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const ICON_BUTTON = cn(
  "group flex size-8 shrink-0 items-center justify-center rounded-control text-ink-2",
  "transition-[background-color,color] duration-(--dur) ease-(--ease-out) hover:bg-secondary hover:text-foreground active:bg-foreground/[0.1]",
  "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
);

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <button
      type="button"
      className={ICON_BUTTON}
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

/** On a phone the masthead has no room for a field: a link to /search, which has its own. */
export function SearchLink({ className }: { className?: string }) {
  return (
    <Link href="/search" className={cn(ICON_BUTTON, className)} aria-label="Search members, tickers and insider issuers">
      <Search className="size-4" aria-hidden />
    </Link>
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
      // Hidden (a phone, where the masthead shows a link instead): nothing to focus.
      if (!el || !el.offsetParent) return;
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
    <form method="get" action="/search" role="search" className={cn("relative flex items-center rounded-control", className)}>
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
          "peer h-8 w-full rounded-control border border-input bg-[var(--field)] pl-8 pr-14 text-[13px] text-foreground",
          "transition-[border-color,background-color] duration-(--dur) ease-(--ease-out) [&::-webkit-search-cancel-button]:hidden",
          "placeholder:text-muted-foreground hover:border-border-strong focus:border-ring"
        )}
      />
      {hint ? (
        <kbd
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2 hidden h-5 items-center rounded-chip border border-border px-1.5",
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
