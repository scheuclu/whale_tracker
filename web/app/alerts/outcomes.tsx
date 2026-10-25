import { type AlertKind, type AlertRow, KIND_LABEL } from "@/lib/alert-queries";
import { shortDate } from "@/lib/format";
import {
  type AlertOutcome,
  type OutcomeSummary,
  BENCHMARK,
  HORIZONS,
  MIN_SAMPLE,
  isListedTicker,
} from "@/lib/outcome-queries";
import { SectionTitle } from "../charts";
import { Disclosure } from "../disclosure";
import { Quiet } from "../page-header";
import { ResponsiveTable } from "../ui";

/**
 * What the alerted ticker did next, per alert and per kind (#53).
 *
 * Every figure is the ticker's own close-to-close move after the alert minus
 * SPY over the same trading days — the measure of whether the rule that
 * fired pointed the right way. It is not a trade's return: congressional
 * amounts are brackets and nothing here touches one, and the price series
 * is an unofficial external one shown for description, never as advice.
 * Values stay in text ink with the sign spelled out; nothing is coloured by
 * direction, so the number carries its own meaning.
 */

/** A fraction as a signed percentage: +1.2%, −3.4%, 0.0%. */
export function pct(v: number | null | undefined): string {
  if (v == null) return "—";
  const p = v * 100;
  const sign = p >= 0.05 ? "+" : p <= -0.05 ? "−" : "";
  return `${sign}${Math.abs(p).toFixed(1)}%`;
}

export function OutcomeLine({
  alert: a,
  outcome: o,
  noSeries,
}: {
  alert: AlertRow;
  outcome?: AlertOutcome;
  /** Listed tickers the source carries no series for. */
  noSeries: Set<string>;
}) {
  if (!isListedTicker(a.ticker)) return null;
  if (!o) {
    return (
      <span data-outcome="none">
        Move after the alert:{" "}
        {noSeries.has(a.ticker) ? `no price series for ${a.ticker} at the source.` : "no prices yet."}
      </span>
    );
  }
  return (
    <div
      className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1"
      data-outcome={a.id}
    >
      <span title={`${a.ticker}'s close-to-close move minus ${BENCHMARK}'s over the same trading days, from the ${o.t0_date} close of ${o.t0_close.toFixed(2)}. The ticker's move, not a trade's return.`}>
        After the alert · {a.ticker} vs {BENCHMARK} from the {shortDate(o.t0_date)} close
      </span>
      {HORIZONS.map((h) => {
        const excess = o[`excess_${h}`];
        const ret = o[`ret_${h}`];
        const bench = o[`bench_${h}`];
        if (excess == null) {
          const pending = o.days_elapsed < h;
          return (
            <span key={h} className="tabular" title={pending ? `${o.days_elapsed} of ${h} trading days elapsed` : `no close for ${a.ticker} on that day`}>
              +{h}d <span className="text-muted-foreground">{pending ? `pending ${o.days_elapsed}/${h}` : "n/a"}</span>
            </span>
          );
        }
        return (
          <span key={h} className="tabular" title={`${a.ticker} ${pct(ret)}, ${BENCHMARK} ${pct(bench)} over ${h} trading days`}>
            +{h}d <span className="font-medium text-foreground">{pct(excess)}</span>
          </span>
        );
      })}
    </div>
  );
}

export function OutcomeSummarySection({ summary: s }: { summary: OutcomeSummary }) {
  const degraded = s.status && !s.status.startsWith("ok");
  return (
    <section aria-labelledby="outcomes-title">
      <SectionTitle
        kicker="Post-Alert Move"
        right={
          s.available ? (
            <span className="text-[11px] text-muted-foreground">
              {s.alerts_priced.toLocaleString()} of {s.alerts_total.toLocaleString()} alerts priced
              {s.newest_close ? ` · closes through ${shortDate(s.newest_close)}` : ""}
            </span>
          ) : null
        }
      >
        <span id="outcomes-title">Price move after the alert</span>
      </SectionTitle>
      <Disclosure
        size="sm"
        className="mb-3"
        lead={
          <>
            The alerted ticker&rsquo;s own close-to-close move at +5, +20 and +60 trading days after the
            alert, minus {BENCHMARK} over the same days &mdash; what the ticker did, not what anyone earned.
          </>
        }
      >
        <p>
          Read the way the alert pointed: a sell alert&rsquo;s hit is a fall. Congressional amounts are
          disclosed brackets and none enters these figures, and the prices are an unofficial external
          series kept for this description only, not advice.
        </p>
        <p>
          n counts alerts with that horizon reached; fewer than {MIN_SAMPLE} is reported as insufficient
          data. Alerts with no one direction are left out.
        </p>
      </Disclosure>
      {!s.available ? (
        <Quiet>
          No prices in this database yet. The pipeline fetches them after the alert step; this section
          fills in once the committed database carries the price tables.
        </Quiet>
      ) : !s.byKind.length ? (
        <Quiet>
          No alert has a measurable outcome yet
          {degraded ? ` — the last price run reported: ${s.status}` : ""}.
        </Quiet>
      ) : (
        <div>
          <ResponsiveTable>
            <table className="w-full text-[13px]" data-outcome-summary>
            <thead>
              <tr className="text-left text-[12px] font-medium text-muted-foreground">
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Kind
                </th>
                {HORIZONS.map((h) => (
                  <th key={h} scope="col" className="px-4 py-2.5 font-medium">
                    +{h} trading days
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.byKind.map((k) => (
                <tr key={k.kind} className="border-t border-border">
                  <th scope="row" className="px-4 py-2.5 text-left font-medium">
                    {KIND_LABEL[k.kind as AlertKind] ?? k.kind}
                  </th>
                  {k.horizons.map((h) => (
                    <td key={h.horizon} className="tabular px-4 py-2.5">
                      {h.sufficient && h.median_excess != null && h.hit_rate != null ? (
                        <>
                          <span className="font-medium">{pct(h.median_excess)}</span>
                          <span className="text-muted-foreground">
                            {" "}
                            median · {Math.round(h.hit_rate * 100)}% hit · n {h.n}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">insufficient data · n {h.n}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            </table>
          </ResponsiveTable>
          {degraded ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Last price run: {s.status}. Outcomes stop advancing until it recovers.
            </p>
          ) : null}
          {s.no_series.length ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              No price series at the source for {s.no_series.join(", ")}; those alerts are not measured.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
