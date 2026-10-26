import { SymbolMark } from "./symbol-mark";

export { SymbolMark };

/**
 * The top of a ticker's or an insider issuer's page, set like the member
 * page's contact card (`MemberHero`, politicians/member-hero.tsx) so every
 * detail page opens the same way: a mark, the name large and bold, one grey
 * line of identity, one plain-language line computed from the whole record,
 * a quiet facts line, then the page's actions as capsules.
 *
 * A security's mark (`SymbolMark`, app/symbol-mark.tsx) is a rounded square,
 * not a circle, so a symbol never reads as a person: it renders the company
 * logo proxied through `next/image` over the lettered monogram fallback.
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
    <section className="apple-hero-surface apple-card-reveal relative z-20 flex flex-col items-center rounded-[28px] px-5 py-8 text-center sm:px-10 sm:py-11">
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
