import { MoneyText } from "../money";
import Link from "next/link";
import {
  type AlertKind,
  type AlertRow,
  COUNT_NOUN,
  KIND_LABEL,
  isInsiderKind,
} from "@/lib/alert-queries";
import { insiderIssuerHref, memberHref, range, relativeTime, telegramPlainText, usd } from "@/lib/format";
import { Card } from "../charts";
import { ActionBadge, PartyBadge, Tag, TickerChip } from "../ui";
import { ROW_LINK } from "../grouped-list";
import { OutboundLink } from "../outbound-link";

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
/** The log's container: one tile, rows under inset hairlines (an iOS grouped list). */
export function AlertLog({ children }: { children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden p-0 sm:p-0">
      <ol className="inset-rows py-1 [--sep-inset:1rem] sm:[--sep-inset:1.25rem]">{children}</ol>
    </Card>
  );
}

export function AlertRowCard({ alert: a, extra }: { alert: AlertRow; extra?: React.ReactNode }) {
  const kind = a.kind as AlertKind;
  const action = a.direction === "buy" ? "purchase" : a.direction === "sell" ? "sale" : null;
  return (
    <li data-alert-id={a.id} className="px-4 py-4 transition-colors duration-(--dur-fast) hover:bg-fill/45 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <KindBadge kind={a.kind} />
        {action ? (
          <ActionBadge action={action} />
        ) : a.volume_mid_cents != null ? (
          <span className="text-[12px] text-muted-foreground" title="The filing has trades on both sides">
            mixed sides
          </span>
        ) : null}
        <Subject a={a} />
        <Volume a={a} />
        {a.window_days > 0 ? (
          <span className="text-[13px] text-muted-foreground">
            {a.politician_count} {COUNT_NOUN[kind] ?? "participants"} · {a.window_days}d window
          </span>
        ) : null}
        <div className="flex-1" />
        <time dateTime={a.fired_at} title={a.fired_at} className="tabular text-[13px] text-muted-foreground">
          {relativeTime(a.fired_at)}
        </time>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px]">
        <Participants a={a} />
        {a.rule_name ? (
          <span
            className="rounded-chip bg-fill px-1.5 py-px text-[11px] text-ink-2"
            title="The config.yaml rule that claimed this alert"
          >
            rule: {a.rule_name}
          </span>
        ) : null}
        {a.issuer_name ? <span className="truncate text-[13px] text-muted-foreground">· {a.issuer_name}</span> : null}
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
    <Tag variant="outline" className="font-medium text-ink-2">
      {KIND_LABEL[kind as AlertKind] ?? kind}
    </Tag>
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
        href={isInsiderKind(a.kind) ? insiderIssuerHref(a.ticker) : undefined}
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
        <MoneyText value={range(a.volume_min_cents, a.volume_max_cents)} />
        {!insider ? <span className="text-muted-foreground"> · est. <MoneyText value={usd(a.volume_mid_cents)} /></span> : null}
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
        <Link href={memberHref(name, a.bioguide_id)} className={ROW_LINK}>
          {name}
        </Link>
        <PartyBadge party={a.party} />
        {a.state ? (
          <span className="text-[12px] text-muted-foreground">
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
    <OutboundLink
      href={href}
      kind={a.pdf_url ? "pdf" : "filing"}
      className="ml-auto rounded-sm text-[12px] text-muted-foreground underline decoration-border-strong underline-offset-[3px] transition-colors duration-(--dur-fast) hover:text-foreground hover:decoration-current"
    >
      {a.pdf_url ? "PDF" : "filing"}
      <span aria-hidden>&nbsp;↗</span>
    </OutboundLink>
  );
}

function Message({ a }: { a: AlertRow }) {
  if (!a.message) return null;
  const [headline, ...rest] = telegramPlainText(a.message).split("\n");
  // The text is the message exactly as sent, emoji included; only its
  // rendering is greyscale. Telegram's 🟢 / 🔴 mean buy / sell, and on this
  // page direction is blue and orange plus words — a green/red pair would
  // bring back the encoding colour-blind readers cannot separate.
  return (
    <details className="group mt-2 grayscale">
      <summary className="cursor-pointer list-none text-[13px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="font-medium text-foreground">{headline}</span>
        <span className="ml-2 underline decoration-border-strong underline-offset-[3px] group-open:hidden">show message</span>
        <span className="ml-2 hidden underline decoration-border-strong underline-offset-[3px] group-open:inline">hide message</span>
      </summary>
      <pre className="mt-2 whitespace-pre-wrap rounded-control bg-fill px-3.5 py-2.5 font-sans text-[13px] leading-relaxed text-ink-2">
        {rest.join("\n").trim()}
      </pre>
    </details>
  );
}
