"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { stickyShift } from "@/lib/sticky-head";

/**
 * The header row of a leaderboard, kept in view below the site header.
 *
 * `position: sticky` resolves against the nearest scrolling ancestor, and a
 * `ResponsiveTable` is one: its viewport scrolls sideways. So there are two
 * modes, chosen from the live geometry and written to `data-sticky` on the
 * table (globals.css does the rest):
 *
 * - `css` — the table fits its card (a laptop). The wrapper's overflow is
 *   lifted and the header cells stick to the page in pure CSS, compositor
 *   smooth.
 * - `shift` — the table is wider than its card (a phone) and must keep its
 *   horizontal scroll, so the header cells are translated down by however far
 *   the table top has gone under the site header, clamped to the table.
 *
 * Without JavaScript neither applies and the header simply scrolls away; the
 * table, its sort links and its row links all work regardless.
 */
export function StickyThead({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLTableSectionElement | null>(null);

  useEffect(() => {
    const thead = ref.current;
    const table = thead?.parentElement as HTMLTableElement | null;
    if (!thead || !table) return;
    const viewport = table.closest(".scroll-x-viewport") as HTMLElement | null;
    const site = siteHeader();
    let top = 0;
    let mode: "css" | "shift" = "css";

    const place = () => {
      if (mode !== "shift") return;
      const r = table.getBoundingClientRect();
      const shift = stickyShift({ top, tableTop: r.top, tableHeight: r.height, headHeight: thead.offsetHeight });
      table.style.setProperty("--thead-shift", `${shift}px`);
    };

    const measure = () => {
      top = site ? Math.max(0, Math.round(site.getBoundingClientRect().bottom)) : 0;
      table.style.setProperty("--sticky-top", `${top}px`);
      // The same edge for the section's anchor (`.table-anchor`), so a
      // re-sort that jumps to #all-members lands clear of the site header.
      document.documentElement.style.setProperty("--table-anchor-top", `${top}px`);
      // Compared against the viewport's width, not its scrollWidth: in css
      // mode the viewport no longer scrolls, so scrollWidth means nothing.
      const overflowing = viewport ? table.offsetWidth - viewport.clientWidth > 1 : false;
      mode = overflowing ? "shift" : "css";
      if (table.dataset.sticky !== mode) table.dataset.sticky = mode;
      if (mode === "css") table.style.removeProperty("--thead-shift");
      place();
    };

    measure();
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : undefined;
    ro?.observe(table);
    if (viewport) ro?.observe(viewport);
    if (site) ro?.observe(site);
    return () => {
      window.removeEventListener("scroll", place);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
      delete table.dataset.sticky;
    };
  }, []);

  return (
    <thead ref={ref} className={className}>
      {children}
    </thead>
  );
}

/**
 * A sort link. Its href carries the table section's #fragment, which is what
 * a no-JS reload uses to land back on the table. With JS the navigation is a
 * client transition, and the router's own fragment handling lands somewhere
 * between the old and new layout; so it is done here instead: if the reader
 * is down inside the table, the page goes to the table's top — the first rows
 * of the new order — and otherwise it stays exactly where it is.
 */
export function SortLink({
  href,
  className,
  children,
  jump = true,
  ...rest
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
  /** false: never move the page (a "show more" under the table). */
  jump?: boolean;
} & React.AriaAttributes) {
  const router = useRouter();
  return (
    <a
      href={href}
      className={className}
      {...rest}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        const [path, hash] = href.split("#");
        const section = hash ? document.getElementById(hash) : null;
        if (section && jump) {
          const anchor = parseFloat(getComputedStyle(section).scrollMarginTop) || 0;
          const top = section.getBoundingClientRect().top;
          if (top < anchor) window.scrollTo({ top: window.scrollY + top - anchor });
        }
        router.push(path, { scroll: false });
      }}
    >
      {children}
    </a>
  );
}

/** The page's own sticky header, if it has one: the table header parks under it. */
function siteHeader(): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll("header"))) {
    const pos = getComputedStyle(el).position;
    if (pos === "sticky" || pos === "fixed") return el;
  }
  return null;
}

/**
 * A table body whose rows are click targets. Each row still carries a real
 * `<a>` to the same place — that link is what keyboards, screen readers and
 * no-JS readers use; this only widens the pointer target to the whole row.
 * Clicks on any other link or control in the row, and drags that select
 * text, are left alone. Cmd/Ctrl-click and middle-click open a new tab, as
 * the link itself would.
 */
export function RowLinkBody({ children, className }: { children: React.ReactNode; className?: string }) {
  const router = useRouter();

  const target = (e: React.MouseEvent): string | null => {
    const el = e.target as HTMLElement;
    if (el.closest("a, button, input, select, textarea, summary, [role=button]")) return null;
    if (window.getSelection()?.toString()) return null;
    return (el.closest("tr[data-href]") as HTMLElement | null)?.dataset.href ?? null;
  };

  return (
    <tbody
      className={className}
      onClick={(e) => {
        if (e.button !== 0) return;
        const href = target(e);
        if (!href) return;
        if (e.metaKey || e.ctrlKey) window.open(href, "_blank", "noopener");
        else router.push(href);
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        const href = target(e);
        if (href) window.open(href, "_blank", "noopener");
      }}
    >
      {children}
    </tbody>
  );
}
