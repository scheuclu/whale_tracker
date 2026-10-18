import { cn } from "@/lib/utils";

/**
 * A formatted dollar string (`usd`/`range` output) set for reading: the
 * figures in tabular numerals at full ink, the currency sign and the unit
 * suffix (k, M, B, T) lighter, the en dash spaced by a hair. Only the
 * styling changes — the text content is exactly the string passed in, so
 * "$15k–$50k" or "≥$50M" copies, reads to a screen reader and tests the same.
 *
 * Takes the string rather than cents on purpose: the bracket semantics (an
 * open top bracket is "≥floor", an exact figure is one number) live in
 * `lib/format.ts` and stay there.
 */
const TOKEN = /(\$|[kMBT](?![a-z])|–|≥)/;

export function MoneyText({ value, className }: { value: string; className?: string }) {
  const parts = value.split(TOKEN).filter((p) => p !== "");
  return (
    <span className={cn("tabular whitespace-nowrap", className)}>
      {parts.map((p, i) => {
        if (p === "$" || /^[kMBT]$/.test(p)) {
          return (
            <span key={i} className={cn("font-normal text-muted-foreground", p !== "$" && "text-[0.93em]")}>
              {p}
            </span>
          );
        }
        if (p === "–") {
          return (
            <span key={i} className="text-muted-foreground">
              {p}
            </span>
          );
        }
        if (p === "≥") {
          return (
            <span key={i} className="pr-px text-muted-foreground">
              {p}
            </span>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </span>
  );
}
