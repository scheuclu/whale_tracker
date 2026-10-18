"use client";

import { useEffect, useState } from "react";

/**
 * The sticky site header. Once the page has scrolled it sets
 * `data-condensed`, and globals.css (`.site-header`) tightens the brand row
 * and drops the subtitle so the tab strip takes less of a phone screen.
 *
 * The thresholds differ on purpose: condensing shortens the header, which
 * moves the content under it, so a single threshold would flip back and
 * forth while the reader sits on it.
 */
const CONDENSE_AT = 56;
const EXPAND_AT = 8;

export function HeaderShell({ children }: { children: React.ReactNode }) {
  const [condensed, setCondensed] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);

  // `data-first-load` stays on the header until the reader first interacts,
  // and while it is there globals.css plays the page-in fade in zero time:
  // the fade marks new content replacing old, and on the document's own
  // first paint there is nothing to replace. Holding the content at opacity
  // 0 for that first 260 ms only delayed its paint (and with it the page's
  // Largest Contentful Paint). Every client navigation follows a click, a
  // key or history traversal, so they all still fade in.
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
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      setCondensed((c) => (c ? y > EXPAND_AT : y > CONDENSE_AT));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header
      data-condensed={condensed ? "" : undefined}
      data-first-load={firstLoad ? "" : undefined}
      className="site-header sticky top-0 z-30 border-b border-border bg-background/75 backdrop-blur-xl backdrop-saturate-150"
    >
      {children}
    </header>
  );
}
