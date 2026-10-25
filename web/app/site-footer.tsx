import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandMark, Wordmark } from "./brand";
import { LiveRelativeTime } from "./live-relative-time";
import { StatusNote } from "./ui";

const SOURCES = [
  {
    name: "US House Clerk",
    href: "https://disclosures-clerk.house.gov/FinancialDisclosure",
    what: "Periodic transaction reports (STOCK Act), parsed from the filed PDFs",
  },
  {
    name: "US Senate eFD",
    href: "https://efdsearch.senate.gov/",
    what: "Periodic transaction reports (STOCK Act), read from each electronic report",
  },
  {
    name: "SEC EDGAR",
    href: "https://www.sec.gov/edgar/search/",
    what: "Form 4 filings: corporate insiders' open-market buys and sells",
  },
];

/** The reader sections, as in the masthead, plus search. */
const SECTIONS = [
  { href: "/", label: "Feed" },
  { href: "/politicians", label: "Members" },
  { href: "/tickers", label: "Tickers" },
  { href: "/insiders", label: "Insiders" },
  { href: "/trends", label: "Trends" },
  { href: "/search", label: "Search" },
];

/**
 * How the data is made and kept: the operator pages that left the masthead
 * (Pipeline, Scans, Alerts) and the reference pages. A Contact page joins
 * this list when it exists.
 */
const ABOUT = [
  { href: "/methodology", label: "Methodology", note: "how to read and quote the data" },
  { href: "/pipeline", label: "Pipeline", note: "sources, coverage, run status" },
  { href: "/scans", label: "Scanned filings", note: "paper filings, page by page" },
  { href: "/alerts", label: "Alert log", note: "every cluster alert sent" },
  { href: "/methodology#machines", label: "API and data", note: "JSON, Markdown, CSV" },
];

/** The footer's last row: the pages that govern using the site. */
const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

// apple.com's footer: 12px grey text, the column heads semibold in ink,
// hairline separators, links that underline on hover.
const HEAD = "mb-2.5 text-[12px] font-semibold text-foreground";
const LINK =
  "rounded-sm text-muted-foreground underline decoration-transparent underline-offset-[3px] transition-colors duration-150 hover:text-foreground hover:decoration-current";

/**
 * Masthead, sections, "About the data", sources, and the caveats that govern
 * every figure on the site. Each note under "Reading the numbers" is
 * deliberate (see CLAUDE.md, "amounts are ranges"): restructure it freely,
 * but do not drop one.
 *
 * Data freshness lives here as one quiet line — "Updated 2h ago" — measured
 * from the pipeline's last run (`getPipeline().lastUpdated`, the same clock
 * as /api/health), not from the last filing that changed.
 */
export function SiteFooter({
  transactions,
  insiderTrades,
  updated,
  updatedAt,
  stale,
}: {
  transactions: number;
  insiderTrades: number;
  /** Server-rendered relative time of the last pipeline run. */
  updated: string;
  updatedAt: string | null;
  /** Past STALE_AFTER_HOURS (lib/health.ts): said in words, not only colour. */
  stale: boolean;
}) {
  return (
    <footer className="border-t border-border bg-fill/35">
      <div className="mx-auto max-w-[1080px] px-4 pb-12 pt-10 sm:px-6 sm:pb-16 sm:pt-12">
        <div className="grid gap-x-10 gap-y-8 text-[12px] leading-relaxed text-muted-foreground sm:grid-cols-2 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.7fr)_minmax(0,1.1fr)_minmax(0,1.25fr)]">
          <div className="space-y-3.5">
            <Link href="/" className="inline-flex items-center gap-2.5 rounded-control" aria-label="FatCat Watch — feed">
              <span className="flex size-7 items-center justify-center rounded-[8px] bg-card shadow-2xs ring-1 ring-border">
                <BrandMark className="size-[18px]" />
              </span>
              <Wordmark className="text-[16px]" />
            </Link>
            <p className="max-w-[44ch]">
              {transactions ? (
                <>
                  <span className="tabular font-medium text-ink-2">{transactions.toLocaleString("en-US")}</span> congressional
                  {insiderTrades ? (
                    <>
                      {" "}
                      and <span className="tabular font-medium text-ink-2">{insiderTrades.toLocaleString("en-US")}</span> corporate-insider
                    </>
                  ) : null}{" "}
                  stock trades, reproduced as filed.
                </>
              ) : (
                <>US congressional and corporate-insider stock trades, reproduced as filed.</>
              )}{" "}
              Dates that contradict each other are flagged, not corrected.
            </p>
            <div className="pt-0.5 tabular text-[12px]">
              <Link
                href="/pipeline"
                className={cn(
                  "inline-flex items-center gap-2 rounded-full bg-card px-3 py-1 text-[11.5px] font-medium text-ink-2 shadow-2xs ring-1 ring-border transition-colors hover:text-foreground"
                )}
                title={updatedAt ? `Last pipeline run: ${updatedAt} UTC` : undefined}
              >
                <span className={cn("size-1.5 rounded-full", stale ? "bg-attention" : "bg-ok")} aria-hidden />
                <span>
                  Updated <LiveRelativeTime iso={updatedAt} initial={updated} />
                </span>
              </Link>
              {stale ? (
                <span className="mt-1.5 block text-foreground">
                  <StatusNote tone="attention">the pipeline is behind schedule</StatusNote>
                </span>
              ) : null}
            </div>
          </div>

          {/* Not "Sections": the masthead's nav owns that name (e2e looks it up). */}
          <nav aria-label="Browse">
            <h2 className={HEAD}>Sections</h2>
            <ul className="space-y-2">
              {SECTIONS.map((s) => (
                <li key={s.href}>
                  <Link href={s.href} className={LINK}>
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="About the data">
            <h2 className={HEAD}>About the data</h2>
            <ul className="space-y-2.5">
              {ABOUT.map((a) => (
                <li key={a.href} className="leading-snug">
                  <Link href={a.href} className={cn(LINK, "font-medium text-ink-2")}>
                    {a.label}
                  </Link>
                  <span className="block text-[11.5px]">{a.note}</span>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            <h2 className={HEAD}>Sources</h2>
            <ul className="space-y-2.5">
              {SOURCES.map((s) => (
                <li key={s.name} className="leading-snug">
                  <a href={s.href} target="_blank" rel="noreferrer" className={cn(LINK, "inline-flex items-center gap-0.5 font-medium text-ink-2")}>
                    {s.name}
                    <ArrowUpRight className="size-3 opacity-60" aria-hidden />
                  </a>
                  <span className="block text-[11.5px]">{s.what}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <section aria-labelledby="footer-numbers" className="mt-10 border-t border-border pt-7">
          <h2 id="footer-numbers" className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Reading the numbers
          </h2>
          <dl className="grid gap-4 text-[12px] leading-relaxed text-muted-foreground md:grid-cols-3">
            <div className="rounded-[18px] bg-card/80 p-4 ring-1 ring-border/70">
              <dt className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">Congressional amounts are ranges</dt>
              <dd className="mt-1.5">
                Members disclose an <strong className="font-semibold text-ink-2">amount bracket</strong>, not an exact
                figure — every congressional total here is a range, and any midpoint is an estimate. The open-ended top
                bracket is shown as ≥ its floor.
              </dd>
            </div>
            <div className="rounded-[18px] bg-card/80 p-4 ring-1 ring-border/70">
              <dt className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">Insider values are computed</dt>
              <dd className="mt-1.5">
                <strong className="font-semibold text-ink-2">Shares × the reported price</strong>, which the filer may
                state as a weighted average. Congressional and insider figures are never added together.
              </dd>
            </div>
            <div className="rounded-[18px] bg-card/80 p-4 ring-1 ring-border/70">
              <dt className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">Paper filings stay out of totals</dt>
              <dd className="mt-1.5">
                Scanned paper filings in either chamber never enter a volume figure: House scans are transcribed and
                labelled wherever they appear, Senate paper filings are not read. See{" "}
                <Link href="/pipeline" className="ink-link text-ink-2">
                  Pipeline
                </Link>{" "}
                and{" "}
                <Link href="/scans" className="ink-link text-ink-2">
                  Scanned filings
                </Link>
                .
              </dd>
            </div>
          </dl>
        </section>

        <div className="mt-8 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-border pt-5 text-[12px] text-muted-foreground">
          <p>Public disclosures, shown for information — not investment advice.</p>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-1">
            {LEGAL_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className={LINK}>
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
