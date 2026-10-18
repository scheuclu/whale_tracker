import type { Metadata } from "next";
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

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "Where the data comes from, why congressional amounts are ranges, how estimates, disclosure delays and insider values are computed, and what is not covered.",
};

/** `code` spans in the shared rule text become <code>; nothing else is markup. */
function Prose({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground/90">
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
    <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="tabular text-foreground/90">{v}</dd>
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
    <article className="mx-auto max-w-3xl space-y-10">
      <AgentAlternates text="/llms-full.txt" />
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Methodology</h1>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Where the data comes from, how each figure is computed, and how to quote it without saying more than the
          filings do. The same rules are published for language models in{" "}
          <a href="/llms-full.txt" className="underline decoration-border underline-offset-2 hover:text-primary">
            llms-full.txt
          </a>{" "}
          and repeated in every API response.
        </p>
      </header>

      <section aria-labelledby="rules">
        <SectionTitle>
          <span id="rules">Rules for quoting</span>
        </SectionTitle>
        <ol className="space-y-3">
          {QUOTING_RULES.map((r, i) => (
            <li key={r.id} id={r.id} className="scroll-mt-28">
              <Card className="flex gap-3.5">
                <span className="tabular mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {i + 1}
                </span>
                <div className="min-w-0 space-y-1">
                  <h3 className="text-[15px] font-semibold">
                    <a href={`#${r.id}`} className="hover:text-primary">
                      {r.title}
                    </a>
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
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
        <div className="grid gap-3">
          {SOURCES.map((s) => (
            <Card key={s.id} className="space-y-1">
              <a
                href={s.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-[15px] font-semibold hover:text-primary"
              >
                {s.name}
                <ArrowUpRight className="size-3.5 opacity-60" aria-hidden />
              </a>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {s.what} {s.how}
              </p>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="coverage">
        <SectionTitle right={<Link href="/pipeline" className="hover:text-primary">Pipeline status →</Link>}>
          <span id="coverage">Coverage, live</span>
        </SectionTitle>
        <Card>{coverage ? <CoverageList c={coverage} /> : <p className="text-sm text-muted-foreground">Coverage figures are unavailable right now.</p>}</Card>
      </section>

      <section aria-labelledby="cadence">
        <SectionTitle>
          <span id="cadence">Update cadence</span>
        </SectionTitle>
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
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
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
          {KNOWN_GAPS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="machines">
        <SectionTitle>
          <span id="machines">For developers and AI agents</span>
        </SectionTitle>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
          A read-only JSON API (no key, CORS open) with the rules above in every response&apos;s{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">meta.caveats</code>. Amounts come as{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">min_usd</code> /{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">max_usd</code> with the disclosed text,
          and any midpoint is named an estimate. Described by{" "}
          <a href="/openapi.json" className="underline decoration-border underline-offset-2 hover:text-primary">
            OpenAPI 3.1
          </a>
          ; summarised for language models in{" "}
          <a href="/llms.txt" className="underline decoration-border underline-offset-2 hover:text-primary">
            llms.txt
          </a>
          .
        </p>
        <Card className="p-0 sm:p-0">
          <ul className="divide-y divide-border">
            {API_ENDPOINTS.map((e) => (
              <li key={e.path} className="grid gap-x-6 gap-y-0.5 px-4 py-2.5 text-sm sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                <span className="break-all font-mono text-[12.5px]">
                  {e.example ? (
                    <a href={e.example} className="hover:text-primary">
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

      <p className="text-xs text-muted-foreground">
        Public disclosures, shown for information — not investment advice, and a disclosed trade is not evidence of
        wrongdoing.
      </p>
    </article>
  );
}
