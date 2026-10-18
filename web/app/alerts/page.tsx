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
import { Disclosure } from "../disclosure";
import { PAGE_STACK, PageHeader, PillLinks, Quiet } from "../page-header";
import { AlertLog, AlertRowCard } from "./alert-row";
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

/** "Filing, watchlist and options" — a list in words, first letter capitalised. */
function listOf(words: string[]): string {
  const s = words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
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
  // A kind that has never fired gets no tile: four zero tiles read as four
  // broken features. They collapse into one line under the tiles instead.
  const fired = ALERT_KINDS.filter((k) => (byKind.get(k)?.total ?? 0) > 0);
  const silent = ALERT_KINDS.filter((k) => (byKind.get(k)?.total ?? 0) === 0);

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        title="Alerts"
        subtitle="Every alert sent to Telegram, newest first, with the message as it went out."
      >
        <Disclosure
          lead="Congressional amounts are disclosed brackets, so a range is shown and any midpoint is an estimate; insider values are shares × the reported price."
        >
          <p>
            {totals.recorded_since
              ? `Participants, range and message text are logged for every alert since ${totals.recorded_since.slice(0, 10)}; earlier rows kept only the fields the cluster dedupe needed.`
              : "Until the pipeline next runs, only the cluster dedupe rows exist here; from then on every kind is logged with its message text."}
          </p>
          <p>
            Each alert also shows what its ticker did afterwards against SPY — the ticker&rsquo;s move,
            not a trade&rsquo;s return.
          </p>
        </Disclosure>
        {fired.length ? (
          <section aria-label="Alerts by kind" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {fired.map((k) => {
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
        ) : null}
        {silent.length ? (
          <Quiet>
            {listOf(silent.map((k) => KIND_LABEL[k].toLowerCase()))} alerts{" "}
            {totals.recorded_since ? "have not fired yet." : "start logging on the next run."}
          </Quiet>
        ) : null}
      </PageHeader>

      <OutcomeSummarySection summary={outcomeSummary} />

      <section aria-labelledby="alert-log-title">
        <SectionTitle
          right={
            <span className="text-[12px] text-muted-foreground">
              {totals.last_fired ? `last alert ${relativeTime(totals.last_fired)}` : "no alert yet"}
            </span>
          }
        >
          <span id="alert-log-title">Alert log</span>
        </SectionTitle>
        <PillLinks
          label="Filter by kind"
          className="mb-3"
          items={[
            { href: href(), label: `All · ${totals.total.toLocaleString()}`, active: !kind },
            // A kind that never fired has nothing to filter; it stays only when the URL names it.
            ...ALERT_KINDS.filter((k) => fired.includes(k) || kind === k).map((k) => ({
              href: href(k),
              label: `${KIND_LABEL[k]} · ${(byKind.get(k)?.total ?? 0).toLocaleString()}`,
              active: kind === k,
            })),
          ]}
        />
        {alerts.length ? (
          <AlertLog>
            {alerts.map((a) => (
              <AlertRowCard
                key={a.id}
                alert={a}
                extra={<OutcomeLine alert={a} outcome={outcomes.get(a.id)} noSeries={noSeries} />}
              />
            ))}
          </AlertLog>
        ) : (
          <Quiet>
            {kind
              ? `No ${KIND_LABEL[kind as AlertKind].toLowerCase()} alert has fired yet.`
              : "No alert has fired yet."}
          </Quiet>
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
