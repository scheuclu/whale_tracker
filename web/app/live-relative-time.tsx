"use client";

import { useEffect, useState } from "react";
import { relativeTime } from "@/lib/format";

/**
 * "12m ago", recomputed in the browser. Pages are served from the CDN for
 * up to a minute and a half after they were rendered (lib/cache-policy.ts),
 * so text computed at render time can trail the clock by that much; this
 * keeps it true at the moment it is read, and keeps ticking while the tab
 * stays open.
 *
 * The first render prints the server's text unchanged, so hydration always
 * matches; the browser's own value replaces it in an effect.
 */
export function LiveRelativeTime({ iso, initial }: { iso: string | null; initial: string }) {
  const [text, setText] = useState(initial);

  useEffect(() => {
    if (!iso) return;
    // The pipeline writes UTC. A stamp without a zone is read as UTC, as the
    // server (running in UTC) read it, not in the reader's local time.
    const utc = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso.replace(" ", "T")}Z`;
    const update = () => setText(relativeTime(utc));
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [iso]);

  return <>{text}</>;
}
