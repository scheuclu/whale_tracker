"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { sameEdges, scrollEdges, type ScrollEdges } from "@/lib/scroll-edges";

const FITS: ScrollEdges = { overflow: false, atStart: true, atEnd: true };

/**
 * A horizontal scroll container that says so: when its content is wider than
 * the viewport, an edge fade appears on whichever side has more to show, and
 * disappears once that side is reached. Styling is in globals.css under
 * `.scroll-x`, keyed off the `data-*` attributes set here; the server renders
 * it as "fits" and the fades appear after hydration, so a table that fits on a
 * laptop never flashes one.
 *
 * `stickyFirstColumn` pins the first cell of every row of a table inside, so a
 * ticker or member name stays readable while the numbers scroll under it.
 */
export function ScrollX({
  children,
  className,
  viewportClassName,
  stickyFirstColumn = false,
  viewportRef,
}: {
  children: React.ReactNode;
  className?: string;
  viewportClassName?: string;
  stickyFirstColumn?: boolean;
  /** Set when a caller needs the scrolling element itself (the nav scrolls its active tab into view). */
  viewportRef?: RefObject<HTMLDivElement | null>;
}) {
  const inner = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>(FITS);

  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const update = () => {
      const next = scrollEdges(el);
      setEdges((prev) => (sameEdges(prev, next) ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(update);
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);

  const setRefs = (node: HTMLDivElement | null) => {
    inner.current = node;
    if (viewportRef) viewportRef.current = node;
  };

  return (
    <div
      className={cn("scroll-x", className)}
      data-overflow={String(edges.overflow)}
      data-at-start={String(edges.atStart)}
      data-at-end={String(edges.atEnd)}
      data-sticky-col={stickyFirstColumn ? "true" : undefined}
    >
      {/* Focusable only while it actually scrolls, so a keyboard can reach the far columns without adding a tab stop to every table that fits. */}
      <div
        ref={setRefs}
        className={cn("scroll-x-viewport", viewportClassName)}
        tabIndex={edges.overflow ? 0 : undefined}
      >
        {children}
      </div>
    </div>
  );
}
