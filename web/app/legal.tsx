import Link from "next/link";
import { SectionTitle } from "./charts";
import { Disclosure } from "./disclosure";
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
    <article className={`mx-auto max-w-3xl ${PAGE_STACK}`}>
      <PageHeader
        eyebrow={
          <>
            Last updated <time dateTime={updated}>{longDate(updated)}</time>
          </>
        }
        title={title}
        subtitle={subtitle}
      >
        <Disclosure lead={summary} />
      </PageHeader>

      <nav aria-labelledby="legal-contents">
        <SectionTitle>
          <span id="legal-contents">On this page</span>
        </SectionTitle>
        <ol className="grid list-decimal gap-x-8 gap-y-1 pl-5 text-sm text-ink-2 marker:text-muted-foreground sm:grid-cols-2">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="rounded-sm transition-colors duration-150 hover:text-primary">
                {s.title}
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
          <div className="space-y-3 text-sm leading-relaxed text-muted-foreground [&_li]:pl-0.5 [&_strong]:font-semibold [&_strong]:text-ink-2 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
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
    "rounded-sm text-ink-2 underline decoration-border-strong underline-offset-2 transition-colors duration-150 hover:text-primary hover:decoration-primary/50";
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
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-ink-2">{children}</code>;
}
