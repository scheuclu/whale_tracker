import {
  KIND_LABEL,
  getAlerts,
  isInsiderKind,
  type AlertKind,
  type AlertRow,
} from "./alert-queries";
import { ACTION_LABEL, insiderIssuerHref, memberHref, price, range, shares, tickerHref, usd } from "./format";
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
  sub: Pick<StoredSubscription, "members" | "tickers" | "clusters"> & { insiders?: string[] },
  sinceDate: string
): Promise<DigestMatches> {
  const insiderCiks = sub.insiders ?? [];
  const hasWatch = sub.members.length > 0 || sub.tickers.length > 0;
  const newer = (filed: string | null) => filed != null && filed.slice(0, 10) > sinceDate;

  // Newest filings first, per followed item: the digest is about what was
  // disclosed since the last one, and a late filing carries an old trade date.
  const [rawCongress, insiderLists, rawAlerts] = await Promise.all([
    hasWatch
      ? getTransactions({
          watch: { members: sub.members, tickers: sub.tickers },
          order: "filed",
          limit: 60,
        }).catch(() => [] as TransactionRow[])
      : Promise.resolve([] as TransactionRow[]),
    Promise.all([
      ...sub.tickers.map((ticker) => getInsiderTrades({ ticker, order: "filed", limit: 40 })),
      ...insiderCiks.map((cik) => getInsiderTrades({ cik, order: "filed", limit: 40 })),
    ]).catch(() => [] as InsiderTradeRow[][]),
    sub.clusters
      ? getAlerts({ limit: 40 }).catch(() => [] as AlertRow[])
      : Promise.resolve([] as AlertRow[]),
  ]);

  const congressTrades = rawCongress.filter((r) => newer(r.filing_date));
  const seen = new Set<number>();
  const insiderTrades = insiderLists
    .flat()
    .filter((r) => newer(r.filing_date) && r.implausible !== 1 && !seen.has(r.id) && (seen.add(r.id), true))
    .sort((a, b) => b.filing_date.localeCompare(a.filing_date) || b.id - a.id);
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
  const unsubscribeToken = signSubscriptionToken({ purpose: "unsubscribe", email }, secret);

  return {
    verifyUrl: absoluteUrl(`/api/alerts/verify?token=${encodeURIComponent(verifyToken)}`),
    // Managing needs a sign-in now; the link is the dashboard itself.
    manageUrl: absoluteUrl("/account"),
    unsubscribeUrl: absoluteUrl(`/api/alerts/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`),
  };
}

/**
 * The emailed sign-in link (`lib/auth.ts`). Transactional, so it carries no
 * unsubscribe link: it is sent once, only because someone asked for it.
 */
export function renderSignInEmail(signInUrl: string): { subject: string; html: string; text: string } {
  const subject = `Your ${SITE_NAME} sign-in link`;
  const text = [
    `Sign in to ${SITE_NAME}`,
    "",
    "Open this link to sign in. It expires in 15 minutes:",
    signInUrl,
    "",
    "If you did not ask to sign in, ignore this email: nothing happens unless the link is opened.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d1d1f;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;padding:28px;border:1px solid rgba(0,0,0,0.08);">
      <p style="margin:0;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6e6e73;">${escapeHtml(SITE_NAME)}</p>
      <h1 style="margin:8px 0 12px;font-size:22px;line-height:1.25;letter-spacing:-0.02em;">Sign in to ${escapeHtml(SITE_NAME)}</h1>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:#424245;">
        Click below to sign in. The link expires in 15 minutes.
      </p>
      <p style="margin:24px 0;">
        <a href="${escapeHtml(signInUrl)}" style="display:inline-block;background:#1d1d1f;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:999px;">
          Sign in
        </a>
      </p>
      <p style="margin:20px 0 0;padding-top:16px;border-top:1px solid #e5e5ea;font-size:12px;line-height:1.5;color:#6e6e73;">
        If you did not ask to sign in, ignore this email: nothing happens unless the link is opened.
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
        <strong><a href="${escapeHtml(absoluteUrl(insiderIssuerHref(sym)))}" style="color:#1d1d1f;">${escapeHtml(sym)}</a></strong>
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
  /** Omitted for a transactional email (the sign-in link): no List-Unsubscribe. */
  unsubscribeUrl?: string;
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
      ...(opts.unsubscribeUrl
        ? {
            headers: {
              "List-Unsubscribe": `<${opts.unsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          }
        : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Resend HTTP ${res.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}
