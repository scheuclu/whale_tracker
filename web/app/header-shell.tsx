"use client";

import { useEffect, useState } from "react";

/**
 * The sticky masthead's element. Its stickiness is plain CSS (`.site-header`
 * in globals.css: on a phone it pins at minus the brand row, so only the
 * sections row stays), so this only marks the document's first paint.
 *
 * `data-first-load` stays on the header until the reader first interacts,
 * and while it is there globals.css plays the page-in fade in zero time:
 * the fade marks new content replacing old, and on the document's own
 * first paint there is nothing to replace. Holding the content at opacity
 * 0 for that first 260 ms only delayed its paint (and with it the page's
 * Largest Contentful Paint). Every client navigation follows a click, a
 * key or history traversal, so they all still fade in.
 */
export function HeaderShell({ children }: { children: React.ReactNode }) {
  const [firstLoad, setFirstLoad] = useState(true);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!firstLoad) return;
    const done = () => setFirstLoad(false);
    const events = ["pointerdown", "keydown", "popstate"] as const;
    for (const e of events) window.addEventListener(e, done, { once: true, passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, done);
    };
  }, [firstLoad]);

  useEffect(() => {
    const onScroll = () => {
      const isScrolled = window.scrollY > 10;
      setScrolled((prev) => (prev !== isScrolled ? isScrolled : prev));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      data-first-load={firstLoad ? "" : undefined}
      data-scrolled={scrolled ? "true" : "false"}
      className="site-header z-30"
    >
      {children}
    </header>
  );
}
