"use client";

import { useEffect } from "react";

/**
 * Publishes the site header's live height as `--sticky-top` on <html>, so
 * sticky elements further down (the feed's day headers) park just beneath
 * it instead of sliding under the masthead. Measured rather than
 * hard-coded because the header's height differs between breakpoints and
 * may change with its own design; the CSS fallback covers the first paint.
 */
export function StickyOffset({ selector = "body header" }: { selector?: string }) {
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    const root = document.documentElement;
    const apply = () => {
      // A header that scrolls away leaves nothing to park under.
      const style = getComputedStyle(el);
      const pinned = /^(sticky|fixed)$/.test(style.position);
      // A negative `top` (the phone masthead, globals.css) pins only the
      // part below it: the brand row scrolls away, the sections row stays.
      const offset = Math.min(0, parseFloat(style.top) || 0);
      // Floor, not round: a fractional header height rounded up would leave
      // a sub-pixel strip between the header and whatever parks below it.
      const h = pinned ? Math.floor(el.getBoundingClientRect().height + offset) : 0;
      root.style.setProperty("--sticky-top", `${h}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [selector]);
  return null;
}
