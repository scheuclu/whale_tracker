import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { BrandMark, Wordmark } from "./brand";

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

/** The footer's last row: the pages that govern using the site. */
const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];

/**
 * Sources and the caveats that govern every figure on the site. Each note
 * here is deliberate (see CLAUDE.md, "amounts are ranges"): restructure it
 * freely, but do not drop one.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 pb-10 pt-8 sm:px-6 sm:pb-12 sm:pt-10">
        <div className="grid gap-8 text-xs leading-relaxed text-muted-foreground md:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.4fr)] md:gap-12">
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <BrandMark className="size-7" />
              <Wordmark className="text-sm text-foreground" />
            </div>
            <p className="max-w-[40ch]">
              US congressional and corporate-insider stock trades, reproduced as filed. Dates that
              contradict each other are flagged, not corrected.
            </p>
            <Link
              href="/pipeline"
              className="inline-flex items-center gap-1 rounded-sm font-medium text-ink-2 transition-colors duration-150 hover:text-primary"
            >
              Pipeline status and coverage
              <ArrowRight className="size-3" aria-hidden />
            </Link>
            <Link
              href="/methodology"
              className="inline-flex items-center gap-1 rounded-sm font-medium text-ink-2 transition-colors duration-150 hover:text-primary"
            >
              Methodology and how to quote the data
              <ArrowRight className="size-3" aria-hidden />
            </Link>
            <Link href="/contact" className="inline-flex items-center gap-1 rounded-sm font-medium text-ink-2 transition-colors duration-150 hover:text-primary">
              Contact — report a data error, press, feedback
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>

          <div>
            <h2 className="mb-3 text-xs font-semibold text-foreground">
              Sources
            </h2>
            <ul className="space-y-3">
              {SOURCES.map((s) => (
                <li key={s.name}>
                  <a
                    href={s.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 rounded-sm font-medium text-ink-2 transition-colors duration-150 hover:text-primary"
                  >
                    {s.name}
                    <ArrowUpRight className="size-3 opacity-60" aria-hidden />
                  </a>
                  <div>{s.what}</div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="mb-3 text-xs font-semibold text-foreground">
              Reading the numbers
            </h2>
            <dl className="space-y-3">
              <div>
                <dt className="font-medium text-ink-2">Congressional amounts are ranges</dt>
                <dd>
                  Members disclose an <strong className="font-semibold text-ink-2">amount bracket</strong>, not
                  an exact figure — every congressional total here is a range, and any midpoint is an
                  estimate. The open-ended top bracket is shown as ≥ its floor.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink-2">Insider values are computed</dt>
                <dd>
                  <strong className="font-semibold text-ink-2">Shares × the reported price</strong>, which the
                  filer may state as a weighted average.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink-2">Paper filings stay out of totals</dt>
                <dd>
                  Scanned paper filings in either chamber never enter a volume figure: House scans are
                  transcribed and labelled wherever they appear, Senate paper filings are not read. See{" "}
                  <Link href="/pipeline" className="rounded-sm underline decoration-border-strong underline-offset-2 transition-colors duration-150 hover:text-primary hover:decoration-primary/50">
                    Pipeline
                  </Link>{" "}
                  and{" "}
                  <Link href="/scans" className="rounded-sm underline decoration-border-strong underline-offset-2 transition-colors duration-150 hover:text-primary hover:decoration-primary/50">
                    Scans
                  </Link>
                  .
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <div className="mt-8 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-border pt-5 text-xs text-muted-foreground">
          <p>Public disclosures, shown for information — not investment advice.</p>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-4 gap-y-1">
            {LEGAL_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-sm font-medium text-ink-2 transition-colors duration-150 hover:text-primary"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
