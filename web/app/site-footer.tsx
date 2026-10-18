import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { WhaleMark, Wordmark } from "./brand";

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

/**
 * Sources and the caveats that govern every figure on the site. Each note
 * here is deliberate (see CLAUDE.md, "amounts are ranges"): restructure it
 * freely, but do not drop one.
 */
export function SiteFooter() {
  return (
    <footer className="mx-auto max-w-6xl px-4 pb-12 sm:px-6">
      <div className="rule-fade mb-8" />
      <div className="grid gap-8 text-xs leading-relaxed text-muted-foreground md:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.4fr)] md:gap-10">
        <div className="space-y-3">
          <div className="flex items-center gap-2.5">
            <WhaleMark className="size-7" />
            <Wordmark className="text-sm text-foreground" />
          </div>
          <p>
            US congressional and corporate-insider stock trades, reproduced as filed. Dates that
            contradict each other are flagged, not corrected.
          </p>
          <Link
            href="/pipeline"
            className="inline-flex items-center gap-1 font-medium text-foreground/80 transition-colors hover:text-primary"
          >
            Pipeline status and coverage
            <ArrowRight className="size-3" aria-hidden />
          </Link>
          <Link href="/methodology" className="flex items-center gap-1 font-medium text-foreground/80 transition-colors hover:text-primary">Methodology and how to quote the data<ArrowRight className="size-3" aria-hidden /></Link>
        </div>

        <div>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/70">
            Sources
          </h2>
          <ul className="space-y-2.5">
            {SOURCES.map((s) => (
              <li key={s.name}>
                <a
                  href={s.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 font-medium text-foreground/85 transition-colors hover:text-primary"
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
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/70">
            Reading the numbers
          </h2>
          <dl className="space-y-2.5">
            <div>
              <dt className="font-medium text-foreground/85">Congressional amounts are ranges</dt>
              <dd>
                Members disclose an <strong className="font-semibold text-foreground/85">amount bracket</strong>, not
                an exact figure — every congressional total here is a range, and any midpoint is an
                estimate. The open-ended top bracket is shown as ≥ its floor.
              </dd>
            </div>
            <div>
              <dt className="font-medium text-foreground/85">Insider values are computed</dt>
              <dd>
                <strong className="font-semibold text-foreground/85">Shares × the reported price</strong>, which the
                filer may state as a weighted average.
              </dd>
            </div>
            <div>
              <dt className="font-medium text-foreground/85">Paper filings stay out of totals</dt>
              <dd>
                Scanned paper filings in either chamber never enter a volume figure: House scans are
                transcribed and labelled wherever they appear, Senate paper filings are not read. See{" "}
                <Link href="/pipeline" className="underline decoration-border underline-offset-2 hover:text-primary">
                  Pipeline
                </Link>{" "}
                and{" "}
                <Link href="/scans" className="underline decoration-border underline-offset-2 hover:text-primary">
                  Scans
                </Link>
                .
              </dd>
            </div>
          </dl>
        </div>
      </div>
      <p className="mt-8 text-[11px] text-muted-foreground/80">
        Public disclosures, shown for information — not investment advice.
      </p>
    </footer>
  );
}
