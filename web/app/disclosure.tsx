import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "How to read this" — the site's one home for caveats (DESIGN.md): say a
 * caveat once, here, rather than as a grey sentence under every widget.
 * An explanation whose first sentence stays in view and
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
  // `md` is a reader's note: a gold rule down the left (the one place the
  // accent marks content rather than navigation), the lead in the serif.
  // `sm` is a chart footnote: muted sans, no rule — present, never loud.
  return (
    <div
      data-disclosure
      className={cn(
        "max-w-[68ch]",
        size === "sm"
          ? "text-[12.5px] leading-relaxed text-muted-foreground"
          : "border-l-2 border-gold py-0.5 pl-4 text-[14px] leading-relaxed text-ink-2",
        className
      )}
    >
      {lead ? <p className={size === "md" ? "font-serif text-[16px] leading-normal text-ink-2" : undefined}>{lead}</p> : null}
      {children ? (
        <details className={cn("group/disclosure", lead ? (size === "md" ? "mt-1.5" : "mt-1") : undefined)}>
          <summary
            className={cn(
              "inline-flex cursor-pointer select-none list-none items-center gap-1 rounded-sm py-0.5 pr-1 font-medium text-ink-2",
              "underline decoration-transparent underline-offset-[3px] transition-colors duration-150 ease-out hover:text-foreground hover:decoration-gold motion-reduce:transition-none",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "[&::-webkit-details-marker]:hidden",
              size === "sm" ? "text-[12.5px]" : "text-[13px]"
            )}
          >
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0 transition-transform duration-150 ease-out group-open/disclosure:rotate-90 motion-reduce:transition-none"
            />
            {summary}
          </summary>
          <div
            className={cn(
              "mt-2 space-y-2",
              size === "sm" ? "border-l border-border pl-3" : "text-muted-foreground"
            )}
          >
            {children}
          </div>
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
