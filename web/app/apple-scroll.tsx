"use client";

import React, { useEffect } from "react";
import { usePathname } from "next/navigation";

const REVEAL_SELECTOR = ".apple-headline-reveal, .apple-card-reveal, .apple-stagger-item";

/**
 * AppleScrollObserver coordinates Apple-style scroll interactions across all routes:
 * - Headlines, Bento cards, and staggered tiles glide smoothly into position on scroll.
 * - Automatically observes newly mounted elements across client-side route transitions.
 * - Respects prefers-reduced-motion accessibility preferences.
 */
export function AppleScrollObserver({
  children,
}: {
  children?: React.ReactNode;
}) {
  const pathname = usePathname();

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      document.documentElement.classList.remove("apple-reveal-active");
      return;
    }

    document.documentElement.classList.add("apple-reveal-active");

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
        threshold: 0.06,
        rootMargin: "0px 0px -32px 0px",
      }
    );

    const scanAndObserve = () => {
      const elements = document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR);
      for (const el of elements) {
        if (el.classList.contains("is-revealed")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight - 24 && rect.bottom > 0) {
          el.classList.add("is-revealed");
        } else {
          revealObserver.observe(el);
        }
      }
    };

    scanAndObserve();

    const mutationObserver = new MutationObserver(() => {
      scanAndObserve();
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      mutationObserver.disconnect();
      revealObserver.disconnect();
    };
  }, [pathname]);

  return children ? <>{children}</> : null;
}
