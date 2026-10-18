import Link from "next/link";
import {
  type AlertKind,
  type AlertRow,
  COUNT_NOUN,
  KIND_LABEL,
  isInsiderKind,
} from "@/lib/alert-queries";
import { memberHref, range, relativeTime, telegramPlainText, usd } from "@/lib/format";
import { Card } from "../charts";
import { ActionBadge, PartyBadge, TickerChip } from "../ui";

/**
 * One alert, as sent. Exported so later pages — post-alert price outcomes
 * (#53) — can list the same rows and hang their own figures off `extra`.
 *
 * Congressional amounts are brackets: the row shows the disclosed range and
 * labels the midpoint an estimate. Insider values are shares × the reported
 * price — exact but computed — and are labelled as such. Rows logged before
 * schema 13 have neither range nor text, and say so rather than re-rendering
 * a message that cannot be reconstructed.
 */
/** The log's container: one card, rows divided by hairlines rather than a stack of cards. */
export function AlertLog({ children }: { children: React.ReactNode }) {
  return (
    <Card className="p-0 sm:p-0">
      <ol className="divide-y divide-border/70">{children}</ol>
    </Card>
  );
}

export function AlertRowCard({ alert: a, extra }: { alert: AlertRow; extra?: React.ReactNode }) {
  const kind = a.kind as AlertKind;
  const action = a.direction === "buy" ? "purchase" : a.direction === "sell" ? "sale" : null;
  return (
    <li data-alert-id={a.id} className="px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <KindBadge kind={a.kind} />
        {action ? (
          <ActionBadge action={action} />
        ) : a.volume_mid_cents != null ? (
          <span className="text-[11px] text-muted-foreground" title="The filing has trades on both sides">
            mixed sides
          </span>
        ) : null}
        <Subject a={a} />
        <Volume a={a} />
        {a.window_days > 0 ? (
          <span className="text-xs text-muted-foreground">
            {a.politician_count} {COUNT_NOUN[kind] ?? "participants"} · {a.window_days}d window
          </span>
        ) : null}
        <div className="flex-1" />
        <time dateTime={a.fired_at} title={a.fired_at} className="tabular text-xs text-muted-foreground">
          {relativeTime(a.fired_at)}
        </time>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <Participants a={a} />
        {a.rule_name ? (
          <span
            className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
            title="The config.yaml rule that claimed this alert"
          >
            rule: {a.rule_name}
          </span>
        ) : null}
        {a.issuer_name ? <span className="truncate text-muted-foreground">· {a.issuer_name}</span> : null}
        <SourceLink a={a} />
      </div>
      {a.message ? <Message a={a} /> : null}
      {/* One quiet meta line: what was not logged, then the move afterwards. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground empty:hidden">
        {a.message ? null : <span>Message text not logged — sent before the log kept it.</span>}
        {extra}
      </div>
    </li>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] font-medium">
      {KIND_LABEL[kind as AlertKind] ?? kind}
    </span>
  );
}

function Subject({ a }: { a: AlertRow }) {
  if (a.ticker) {
    // Two early insider clusters were keyed on a bare CIK; nothing links there.
    if (/^\d{10}$/.test(a.ticker)) {
      return (
        <span
          className="font-mono text-xs text-muted-foreground"
          title="Filed without a trading symbol; keyed on the issuer's CIK"
        >
          CIK {a.ticker}
        </span>
      );
    }
    return (
      <TickerChip
        ticker={a.ticker}
        href={isInsiderKind(a.kind) ? `/insiders?t=${encodeURIComponent(a.ticker)}` : undefined}
      />
    );
  }
  if (a.filing_tickers) {
    return (
      <span className="text-xs text-muted-foreground" title="The filing spans several tickers">
        {a.filing_tickers} ticker{a.filing_tickers === 1 ? "" : "s"}
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">no ticker</span>;
}

function Volume({ a }: { a: AlertRow }) {
  const insider = isInsiderKind(a.kind);
  if (a.volume_min_cents != null) {
    return (
      <span
        className="tabular text-[13px]"
        title={insider ? "shares × reported price" : "the disclosed bracket range; the midpoint is an estimate"}
      >
        {range(a.volume_min_cents, a.volume_max_cents)}
        {!insider ? <span className="text-muted-foreground"> · est. {usd(a.volume_mid_cents)}</span> : null}
      </span>
    );
  }
  if (a.volume_mid_cents != null) {
    // Logged before the range was kept: only the estimate the threshold compared.
    return (
      <span
        className="tabular text-[13px]"
        title={insider ? "shares × reported price" : "bracket-midpoint estimate; the range was not logged"}
      >
        {insider ? usd(a.volume_mid_cents) : `est. ${usd(a.volume_mid_cents)}`}
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">{insider ? "unpriced" : "no amount"}</span>;
}

function Participants({ a }: { a: AlertRow }) {
  if (a.kind === "filing" || a.kind === "watchlist") {
    const name = a.member_name ?? a.participants;
    if (!name) return <span className="text-muted-foreground">unknown member</span>;
    return (
      <>
        <Link href={memberHref(name)} className="font-medium hover:text-primary">
          {name}
        </Link>
        <PartyBadge party={a.party} />
        {a.state ? (
          <span className="text-xs text-muted-foreground">
            {a.state}
            {a.district && a.district !== "0" ? `-${a.district}` : ""}
          </span>
        ) : null}
      </>
    );
  }
  if (a.participants) {
    return (
      <span className="truncate" title={a.participants}>
        {a.participants}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">
      {a.politician_count} {COUNT_NOUN[a.kind as AlertKind] ?? "participants"} — names not logged
    </span>
  );
}

function SourceLink({ a }: { a: AlertRow }) {
  const href = a.pdf_url ?? a.source_url;
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
    >
      {a.pdf_url ? "PDF" : "filing"}
    </a>
  );
}

function Message({ a }: { a: AlertRow }) {
  if (!a.message) return null;
  const [headline, ...rest] = telegramPlainText(a.message).split("\n");
  return (
    <details className="group mt-2">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
        <span className="font-medium text-foreground">{headline}</span>
        <span className="ml-2 group-open:hidden">show message</span>
        <span className="ml-2 hidden group-open:inline">hide message</span>
      </summary>
      <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-muted/60 px-3 py-2 font-sans text-xs leading-relaxed">
        {rest.join("\n").trim()}
      </pre>
    </details>
  );
}
