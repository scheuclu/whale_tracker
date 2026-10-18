import {
  ALERT_KINDS,
  KIND_LABEL,
  getAlertTotals,
  getAlerts,
  getAlertsPerWeek,
  weeklySeries,
  type AlertKind,
} from "@/lib/alert-queries";
import { relativeTime } from "@/lib/format";
import { getAlertOutcomes, getOutcomeSummary } from "@/lib/outcome-queries";
import { Empty, SectionTitle, StatTile } from "../charts";
import { AlertRowCard } from "./alert-row";
import { OutcomeLine, OutcomeSummarySection } from "./outcomes";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

/** Kind filters and row counts are views of `/alerts`. */
export const metadata = pageMetadata({
  title: "Alert log: clusters, late filings and large trades",
  description:
    "Every alert the tracker sent, newest first, with the message as it went out: congressional clusters, late STOCK Act filings, watched members and insider Form 4 rules, and what each ticker did afterwards.",
  path: "/alerts",
});

/**
 * Every alert the bot sent, newest first, with what the message said. This
 * is the page for tuning the rules in config.yaml: the thresholds and
 * cooldowns can only be judged against what they actually produced, and
 * until now that meant reading the Telegram history.
 */

const WEEKS = 8;
const PAGE = 200;

function pill(active: boolean) {
  return `rounded-full border px-2.5 py-1 transition-colors ${
    active
      ? "border-primary/40 bg-primary/10 text-foreground"
      : "border-border text-muted-foreground hover:bg-muted"
  }`;
}

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; n?: string }>;
}) {
  const params = await searchParams;
  const kind = (ALERT_KINDS as readonly string[]).includes(params.kind ?? "") ? params.kind : undefined;
  const all = params.n === "all";
  const href = (k?: string) => {
    const q = new URLSearchParams();
    if (k) q.set("kind", k);
    if (all) q.set("n", "all");
    const s = q.toString();
    return s ? `/alerts?${s}` : "/alerts";
  };

  let totals, weekly, alerts, outcomes, outcomeSummary;
  try {
    [totals, weekly, alerts, outcomes, outcomeSummary] = await Promise.all([
      getAlertTotals(),
      getAlertsPerWeek(WEEKS),
      getAlerts({ kind, limit: all ? 1_000_000 : PAGE }),
      getAlertOutcomes(),
      getOutcomeSummary(),
    ]);
  } catch (err) {
    return <Empty>{(err as Error).message}</Empty>;
  }

  const byKind = new Map(totals.byKind.map((k) => [k.kind, k]));
  const shown = kind ? byKind.get(kind)?.total ?? 0 : totals.total;
  const noSeries = new Set(outcomeSummary.no_series);

  return (
    <div className="space-y-8">
      {/* Named by the active tab visually; the heading is for screen readers and crawlers. */}
      <h1 className="sr-only">Alert log</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Every alert sent to Telegram, newest first, with the message as it went out. Congressional
        amounts are disclosed brackets, so a range is shown and any midpoint is an estimate; insider
        values are shares × the reported price.{" "}
        {totals.recorded_since
          ? `Participants, range and message text are logged for every alert since ${totals.recorded_since.slice(0, 10)}; earlier rows kept only the fields the cluster dedupe needed.`
          : "Until the pipeline next runs, only the cluster dedupe rows exist here; from then on every kind is logged with its message text."}{" "}
        Each alert also shows what its ticker did afterwards against SPY — the ticker&rsquo;s move,
        not a trade&rsquo;s return.
      </p>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {ALERT_KINDS.map((k) => {
          const t = byKind.get(k);
          return (
            <StatTile
              key={k}
              label={KIND_LABEL[k]}
              value={String(t?.last_7d ?? 0)}
              hint={`last 7 days · ${(t?.total ?? 0).toLocaleString()} ever`}
              trend={weeklySeries(weekly, k, WEEKS)}
              trendLabel={`${KIND_LABEL[k]} alerts per week, last ${WEEKS} weeks`}
            />
          );
        })}
      </section>

      <OutcomeSummarySection summary={outcomeSummary} />

      <section>
        <SectionTitle
          right={
            <span className="text-[11px] text-muted-foreground">
              {totals.last_fired ? `last alert ${relativeTime(totals.last_fired)}` : "no alert yet"}
            </span>
          }
        >
          Alert log
        </SectionTitle>
        <nav className="mb-3 flex flex-wrap gap-1.5 text-xs" aria-label="Filter by kind">
          <a href={href()} className={pill(!kind)} aria-current={!kind ? "page" : undefined}>
            All · {totals.total.toLocaleString()}
          </a>
          {ALERT_KINDS.map((k) => (
            <a key={k} href={href(k)} className={pill(kind === k)} aria-current={kind === k ? "page" : undefined}>
              {KIND_LABEL[k]} · {(byKind.get(k)?.total ?? 0).toLocaleString()}
            </a>
          ))}
        </nav>
        {alerts.length ? (
          <ol className="space-y-2">
            {alerts.map((a) => (
              <AlertRowCard
                key={a.id}
                alert={a}
                extra={<OutcomeLine alert={a} outcome={outcomes.get(a.id)} noSeries={noSeries} />}
              />
            ))}
          </ol>
        ) : (
          <Empty>
            {kind
              ? `No ${KIND_LABEL[kind as AlertKind].toLowerCase()} alert has fired yet.`
              : "No alert has fired yet."}
          </Empty>
        )}
        {!all && alerts.length < shown ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Showing the newest {alerts.length.toLocaleString()} of {shown.toLocaleString()}.{" "}
            <a href={`${href(kind)}${kind ? "&" : "?"}n=all`} className="underline underline-offset-2 hover:text-primary">
              Show all
            </a>
            .
          </p>
        ) : null}
      </section>
    </div>
  );
}
