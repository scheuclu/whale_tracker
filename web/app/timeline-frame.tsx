"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { TIP_SURFACE } from "./charts";
import { ScrollX } from "./scroll-area";

type Tip = { left: number; top: number; below: boolean; head: string; value: string; meta: string; note: string };

const TIP_HALF = 150;

/**
 * The interactive layer around the server-rendered timeline SVG.
 *
 * - One tooltip for hover and keyboard focus alike, read from each mark's
 *   `data-tip-*` attributes and inserted as text (never HTML): the value
 *   leads, the member or ticker and the date follow. It enhances only —
 *   every trade is also in the list under the chart.
 * - The marks are one tab stop: arrow keys walk them in date order (Home /
 *   End jump to the first / latest), Enter follows the link.
 * - On a phone the chart is wider than the screen; it opens scrolled to the
 *   latest trades, the end a reader usually wants first.
 */
export function TimelineFrame({ children }: { children: React.ReactNode }) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const vp = viewport.current;
    if (vp && vp.scrollWidth > vp.clientWidth) vp.scrollLeft = vp.scrollWidth;
  }, []);

  const show = (target: EventTarget | null) => {
    const el = target instanceof Element ? target.closest<SVGElement>("[data-tip-value]") : null;
    const box = wrap.current;
    if (!el || !box) {
      setTip(null);
      return;
    }
    const shape = el.querySelector("[data-shape]") ?? el;
    const r = shape.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const cx = r.left + r.width / 2 - b.left;
    const top = r.top - b.top;
    const below = top < 84;
    setTip({
      left: Math.min(Math.max(cx, Math.min(TIP_HALF, b.width / 2)), Math.max(b.width - TIP_HALF, b.width / 2)),
      top: below ? r.bottom - b.top : top,
      below,
      head: el.dataset.tipHead ?? "",
      value: el.dataset.tipValue ?? "",
      meta: el.dataset.tipMeta ?? "",
      note: el.dataset.tipNote ?? "",
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const current = (e.target as Element).closest?.("a.tl-mark");
    if (!current) return;
    const svg = current.closest("svg");
    if (!svg) return;
    const marks = Array.from(svg.querySelectorAll<SVGAElement>("a.tl-mark"));
    const i = marks.indexOf(current as SVGAElement);
    let next = i;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(i + 1, marks.length - 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(i - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = marks.length - 1;
    else return;
    e.preventDefault();
    if (next === i) return;
    marks[i].setAttribute("tabindex", "-1");
    marks[next].setAttribute("tabindex", "0");
    marks[next].focus();
  };

  return (
    <div
      ref={wrap}
      className="relative"
      onPointerOver={(e) => show(e.target)}
      onPointerLeave={() => setTip(null)}
      onFocus={(e) => show(e.target)}
      onBlur={() => setTip(null)}
      onKeyDown={onKeyDown}
    >
      <ScrollX viewportRef={viewport}>{children}</ScrollX>
      {tip ? (
        <div
          role="tooltip"
          className={cn(TIP_SURFACE, "pointer-events-none absolute z-20 w-max max-w-[300px] px-3 py-2")}
          style={{
            left: tip.left,
            top: tip.top,
            transform: tip.below ? "translate(-50%, 10px)" : "translate(-50%, calc(-100% - 10px))",
          }}
        >
          <div className="tabular text-[13px] font-semibold text-foreground">{tip.value}</div>
          <div className="truncate text-ink-2">{tip.head}</div>
          <div className="text-muted-foreground">{tip.meta}</div>
          {tip.note ? <div className="mt-1 text-muted-foreground">{tip.note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
