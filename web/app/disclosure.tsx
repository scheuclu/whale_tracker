import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "How to read this": an explanation whose first sentence stays in view and
 * whose detail waits behind a native `<details>`. Native on purpose — it
 * opens with Enter or Space, needs no JavaScript, and the collapsed text is
 * still in the document (and in find-in-page), so a caveat moved in here is
 * still on the page, only folded.
 *
 * Every caveat on this site is load-bearing (CLAUDE.md: amounts are ranges,
 * midpoints are estimates, insider values are shares × reported price,
 * transcribed rows are quarantined). Folding one away is allowed; deleting
 * one is not. Put the sentence a reader must not miss in `lead`.
 *
 *   <Disclosure lead="The band is the full range these disclosures permit.">
 *     <p>The tick is the midpoint estimate…</p>
 *   </Disclosure>
 */
export function Disclosure({
  lead,
  children,
  summary = "How to read this",
  size = "md",
  className,
}: {
  /** Always visible: the one sentence that must survive a skim. */
  lead?: React.ReactNode;
  /** Folded detail. Omit for a lead-only note at the same measure. */
  children?: React.ReactNode;
  summary?: string;
  /** `md` for a page or section intro, `sm` for a footnote under a chart or table. */
  size?: "md" | "sm";
  className?: string;
}) {
  return (
    <div
      data-disclosure
      className={cn(
        "max-w-[68ch] text-muted-foreground",
        size === "sm" ? "text-[12px] leading-relaxed" : "text-[14px] leading-relaxed",
        className
      )}
    >
      {lead ? <p>{lead}</p> : null}
      {children ? (
        <details className={cn("group/disclosure", lead ? "mt-1" : undefined)}>
          <summary
            className={cn(
              "inline-flex cursor-pointer select-none list-none items-center gap-1 rounded-md py-0.5 pr-1 font-medium text-ink-2",
              "transition-colors duration-150 ease-out hover:text-foreground motion-reduce:transition-none",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "[&::-webkit-details-marker]:hidden",
              size === "sm" ? "text-[12px]" : "text-[13px]"
            )}
          >
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0 transition-transform duration-150 ease-out group-open/disclosure:rotate-90 motion-reduce:transition-none"
            />
            {summary}
          </summary>
          <div className="mt-2 space-y-2 border-l border-border pl-3">{children}</div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The caption under every disclosed-volume band (member and ticker pages).
 * Short enough to stay whole; it only needs the reading measure.
 */
export function RangeCaption() {
  return (
    <Disclosure
      size="sm"
      className="mt-3"
      lead="The band is the full range these disclosures permit; the tick is the midpoint estimate. Members report brackets, so the true figure lies somewhere in the band."
    />
  );
}
