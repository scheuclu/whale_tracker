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
      className="site-header sticky top-0 z-30 border-b border-border/70 bg-background/60 backdrop-blur-xl"
    >
      {children}
    </header>
  );
}
