import Link from "next/link";
import { SectionTitle } from "./charts";
import { ChevronRight } from "lucide-react";
import { PAGE_STACK, PageHeader } from "./page-header";

/**
 * The frame /privacy and /terms share: a dated header, the short version
 * that must survive a skim, an index, then numbered sections at the
 * methodology page's measure.
 *
 * Both pages describe what the code does. When data collection changes — a
 * new script, a new stored field, a new processor — the privacy page changes
 * in the same PR and `updated` moves (CLAUDE.md, "Dashboard conventions").
 */

export type LegalSection = { id: string; title: string; body: React.ReactNode };

/** "22 October 2026", from an ISO date — fixed format, no locale drift between server and reader. */
function longDate(iso: string): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

export function LegalPage({
  title,
  subtitle,
  updated,
  summary,
  sections,
}: {
  title: string;
  subtitle: React.ReactNode;
  /** ISO date of the last substantive change. */
  updated: string;
  /** The short version, always visible. */
  summary: React.ReactNode;
  sections: LegalSection[];
}) {
  return (
    <article className={`mx-auto max-w-[46rem] ${PAGE_STACK}`}>
      <PageHeader
        eyebrow={
          <>
            Last updated <time dateTime={updated}>{longDate(updated)}</time>
          </>
        }
        title={title}
        subtitle={subtitle}
      >
        {/* The short version, in a tile: the part of the page most readers need. */}
        <div className="tile px-5 py-5 sm:px-7 sm:py-6">
          <p className="kicker mb-1.5">The short version</p>
          <div className="text-[17px] leading-[1.55] text-foreground [&_a]:text-foreground">{summary}</div>
        </div>
      </PageHeader>

      <nav aria-labelledby="legal-contents">
        <SectionTitle>
          <span id="legal-contents">On this page</span>
        </SectionTitle>
        <ol className="tile inset-rows py-1 [--sep-inset:3rem] sm:[--sep-inset:3.5rem]">
          {sections.map((s, i) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="group/toc flex min-h-11 items-center gap-3 px-5 py-2.5 text-[15px] outline-offset-[-2px] sm:px-7"
              >
                <span className="tabular w-4 shrink-0 text-right text-[13px] text-muted-foreground">{i + 1}</span>
                <span className="flex-1 underline decoration-transparent underline-offset-[3px] transition-[text-decoration-color] group-hover/toc:decoration-border-strong">
                  {s.title}
                </span>
                <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3" strokeWidth={2.25} />
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((s, i) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="scroll-mt-28">
          <SectionTitle>
            <span id={`${s.id}-title`}>
              <span className="tabular mr-2 text-muted-foreground">{i + 1}.</span>
              {s.title}
            </span>
          </SectionTitle>
          <div className="tile space-y-3.5 px-5 py-5 text-[16px] leading-[1.6] text-ink-2 sm:px-7 sm:py-6 [&_li]:pl-0.5 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ul]:marker:text-ink-3">
            {s.body}
          </div>
        </section>
      ))}
    </article>
  );
}

/** An in-text link at the fine-print style the footer uses. */
export function TextLink({ href, children }: { href: string; children: React.ReactNode }) {
  const cls =
    "rounded-sm text-inherit underline decoration-border-strong underline-offset-[3px] transition-[text-decoration-color] duration-150 hover:decoration-current";
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cls}>
      {children}
    </a>
  );
}

/** A field or key name, set in mono like the methodology page's. */
export function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded-[5px] bg-fill px-1 py-0.5 font-mono text-[0.85em] text-ink-2">{children}</code>;
}
