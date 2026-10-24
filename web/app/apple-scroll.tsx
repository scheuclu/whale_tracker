"use client";

import React, { useEffect, useState, useTransition } from "react";
import { cn } from "@/lib/utils";

export type NavSection = {
  id: string;
  label: string;
  badge?: string | number;
};

/**
 * AppleScrollObserver coordinates Apple-style scroll interactions:
 * - Headlines and content tiles glide smoothly into position as you scroll there.
 * - Sections snap cleanly into place with proximity snap.
 * - Tracks active section for the Apple floating chapter navigation.
 */
export function AppleScrollObserver({
  children,
  sections,
}: {
  children: React.ReactNode;
  sections?: NavSection[];
}) {
  const [activeSection, setActiveSection] = useState<string>(sections?.[0]?.id ?? "overview");
  const [, startTransition] = useTransition();

  useEffect(() => {
    // Check if user prefers reduced motion
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      document.documentElement.classList.remove("apple-reveal-active");
      return;
    }

    // Enable the Apple reveal motion styles
    document.documentElement.classList.add("apple-reveal-active");

    const revealSelector = ".apple-headline-reveal, .apple-card-reveal, .apple-stagger-item";
    const revealElements = Array.from(document.querySelectorAll<HTMLElement>(revealSelector));

    // IntersectionObserver for elements moving into position
    const revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-revealed");
            revealObserver.unobserve(entry.target);
          }
        }
      },
      {
        threshold: 0.08,
        rootMargin: "0px 0px -40px 0px",
      }
    );

    for (const el of revealElements) {
      // Check if already in viewport on mount (e.g., above the fold)
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight - 40 && rect.bottom > 0) {
        el.classList.add("is-revealed");
      } else {
        revealObserver.observe(el);
      }
    }

    // IntersectionObserver for tracking active section in Apple subnav
    let sectionObserver: IntersectionObserver | null = null;
    if (sections && sections.length > 0) {
      const sectionElements = sections
        .map((s) => document.getElementById(s.id))
        .filter((el): el is HTMLElement => Boolean(el));

      sectionObserver = new IntersectionObserver(
        (entries) => {
          // Find the intersecting entry closest to the top of viewport
          const visible = entries.filter((e) => e.isIntersecting);
          if (visible.length > 0) {
            // Sort by proximity to top
            visible.sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
            const topId = visible[0].target.id;
            startTransition(() => {
              setActiveSection(topId);
            });
          }
        },
        {
          threshold: [0.1, 0.3, 0.6],
          rootMargin: "-80px 0px -40% 0px",
        }
      );

      for (const el of sectionElements) {
        sectionObserver.observe(el);
      }
    }

    return () => {
      revealObserver.disconnect();
      sectionObserver?.disconnect();
      document.documentElement.classList.remove("apple-reveal-active");
    };
  }, [sections]);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const navOffset = 90; // header height + breathing room
    const bodyRect = document.body.getBoundingClientRect().top;
    const elementRect = el.getBoundingClientRect().top;
    const elementPosition = elementRect - bodyRect;
    const offsetPosition = elementPosition - navOffset;

    window.scrollTo({
      top: offsetPosition,
      behavior: "smooth",
    });
    setActiveSection(id);
  };

  return (
    <div className="apple-page-container w-full">
      {sections && sections.length > 1 ? (
        <AppleSubNav sections={sections} activeId={activeSection} onSelect={scrollTo} />
      ) : null}
      {children}
    </div>
  );
}

/**
 * Floating Apple-style chapter pill navigation (like on apple.com product pages)
 * Stays gracefully pinned under the main header as the user scrolls.
 */
export function AppleSubNav({
  sections,
  activeId,
  onSelect,
}: {
  sections: NavSection[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Page chapters"
      className="sticky top-12 z-25 -mx-4 mb-8 flex justify-center px-4 pt-1 sm:top-[52px] sm:-mx-6 sm:px-6 pointer-events-none"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto scrollbar-none rounded-full border border-black/[0.08] dark:border-white/[0.12] bg-background/80 p-1 shadow-[0_4px_24px_rgba(0,0,0,0.06)] backdrop-blur-xl transition-all duration-300">
        {sections.map((s) => {
          const isActive = activeId === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium tracking-tight transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-foreground",
                isActive
                  ? "bg-card text-foreground shadow-[0_1px_4px_rgba(0,0,0,0.08)] dark:bg-raised"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]"
              )}
            >
              <span>{s.label}</span>
              {s.badge !== undefined ? (
                <span
                  className={cn(
                    "tabular rounded-full px-1.5 py-0.2 text-[11px] font-semibold",
                    isActive
                      ? "bg-fill text-foreground"
                      : "bg-fill/60 text-muted-foreground"
                  )}
                >
                  {s.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
