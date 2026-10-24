"use client";

import React, { useEffect } from "react";

/**
 * AppleScrollObserver coordinates Apple-style scroll interactions:
 * - Headlines and content tiles glide smoothly into position as you scroll there.
 * - Sections snap cleanly into place with proximity snap.
 * - Respects prefers-reduced-motion accessibility preferences.
 */
export function AppleScrollObserver({
  children,
}: {
  children: React.ReactNode;
}) {
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

    // IntersectionObserver for elements moving smoothly into position
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
      // Check if already in viewport on mount (e.g. above the fold)
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight - 40 && rect.bottom > 0) {
        el.classList.add("is-revealed");
      } else {
        revealObserver.observe(el);
      }
    }

    return () => {
      revealObserver.disconnect();
      document.documentElement.classList.remove("apple-reveal-active");
    };
  }, []);

  return <div className="apple-page-container w-full">{children}</div>;
}
