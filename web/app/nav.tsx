"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Activity, Bell, Briefcase, Landmark, LineChart, Moon, Receipt, ScanLine, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/", label: "Feed", icon: Receipt },
  { href: "/tickers", label: "Tickers", icon: LineChart },
  { href: "/politicians", label: "Politicians", icon: Landmark },
  { href: "/insiders", label: "Insiders", icon: Briefcase },
  { href: "/scans", label: "Scans", icon: ScanLine },
  { href: "/pipeline", label: "Pipeline", icon: Activity },
  { href: "/alerts", label: "Alerts", icon: Bell },
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
