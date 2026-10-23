import { pageCard, pageMetadata } from "@/lib/seo";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { getCoverage } from "@/lib/api-queries";
import {
  API_ENDPOINTS,
  KNOWN_GAPS,
  QUOTING_RULES,
  SOURCES,
  UPDATE_CADENCE,
  type Coverage,
} from "@/lib/methodology";
import { Card, SectionTitle } from "../charts";
import { AgentAlternates } from "../agent-alternates";
import { PAGE_STACK, PageHeader } from "../page-header";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Methodology",
  description:
    "Where the data comes from, why congressional amounts are ranges, how estimates, disclosure delays and insider values are computed, and what is not covered.",
  path: "/methodology",
  card: pageCard(
    "/methodology",
    "Methodology: congressional amounts are ranges, delay is trade date to filing date, insider values are shares × reported price, scanned filings stay out of totals"
  ),
});

/** `code` spans in the shared rule text become <code>; nothing else is markup. */
function Prose({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded-[5px] bg-fill px-1 py-0.5 font-mono text-[0.85em] text-ink-2">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

function CoverageList({ c }: { c: Coverage }) {
  const n = (v: number) => v.toLocaleString("en-US");
  const span = (a: string | null, b: string | null) => (a && b ? `${a} to ${b}` : "—");
  const rows: [string, string][] = [
    ["Data as of", c.data_as_of ?? "unknown"],
    [
      "Congressional filings read",
      `${n(c.congress.filings)} (House ${n(c.congress.filings_house)}, Senate ${n(c.congress.filings_senate)}), filed ${span(c.congress.first_filing_date, c.congress.last_filing_date)}`,
    ],
    ["Congressional trades", `${n(c.congress.trades)} by ${n(c.congress.members)} members across ${n(c.congress.tickers)} tickers`],
    ["Trade dates, as filed", span(c.congress.first_trade_date, c.congress.last_trade_date)],
    ["Transcribed from scans (in no total)", n(c.congress.transcribed_trades)],
    ["Filings that could not be read", n(c.congress.unreadable_filings)],
  ];
  if (c.insiders) {
    rows.push([
      "SEC Form 4",
      `${n(c.insiders.trades)} open-market trades, ${n(c.insiders.filings)} filings, ${n(c.insiders.insiders)} insiders at ${n(c.insiders.issuers)} issuers`,
    ]);
  }
  return (
    <dl className="grid gap-x-6 gap-y-3 text-[15px] leading-snug sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="tabular text-ink-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The rules every figure on the site follows, for people. Rendered from
 * lib/methodology.ts — the module /llms-full.txt, the API's caveats and
 * /openapi.json render too — so the wording here is the wording there.
 */
export default async function MethodologyPage() {
  let coverage: Coverage | null = null;
  try {
    coverage = await getCoverage();
  } catch {
    /* the rules still render without the live figures */
  }

  return (
    <article className={`mx-auto max-w-[46rem] ${PAGE_STACK}`}>
      <AgentAlternates text="/llms-full.txt" />
      <PageHeader
        eyebrow="About the data"
        title="Methodology"
        subtitle={
          <>
            Where the data comes from, how each figure is computed, and how to quote it without saying more than the
            filings do. The same rules are published for language models in{" "}
            <a href="/llms-full.txt" className="ink-link">
              llms-full.txt
            </a>{" "}
            and repeated in every API response.
          </>
        }
      />

      <section aria-labelledby="rules">
        <SectionTitle>
          <span id="rules">Rules for quoting</span>
        </SectionTitle>
        <ol className="space-y-3 sm:space-y-4">
          {QUOTING_RULES.map((r, i) => (
            <li key={r.id} id={r.id} className="scroll-mt-28">
              <Card className="flex gap-4 sm:px-7 sm:py-6">
                <span className="tabular mt-px flex size-7 shrink-0 items-center justify-center rounded-full bg-fill text-[13px] font-semibold text-ink-2">
                  {i + 1}
                </span>
                <div className="min-w-0 space-y-1.5">
                  <h3 className="text-[17px] font-semibold leading-snug tracking-[-0.015em]">
                    <a href={`#${r.id}`} className="underline decoration-transparent underline-offset-[3px] hover:decoration-border-strong">
                      {r.title}
                    </a>
                  </h3>
                  <p className="text-[16px] leading-[1.6] text-ink-2">
                    <Prose text={r.body} />
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="sources">
        <SectionTitle>
          <span id="sources">Sources</span>
        </SectionTitle>
        <Card className="p-0 sm:p-0">
          <ul className="inset-rows py-1 [--sep-inset:1.25rem] sm:[--sep-inset:1.75rem]">
            {SOURCES.map((s) => (
              <li key={s.id} className="space-y-1 px-5 py-4 sm:px-7 sm:py-5">
                <a
                  href={s.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-[17px] font-semibold tracking-[-0.015em] underline decoration-transparent underline-offset-[3px] hover:decoration-border-strong"
                >
                  {s.name}
                  <ArrowUpRight className="size-3.5 opacity-60" aria-hidden />
                </a>
                <p className="text-[16px] leading-[1.6] text-ink-2">
                  {s.what} {s.how}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section aria-labelledby="coverage">
        <SectionTitle right={<Link href="/pipeline" className="ink-link">Pipeline status</Link>}>
          <span id="coverage">Coverage, live</span>
        </SectionTitle>
        <Card className="sm:px-7">{coverage ? <CoverageList c={coverage} /> : <p className="text-[15px] text-muted-foreground">Coverage figures are unavailable right now.</p>}</Card>
      </section>

      <section aria-labelledby="cadence">
        <SectionTitle>
          <span id="cadence">Update cadence</span>
        </SectionTitle>
        <ul className="tile list-disc space-y-2 py-5 pl-10 pr-5 text-[16px] leading-[1.6] text-ink-2 marker:text-ink-3 sm:py-6 sm:pl-12 sm:pr-7">
          {UPDATE_CADENCE.map((l) => (
            <li key={l}>
              <Prose text={l} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="gaps">
        <SectionTitle>
          <span id="gaps">Known gaps</span>
        </SectionTitle>
        <ul className="tile list-disc space-y-2 py-5 pl-10 pr-5 text-[16px] leading-[1.6] text-ink-2 marker:text-ink-3 sm:py-6 sm:pl-12 sm:pr-7">
          {KNOWN_GAPS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="machines">
        <SectionTitle>
          <span id="machines">For developers and AI agents</span>
        </SectionTitle>
        <p className="mb-4 pl-1 text-[16px] leading-[1.6] text-ink-2">
          A read-only JSON API (no key, CORS open) with the rules above in every response&apos;s{" "}
          <code className="rounded-[5px] bg-fill px-1 py-0.5 font-mono text-[0.85em]">meta.caveats</code>. Amounts come as{" "}
          <code className="rounded-[5px] bg-fill px-1 py-0.5 font-mono text-[0.85em]">min_usd</code> /{" "}
          <code className="rounded-[5px] bg-fill px-1 py-0.5 font-mono text-[0.85em]">max_usd</code> with the disclosed text,
          and any midpoint is named an estimate. Described by{" "}
          <a href="/openapi.json" className="ink-link">
            OpenAPI 3.1
          </a>
          ; summarised for language models in{" "}
          <a href="/llms.txt" className="ink-link">
            llms.txt
          </a>
          .
        </p>
        <Card className="p-0 sm:p-0">
          <ul className="inset-rows py-1 [--sep-inset:1.25rem] sm:[--sep-inset:1.75rem]">
            {API_ENDPOINTS.map((e) => (
              <li key={e.path} className="grid gap-x-6 gap-y-0.5 px-5 py-3 text-[15px] sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:px-7">
                <span className="break-all font-mono text-[12.5px]">
                  {e.example ? (
                    <a href={e.example} className="underline decoration-transparent underline-offset-[3px] hover:decoration-border-strong">
                      {e.path}
                    </a>
                  ) : (
                    e.path
                  )}
                </span>
                <span className="text-muted-foreground">{e.summary}</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <p className="pl-1 text-[13px] text-muted-foreground">
        Public disclosures, shown for information — not investment advice, and a disclosed trade is not evidence of
        wrongdoing.
      </p>
    </article>
  );
}
