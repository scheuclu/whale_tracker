import {
  KIND_LABEL,
  getAlerts,
  isInsiderKind,
  type AlertKind,
  type AlertRow,
} from "./alert-queries";
import { ACTION_LABEL, memberHref, price, range, shares, tickerHref, usd } from "./format";
import { getInsiderTrades, type InsiderTradeRow } from "./insider-queries";
import { getTransactions, type TransactionRow } from "./queries";
import { absoluteUrl, SITE_NAME } from "./site";
import type { StoredSubscription } from "./subscription-store";
import {
  signSubscriptionToken,
  VERIFY_TTL_SECONDS,
} from "./subscription-token";

type Env = Record<string, string | undefined>;

export function resendConfigured(env: Env = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim());
}

export function resendFromAddress(env: Env = process.env): string {
  return env.RESEND_FROM?.trim() || `${SITE_NAME} <alerts@fatcatwatch.com>`;
}

export interface DigestMatches {
  sinceDate: string;
  congressTrades: TransactionRow[];
  insiderTrades: InsiderTradeRow[];
  clusterAlerts: AlertRow[];
}

export function hasDigestMatches(m: DigestMatches): boolean {
  return m.congressTrades.length > 0 || m.insiderTrades.length > 0 || m.clusterAlerts.length > 0;
}

/**
 * Finds new congressional filings, Form 4 insider filings, and cluster alerts
 * disclosed strictly after `sinceDate` (YYYY-MM-DD) for a subscriber.
 *
 * Congressional trades and Form 4 insider trades are kept in separate lists
 * and never summed together (CLAUDE.md).
 */
export async function matchSubscriberDigest(
  sub: Pick<StoredSubscription, "members" | "tickers" | "insiders" | "clusters">,
  sinceDate: string
): Promise<DigestMatches> {
  const tickerSet = new Set(sub.tickers.map((t) => t.toUpperCase()));
  const insiderSet = new Set(sub.insiders ?? []);
  const hasCongressWatch = sub.members.length > 0 || sub.tickers.length > 0;
  const hasInsiderWatch = sub.tickers.length > 0 || insiderSet.size > 0;

  const [rawCongress, rawInsiders, rawAlerts] = await Promise.all([
    hasCongressWatch
      ? getTransactions({
          watch: { members: sub.members, tickers: sub.tickers },
          limit: 60,
        }).catch(() => [] as TransactionRow[])
      : Promise.resolve([] as TransactionRow[]),
    hasInsiderWatch
      ? getInsiderTrades({
          watch: { tickers: sub.tickers, insiders: sub.insiders },
          limit: 100,
        }).catch(() => [] as InsiderTradeRow[])
      : Promise.resolve([] as InsiderTradeRow[]),
    sub.clusters
      ? getAlerts({ limit: 40 }).catch(() => [] as AlertRow[])
      : Promise.resolve([] as AlertRow[]),
  ]);

  const congressTrades = rawCongress.filter(
    (r) => r.filing_date != null && r.filing_date.slice(0, 10) > sinceDate
  );
  const insiderTrades = rawInsiders.filter(
    (r) =>
      ((r.ticker != null && tickerSet.has(r.ticker.toUpperCase())) ||
        (r.insider_cik != null && insiderSet.has(r.insider_cik))) &&
      r.filing_date != null &&
      r.filing_date.slice(0, 10) > sinceDate &&
      r.implausible !== 1
  );
  const clusterAlerts = rawAlerts.filter(
    (a) =>
      (a.kind === "cluster" || a.kind === "insider_cluster") &&
      a.fired_at.slice(0, 10) > sinceDate
  );

  return {
    sinceDate,
    congressTrades,
    insiderTrades,
    clusterAlerts,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function subscriptionActionUrls(email: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const verifyToken = signSubscriptionToken(
    { purpose: "verify", email, exp: nowSeconds + VERIFY_TTL_SECONDS },
    secret
  );
  const manageToken = signSubscriptionToken({ purpose: "manage", email }, secret);
  const unsubscribeToken = signSubscriptionToken({ purpose: "unsubscribe", email }, secret);

  return {
    verifyUrl: absoluteUrl(`/api/alerts/verify?token=${encodeURIComponent(verifyToken)}`),
    manageUrl: absoluteUrl(`/watchlist?token=${encodeURIComponent(manageToken)}`),
    unsubscribeUrl: absoluteUrl(`/api/alerts/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`),
  };
}

export function renderVerificationEmail(
  sub: Pick<StoredSubscription, "email" | "members" | "tickers" | "insiders" | "clusters" | "weeklyDigest">,
  urls: { verifyUrl: string; manageUrl: string; unsubscribeUrl: string }
): { subject: string; html: string; text: string } {
  const items = [
    ...sub.members.map((m) => `Member ${m}`),
    ...sub.tickers.map((t) => `Ticker ${t}`),
    ...(sub.insiders ?? []).map((c) => `Insider CIK ${c}`),
    ...(sub.clusters ? ["High-signal cluster alerts"] : []),
    ...(sub.weeklyDigest ? ["Weekly digest"] : []),
  ];
  const summary = items.length ? items.join(", ") : "your FatCat Watch alert preferences";

  const subject = `Confirm your ${SITE_NAME} alert subscription`;
  const text = [
    `Confirm your ${SITE_NAME} alert subscription`,
    "",
    `You requested daily email alerts for: ${summary}.`,
    "",
    `Confirm subscription:`,
    urls.verifyUrl,
    "",
    `Manage preferences:`,
    urls.manageUrl,
    "",
    `If you did not request this email, you can ignore it or unsubscribe:`,
    urls.unsubscribeUrl,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d1d1f;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;padding:28px;border:1px solid rgba(0,0,0,0.08);">
      <p style="margin:0;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6e6e73;">${escapeHtml(SITE_NAME)}</p>
      <h1 style="margin:8px 0 12px;font-size:22px;line-height:1.25;letter-spacing:-0.02em;">Confirm your alert subscription</h1>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:#424245;">
        Click below to activate daily digest alerts for <strong>${escapeHtml(summary)}</strong>. We send at most one combined email per day when new filings arrive.
      </p>
      <p style="margin:24px 0;">
        <a href="${escapeHtml(urls.verifyUrl)}" style="display:inline-block;background:#1d1d1f;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:999px;">
          Confirm subscription
        </a>
      </p>
      <p style="margin:20px 0 0;padding-top:16px;border-top:1px solid #e5e5ea;font-size:12px;line-height:1.5;color:#6e6e73;">
        <a href="${escapeHtml(urls.manageUrl)}" style="color:#424245;text-decoration:underline;">Manage preferences</a>
        &nbsp;·&nbsp;
        <a href="${escapeHtml(urls.unsubscribeUrl)}" style="color:#424245;text-decoration:underline;">Unsubscribe</a>
      </p>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}

export function renderDigestEmail(
  matches: DigestMatches,
  urls: { manageUrl: string; unsubscribeUrl: string }
): { subject: string; html: string; text: string } {
  const totalCount =
    matches.congressTrades.length + matches.insiderTrades.length + matches.clusterAlerts.length;
  const subject = `${SITE_NAME} daily digest: ${totalCount} new ${totalCount === 1 ? "disclosure" : "disclosures"}`;

  const textLines: string[] = [
    `${SITE_NAME} — Daily Alert Digest (since ${matches.sinceDate})`,
    "Congressional amounts are disclosed bracket ranges (never exact midpoints). Form 4 insider values are shares × reported price and kept separate.",
    "",
  ];

  const htmlSections: string[] = [];

  if (matches.congressTrades.length > 0) {
    textLines.push(`CONGRESSIONAL TRADES (${matches.congressTrades.length} disclosed under the STOCK Act):`);
    const itemsHtml = matches.congressTrades.slice(0, 20).map((r) => {
      const act = ACTION_LABEL[r.action] ?? r.action;
      const amt = range(r.amount_min_cents, r.amount_max_cents, r.amount_exact_cents);
      const sym = r.ticker ?? "no ticker";
      const scanNote = r.transcribed ? " (transcribed from scan)" : "";
      textLines.push(
        `- ${r.member_name}: ${act} ${sym} · disclosed ${amt}${scanNote} · traded ${r.tx_date ?? "—"}`
      );
      return `<li style="padding:8px 0;border-bottom:1px solid #f0f0f2;font-size:14px;line-height:1.45;">
        <strong><a href="${escapeHtml(absoluteUrl(memberHref(r.member_name, r.bioguide_id)))}" style="color:#1d1d1f;text-decoration:none;">${escapeHtml(r.member_name)}</a></strong>
        · ${escapeHtml(act)}
        ${r.ticker ? `<strong><a href="${escapeHtml(absoluteUrl(tickerHref(r.ticker)))}" style="color:#1d1d1f;">${escapeHtml(r.ticker)}</a></strong>` : escapeHtml(sym)}
        · disclosed <strong>${escapeHtml(amt)}</strong>${r.transcribed ? ` <em>(transcribed from scan)</em>` : ""}
        <span style="color:#6e6e73;"> · traded ${escapeHtml(r.tx_date ?? "—")}</span>
      </li>`;
    });
    textLines.push("");
    htmlSections.push(`
      <h2 style="margin:20px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#6e6e73;">
        Congressional STOCK Act Disclosures (Bracket Ranges)
      </h2>
      <ul style="list-style:none;margin:0;padding:0;">${itemsHtml.join("")}</ul>
    `);
  }

  if (matches.insiderTrades.length > 0) {
    textLines.push(`CORPORATE INSIDER TRADES (${matches.insiderTrades.length} on SEC Form 4, shares × reported price):`);
    const itemsHtml = matches.insiderTrades.slice(0, 20).map((r) => {
      const act = ACTION_LABEL[r.action] ?? r.action;
      const val = r.amount_exact_cents != null ? usd(r.amount_exact_cents) : "unpriced";
      const sym = r.ticker ?? "—";
      textLines.push(
        `- ${sym} (${r.insider_name ?? "insider"}): ${act} ${val} (${shares(r.shares)} sh @ ${price(r.price_per_share)}) · traded ${r.tx_date ?? "—"}`
      );
      return `<li style="padding:8px 0;border-bottom:1px solid #f0f0f2;font-size:14px;line-height:1.45;">
        <strong><a href="${escapeHtml(absoluteUrl(`/insiders?t=${encodeURIComponent(sym)}`))}" style="color:#1d1d1f;">${escapeHtml(sym)}</a></strong>
        · ${escapeHtml(r.insider_name ?? "insider")}
        · ${escapeHtml(act)} <strong>${escapeHtml(val)}</strong>
        <span style="color:#6e6e73;">(${escapeHtml(shares(r.shares))} sh @ ${escapeHtml(price(r.price_per_share))}) · traded ${escapeHtml(r.tx_date ?? "—")}</span>
      </li>`;
    });
    textLines.push("");
    htmlSections.push(`
      <h2 style="margin:20px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#6e6e73;">
        SEC Form 4 Corporate Insiders (Shares × Reported Price)
      </h2>
      <ul style="list-style:none;margin:0;padding:0;">${itemsHtml.join("")}</ul>
    `);
  }

  if (matches.clusterAlerts.length > 0) {
    textLines.push(`HIGH-SIGNAL CLUSTER ALERTS (${matches.clusterAlerts.length}):`);
    const itemsHtml = matches.clusterAlerts.slice(0, 10).map((a) => {
      const insider = isInsiderKind(a.kind);
      const label = KIND_LABEL[a.kind as AlertKind] ?? a.kind;
      const vol =
        a.volume_min_cents != null
          ? insider
            ? `${range(a.volume_min_cents, a.volume_max_cents)} (shares × reported price)`
            : `disclosed ${range(a.volume_min_cents, a.volume_max_cents)} · est. ${usd(a.volume_mid_cents)}`
          : a.volume_mid_cents != null
            ? insider
              ? `${usd(a.volume_mid_cents)} (shares × reported price)`
              : `est. ${usd(a.volume_mid_cents)}`
            : "no amount";
      textLines.push(`- [${label}] ${a.ticker ?? "—"} (${a.direction ?? "mixed"}): ${vol}`);
      return `<li style="padding:8px 0;border-bottom:1px solid #f0f0f2;font-size:14px;line-height:1.45;">
        <strong>${escapeHtml(label)}</strong> · <strong>${escapeHtml(a.ticker ?? "—")}</strong>
        · ${escapeHtml(vol)}
        ${a.participants ? `<span style="color:#6e6e73;"> · ${escapeHtml(a.participants)}</span>` : ""}
      </li>`;
    });
    textLines.push("");
    htmlSections.push(`
      <h2 style="margin:20px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#6e6e73;">
        High-Signal Cluster Alerts
      </h2>
      <ul style="list-style:none;margin:0;padding:0;">${itemsHtml.join("")}</ul>
    `);
  }

  textLines.push(`Manage preferences: ${urls.manageUrl}`);
  textLines.push(`Unsubscribe: ${urls.unsubscribeUrl}`);

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d1d1f;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:20px;padding:28px;border:1px solid rgba(0,0,0,0.08);">
      <p style="margin:0;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6e6e73;">${escapeHtml(SITE_NAME)} · Daily Digest</p>
      <h1 style="margin:8px 0 8px;font-size:22px;line-height:1.25;letter-spacing:-0.02em;">New disclosures on your watchlist</h1>
      <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#6e6e73;">
        Congressional amounts are disclosed bracket ranges (midpoints are estimates). Corporate insider values are shares × reported price and are never summed with congressional trades.
      </p>
      ${htmlSections.join("")}
      <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e5ea;font-size:12px;line-height:1.5;color:#6e6e73;">
        <a href="${escapeHtml(urls.manageUrl)}" style="color:#424245;text-decoration:underline;">Manage preferences</a>
        &nbsp;·&nbsp;
        <a href="${escapeHtml(urls.unsubscribeUrl)}" style="color:#424245;text-decoration:underline;">One-click unsubscribe</a>
      </p>
    </div>
  </body>
</html>`;

  return { subject, html, text: textLines.join("\n") };
}

export async function sendResendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
  env?: Env;
}): Promise<{ ok: boolean; error?: string }> {
  const env = opts.env ?? process.env;
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: resendFromAddress(env),
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      headers: {
        "List-Unsubscribe": `<${opts.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Resend HTTP ${res.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}
