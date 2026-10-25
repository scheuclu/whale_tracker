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
    <section className="apple-hero-surface apple-card-reveal relative flex flex-col items-center overflow-hidden rounded-[28px] px-5 py-8 text-center sm:px-10 sm:py-11">
      <SymbolMark symbol={symbol} />
      {badges ? <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">{badges}</div> : null}
      <h1 className="display mt-3 max-w-full break-words text-[34px] leading-[1.06] tracking-[-0.032em] sm:text-[48px] sm:leading-[1.03]">
        {symbol}
      </h1>
      {identity ? (
        <p className="mt-1.5 max-w-[44ch] text-balance text-[17px] font-medium leading-snug text-muted-foreground sm:text-[20px]">
          {identity}
        </p>
      ) : null}
      {summary ? (
        <p className="mt-3 max-w-[50ch] text-pretty text-[16px] leading-[1.45] text-ink-2 first-letter:uppercase sm:text-[18px]">
          {summary}
        </p>
      ) : null}
      {facts ? <p className="tabular mt-1.5 text-[13px] font-medium text-muted-foreground sm:text-[14px]">{facts}</p> : null}
      {actions ? <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">{actions}</div> : null}
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

/** A symbol's mark: its letters on a neutral iOS app-icon squircle, 96px (116px from 640px). */
export function SymbolMark({ symbol, className }: { symbol: string; className?: string }) {
  const len = symbol.length;
  const type = MARK_TYPE[Math.min(Math.max(len - 2, 0), MARK_TYPE.length - 1)];
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-[96px] shrink-0 select-none items-center justify-center overflow-hidden rounded-[26%] sm:size-[116px]",
        "bg-[linear-gradient(180deg,color-mix(in_oklab,var(--foreground)_5%,var(--card-solid)),color-mix(in_oklab,var(--foreground)_10%,var(--card-solid)))]",
        "text-[color-mix(in_oklab,var(--foreground)_72%,var(--card-solid))]",
        "dark:bg-[linear-gradient(180deg,color-mix(in_oklab,var(--foreground)_13%,var(--card-solid)),color-mix(in_oklab,var(--foreground)_7%,var(--card-solid)))]",
        "dark:text-[color-mix(in_oklab,var(--foreground)_78%,var(--card-solid))]",
        "shadow-[0_10px_28px_-6px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.75)] dark:shadow-[0_12px_32px_-6px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.16)]",
        className
      )}
    >
      <span className={cn("figure px-2 font-semibold leading-none tracking-[-0.03em]", type)}>{symbol}</span>
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-black/[0.08] dark:ring-white/[0.1]" />
    </span>
  );
}
