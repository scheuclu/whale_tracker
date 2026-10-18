"use client";

import { useEffect } from "react";

/**
 * Page-wide accessibility and motion hooks, mounted once per page from
 * app/template.tsx (the root layout belongs to the shell; the template is
 * the one route-level file every page renders through).
 */

/** The content landmark the skip link moves focus to. */
const MAIN_ID = "main-content";

/**
 * "Skip to content": the first stop on every page for a keyboard user, so
 * the brand row, the sync pill, the theme toggle, eight tabs and the search
 * box are one keypress rather than twelve. Hidden until focused (motion.css,
 * `.skip-link`).
 *
 * It must come first in tab order, so it is placed at the start of <body>,
 * ahead of the header — created once, outside React's tree, because the
 * root layout (which owns <body>) is not this file's to edit. When the
 * layout renders <SkipLinkAnchor /> as the first child of <body> itself and
 * sets `id="main-content"` on <main>, this effect can go.
 */
export function SkipLink() {
  useEffect(() => {
    const main = document.querySelector("main");
    if (main && !main.id) main.id = MAIN_ID;
    // One link for the life of the document: the template remounts on every
    // navigation, and a fresh node each time would drop focus from a link
    // the reader has just tabbed to.
    if (document.querySelector(".skip-link")) return;
    const link = document.createElement("a");
    link.href = `#${MAIN_ID}`;
    link.className = "skip-link";
    link.textContent = "Skip to content";
    link.addEventListener("click", skipToMain);
    document.body.prepend(link);
  }, []);
  return null;
}

/** The link as a component, for a layout that renders it directly. */
export function SkipLinkAnchor() {
  return (
    <a href={`#${MAIN_ID}`} className="skip-link" onClick={(e) => skipToMain(e.nativeEvent)}>
      Skip to content
    </a>
  );
}

function skipToMain(e: Event) {
  const main = document.querySelector("main");
  if (!main) return;
  e.preventDefault();
  // tabindex -1: focusable from script, not added to the tab order.
  if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  main.focus({ preventScroll: true });
  if (main.getBoundingClientRect().top < 0) window.scrollTo({ top: 0 });
}

/**
 * A smooth theme switch. next-themes swaps the `.dark` class with every CSS
 * transition suppressed (`disableTransitionOnChange`), which is right — a
 * page of surfaces each easing at its own speed reads as flicker — but it
 * makes the switch a hard cut. This wraps the toggle's own click in a View
 * Transition, so the browser cross-fades one finished frame into the other
 * (motion.css, `::view-transition-*(root)`).
 *
 * The toggle keeps all of its logic: the click is held, then replayed inside
 * the transition's update callback. No View Transitions support, or
 * `prefers-reduced-motion: reduce`, and the click goes straight through.
 */
const TOGGLE = "[data-theme-toggle], button[aria-label*='theme' i]";

export function ThemeTransition() {
  useEffect(() => {
    let replaying = false;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

    const onClick = (e: MouseEvent) => {
      if (replaying || !document.startViewTransition || reduce.matches) return;
      const toggle = (e.target as Element | null)?.closest?.(TOGGLE);
      if (!(toggle instanceof HTMLElement)) return;
      e.stopPropagation();
      e.preventDefault();
      const root = document.documentElement;
      const before = root.className;
      document.startViewTransition(async () => {
        // A synthetic click is a discrete event: React renders the toggle's
        // update synchronously before .click() returns.
        replaying = true;
        try {
          toggle.click();
        } finally {
          replaying = false;
        }
        // next-themes applies the class from an effect; wait for it so the
        // "new" snapshot is the new theme, but never hold the page past a frame or two.
        if (root.className === before) await classChange(root, 120);
      });
    };

    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  return null;
}

function classChange(el: HTMLElement, timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(done);
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    const timer = setTimeout(done, timeout);
  });
}
