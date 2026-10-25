"use client";

import React from "react";
import { segmentClass, SEGMENT_TRACK } from "./ui";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";

/**
 * A segmented control of links: the state is the URL, so each option is a
 * plain `<a>` and the active one carries `aria-current`. Use it for every
 * All/Buys/Sells, window or kind switch so they look and behave as one.
 * Client component so click events are tracked in Vercel Web Analytics.
 */
export function SegmentedNav({
  label,
  items,
  className,
}: {
  /** Names the group for assistive tech ("Trade direction"). */
  label: string;
  items: { key: string; label: React.ReactNode; href: string; active: boolean; dot?: string }[];
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn(SEGMENT_TRACK, className)}>
      {items.map((it) => (
        <a
          key={it.key}
          href={it.href}
          aria-current={it.active ? "page" : undefined}
          className={segmentClass(it.active)}
          onClick={() => trackEvent("segment_toggle", { group: label, key: it.key })}
        >
          {it.dot ? <span className="size-1.5 rounded-full" style={{ background: it.dot }} aria-hidden /> : null}
          {it.label}
        </a>
      ))}
    </nav>
  );
}
