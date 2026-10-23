import { cn } from "@/lib/utils";

/**
 * The top of a ticker's or an insider issuer's page, set like the member
 * page's contact card (`MemberHero`, politicians/member-hero.tsx) so every
 * detail page opens the same way: a mark, the name large and bold, one grey
 * line of identity, one plain-language line computed from the whole record,
 * a quiet facts line, then the page's actions as capsules.
 *
 * A security has no portrait, so the mark is what iOS draws for a contact
 * without a photo — the letters on a grey tile — but a rounded square, not
 * a circle, so a symbol never reads as a person. Neutral in both modes;
 * nothing here is a dollar figure.
 */
export function SymbolHero({
  symbol,
  identity,
  badges,
  summary,
  facts,
  actions,
}: {
  /** The ticker; also the h1. */
  symbol: string;
  /** "Microsoft Corporation" — the grey line under the title. */
  identity?: React.ReactNode;
  /** Asset-type and sector chips. */
  badges?: React.ReactNode;
  /** One sentence in plain language, from the whole record. */
  summary?: React.ReactNode;
  /** A quiet tabular line: counts, the last trade. */
  facts?: React.ReactNode;
  /** Capsule buttons: share, cross-links. */
  actions?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col items-center text-center">
      <SymbolMark symbol={symbol} />
      <h1 className="display mt-4 max-w-full break-words text-[32px] leading-[1.1] sm:mt-5 sm:text-[44px] sm:leading-[1.05]">
        {symbol}
      </h1>
      {identity ? (
        <p className="mt-1.5 max-w-[40ch] text-balance text-[17px] leading-snug text-muted-foreground sm:text-[19px]">
          {identity}
        </p>
      ) : null}
      {badges ? <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">{badges}</div> : null}
      {summary ? (
        <p className="mt-3 max-w-[46ch] text-pretty text-[15px] leading-normal text-ink-2 first-letter:uppercase sm:text-[16px]">
          {summary}
        </p>
      ) : null}
      {facts ? <p className="tabular mt-0.5 text-[13px] text-muted-foreground sm:text-[14px]">{facts}</p> : null}
      {actions ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </section>
  );
}

/** The letters set to fill the tile: shorter symbols larger. */
const MARK_TYPE = [
  "text-[40px] sm:text-[50px]",
  "text-[34px] sm:text-[42px]",
  "text-[27px] sm:text-[34px]",
  "text-[22px] sm:text-[27px]",
  "text-[18px] sm:text-[22px]",
];

/** A symbol's mark: its letters on a neutral rounded square, 96px (120px from 640px). */
export function SymbolMark({ symbol, className }: { symbol: string; className?: string }) {
  const len = symbol.length;
  const type = MARK_TYPE[Math.min(Math.max(len - 2, 0), MARK_TYPE.length - 1)];
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-[96px] shrink-0 select-none items-center justify-center overflow-hidden rounded-[28%] sm:size-[120px]",
        "bg-[color-mix(in_oklab,var(--foreground)_6%,var(--card-solid))] text-[color-mix(in_oklab,var(--foreground)_62%,var(--card-solid))]",
        "dark:bg-[color-mix(in_oklab,var(--foreground)_9%,var(--card-solid))] dark:text-[color-mix(in_oklab,var(--foreground)_70%,var(--card-solid))]",
        className
      )}
    >
      <span className={cn("figure px-2 font-semibold leading-none tracking-[-0.03em]", type)}>{symbol}</span>
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]" />
    </span>
  );
}
