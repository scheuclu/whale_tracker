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
 * the brand from 1024px. Small medium-weight words, apple.com's nav; the
 * active section sits in a grey capsule (the Apple TV / Music top-tab
 * pattern) and carries `aria-current`. No colour: the page is monochrome.
 */
export function Tabs({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    // Below 360px the capsules lose a little padding, so all five fit a
    // 320px phone (e2e checks 320 and 390 for sideways scroll).
    <nav aria-label="Sections" className={cn("min-w-0 flex items-center", className)}>
      <ul className="-mx-1.5 flex w-full items-center justify-between sm:mx-0 sm:w-auto sm: justify-start sm:gap-1 sm:rounded-full sm:bg-fill/85 sm:p-1 sm:shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] dark:sm:shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]">
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
                  "group/tab flex h-11 items-center whitespace-nowrap text-[13px] tracking-[-0.01em] outline-none sm:h-auto",
                  active ? "font-semibold text-foreground" : "font-medium text-ink-2 hover:text-foreground"
                )}
              >
                <span
                  className={cn(
                    "rounded-full px-[7px] py-[5px] transition-all duration-(--dur) ease-(--ease-out) min-[360px]:px-2.5 sm:px-3.5 sm:py-1.5",
                    "group-focus-visible/tab:outline-solid group-focus-visible/tab:outline-2 group-focus-visible/tab:outline-ring",
                    active
                      ? "bg-card text-foreground shadow-segment ring-1 ring-black/[0.04] dark:ring-white/[0.08]"
                      : "group-hover/tab:bg-foreground/[0.05]"
                  )}
                >
                  {label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const ICON_BUTTON = cn(
  "group flex size-8 shrink-0 items-center justify-center rounded-full text-ink-2",
  "transition-[background-color,color] duration-(--dur) ease-(--ease-out) hover:bg-fill hover:text-foreground active:bg-foreground/[0.12]",
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
    // The iOS / macOS Spotlight search field: a frosted capsule, magnifier, subtle inner ring.
    <form method="get" action="/search" role="search" className={cn("relative flex items-center rounded-full", className)}>
      <Search className="pointer-events-none absolute left-3 size-[14px] text-muted-foreground" strokeWidth={2.25} aria-hidden />
      <input
        ref={input}
        type="search"
        name="q"
        maxLength={80}
        placeholder="Search"
        aria-label="Search members, tickers and insider issuers"
        title="Search members, tickers and insider issuers"
        aria-keyshortcuts={hint ? "Meta+K Control+K /" : undefined}
        className={cn(
          "peer h-8 w-full rounded-full border border-black/[0.05] dark:border-white/[0.08] bg-fill/85 pl-8 pr-12 text-[13px] text-foreground outline-none shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]",
          "transition-all duration-(--dur) ease-(--ease-out) [&::-webkit-search-cancel-button]:hidden",
          "placeholder:text-muted-foreground hover:bg-foreground/[0.09] hover:border-black/[0.09] dark:hover:border-white/[0.15] focus:bg-card focus:border-black/[0.18] dark:focus:border-white/[0.24] focus:shadow-segment"
        )}
      />
      {hint ? (
        <kbd
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2 hidden h-5 items-center rounded-full bg-card/85 px-1.5 shadow-[0_0_0_0.5px_var(--border)]",
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
