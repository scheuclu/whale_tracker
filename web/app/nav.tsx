"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Activity, Briefcase, Landmark, LineChart, Moon, Receipt, ScanLine, Search, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/", label: "Feed", icon: Receipt },
  { href: "/tickers", label: "Tickers", icon: LineChart },
  { href: "/politicians", label: "Politicians", icon: Landmark },
  { href: "/insiders", label: "Insiders", icon: Briefcase },
  { href: "/scans", label: "Scans", icon: ScanLine },
  { href: "/pipeline", label: "Pipeline", icon: Activity },
];

export function Tabs() {
  const pathname = usePathname();
  return (
    <nav className="glass flex w-fit gap-1 rounded-full border border-border bg-card p-1">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary/15 text-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Icon className={cn("size-3.5", active && "text-primary")} aria-hidden />
            {label}
          </Link>
        );
      })}
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
      className="flex size-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {mounted && resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

/**
 * Global search: members, tickers and insider issuers. A plain GET form to
 * /search, so it works before hydration and the result is a URL.
 */
export function SearchForm({ className }: { className?: string }) {
  return (
    <form
      method="get"
      action="/search"
      role="search"
      className={cn("glass relative flex items-center rounded-full border border-border bg-card", className)}
    >
      <Search className="pointer-events-none absolute left-3 size-3.5 text-muted-foreground" aria-hidden />
      <input
        type="search"
        name="q"
        maxLength={80}
        placeholder="Search member, ticker, issuer"
        aria-label="Search members, tickers and insider issuers"
        className="h-8 w-44 rounded-full bg-transparent pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:w-64 focus:outline-none sm:w-56"
      />
    </form>
  );
}
