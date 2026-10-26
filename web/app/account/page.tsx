import type { Metadata } from "next";
import { cookies } from "next/headers";
import { googleCredentials, readSession, SESSION_COOKIE } from "@/lib/auth";
import { resendConfigured } from "@/lib/email-digest";
import { pageMetadata } from "@/lib/seo";
import { subscriptionBackend, subscriptionsConfigured } from "@/lib/subscription-blob";
import { getSubscription, type StoredSubscription } from "@/lib/subscription-store";
import { alertsSecret } from "@/lib/subscription-token";
import {
  getFollowedClusterAlerts,
  getFollowedInsiderTrades,
  getFollowedMembers,
  getFollowedTickers,
  getFollowedTrades,
  type FollowedMember,
  type FollowedTicker,
} from "@/lib/account-queries";
import { insiderIssuerHref, memberHref, memberLabel, range, shortDate, tickerHref } from "@/lib/format";
import { plural } from "@/lib/site";
import { Card, SectionTitle, StatTile } from "../charts";
import { PartyBadge } from "../ui";
import { MemberAvatar } from "../avatar";
import { FeedList } from "../feed-list";
import { AlertLog, AlertRowCard } from "../alerts/alert-row";
import { InsiderTradeList } from "../insider-trade-list";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "../page-header";
import { AccountSettings, AddFollowForm, DashboardSync, SignInPanel, UnfollowButton } from "../account-client";

/**
 * The signed-in reader's dashboard: their follows, each with its record, the
 * recent filings behind them, and the email settings.
 *
 * The one page rendered from the session cookie. That is safe only because
 * `/account` is left out of the CDN page cache (`PAGE_SOURCE` in
 * lib/cache-policy.ts) and Next sends it `private, no-store`; every other
 * page reads the account in the browser instead (lib/auth.ts).
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Your dashboard",
  description: "The members and tickers you follow on FatCat Watch, their latest filings, and your email alerts.",
  path: "/account",
  noindex: true,
});

const STATUS_MESSAGES: Record<string, string> = {
  verified: "Your email address is confirmed. Sign in to manage your alerts.",
  unsubscribed: "You are unsubscribed: no more digest emails. Your follows are kept; sign in to see them or turn emails back on.",
  invalid_token: "That link is invalid or has expired.",
  not_found: "No subscription was found for that link.",
  unavailable: "Accounts are not configured on this deployment.",
};

async function signedInAccount(): Promise<StoredSubscription | null> {
  const secret = alertsSecret();
  const backend = subscriptionBackend();
  if (!secret || !backend) return null;
  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, secret);
  if (!session) return null;
  return getSubscription(backend, secret, session.email).catch(() => null);
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const notice = params.status ? STATUS_MESSAGES[params.status] ?? null : null;
  const account = await signedInAccount();

  if (!account) {
    const accounts = subscriptionsConfigured();
    return (
      <div className={PAGE_STACK}>
        <PageHeader
          eyebrow="Account"
          title="Your dashboard"
          subtitle="Sign in to follow members and tickers, see their latest filings in one place, and get them by email."
        />
        {notice ? <Notice>{notice}</Notice> : null}
        <div className="max-w-[440px]">
          <SignInPanel
            next="/account"
            error={null}
            googleEnabled={accounts && googleCredentials() !== null}
            emailEnabled={accounts && resendConfigured()}
          />
        </div>
      </div>
    );
  }

  const follows = { members: account.members, tickers: account.tickers };
  const nothing = follows.members.length === 0 && follows.tickers.length === 0;

  return (
    <div className={PAGE_STACK}>
      <DashboardSync follows={[...follows.members, ...follows.tickers].join(",")} />
      <PageHeader eyebrow={account.email} title="Your dashboard" subtitle="What you follow, what they filed, and what we email you.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Members followed" value={String(follows.members.length)} />
          <StatTile label="Tickers followed" value={String(follows.tickers.length)} />
          <StatTile
            label="Daily digest"
            value={account.emailAlerts ? "On" : "Off"}
            hint={account.emailAlerts ? "at most one email a day" : "turn it on below"}
          />
          <StatTile
            label="Last digest sent"
            value={account.lastSentDate ? shortDate(account.lastSentDate) : "None yet"}
            hint={account.lastSentDate ? undefined : "sent when something you follow files"}
          />
        </div>
      </PageHeader>

      {notice ? <Notice>{notice}</Notice> : null}

      <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:gap-5">
        <div className="min-w-0 space-y-8">
          <MembersSection members={follows.members} />
          <TickersSection tickers={follows.tickers} />
        </div>
        <div className="min-w-0 space-y-3">
          <SectionTitle kicker="Email & account">Settings</SectionTitle>
          <AccountSettings
            initial={{
              email: account.email,
              members: account.members,
              tickers: account.tickers,
              clusters: account.clusters,
              weeklyDigest: account.weeklyDigest,
              emailAlerts: account.emailAlerts,
            }}
          />
          <Card className="space-y-3">
            <p className="text-[14px] font-semibold text-foreground">Follow something new</p>
            <AddFollowForm />
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              Or use the Follow button on any <a href="/politicians" className="ink-link">member</a> or{" "}
              <a href="/tickers" className="ink-link">ticker</a> page.
            </p>
          </Card>
        </div>
      </section>

      {nothing ? null : (
        <>
          <CongressActivity follows={follows} />
          <InsiderActivity tickers={follows.tickers} />
          <ClusterAlerts tickers={follows.tickers} clustersOn={account.clusters} />
        </>
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="rounded-[18px] bg-card px-4 py-3 text-[14px] font-medium text-foreground ring-1 ring-black/[0.08] dark:ring-white/[0.12]">
      {children}
    </p>
  );
}

async function MembersSection({ members }: { members: string[] }) {
  let rows: FollowedMember[];
  try {
    rows = await getFollowedMembers(members);
  } catch (e) {
    return <DataError error={e} context="Followed members" />;
  }
  return (
    <div>
      <SectionTitle kicker="Following">Members of Congress</SectionTitle>
      {rows.length === 0 ? (
        <Quiet>
          You follow no members yet. Find one on <a href="/politicians" className="ink-link">Members</a>.
        </Quiet>
      ) : (
        <Card className="p-0 sm:p-0">
          <ul className="inset-rows px-2 py-1.5 [--sep-inset:0.5rem] sm:px-3">
            {rows.map((m) => (
              <MemberItem key={m.bioguide_id} m={m} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function MemberItem({ m }: { m: FollowedMember }) {
  const name = m.name ?? m.bioguide_id;
  const r = m.record;
  return (
    <li data-followed-member={m.bioguide_id} className="flex items-center gap-3 rounded-[10px] px-2 py-3">
      <MemberAvatar name={name} bioguideId={m.bioguide_id} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <a href={memberHref(name, m.bioguide_id)} className="truncate text-[15px] font-semibold hover:underline">
            {memberLabel(name, null, m.state, m.district, m.chamber)}
          </a>
          <PartyBadge party={m.party} />
        </div>
        <p className="tabular mt-0.5 text-[13px] text-muted-foreground">
          {r ? (
            <>
              {plural(r.trades, "trade")} ({r.buys} bought, {r.sells} sold) · disclosed{" "}
              {range(r.volume_min, r.volume_max)} · last traded {shortDate(r.last_tx_date)}
            </>
          ) : (
            "No disclosed trades yet."
          )}
        </p>
      </div>
      <UnfollowButton kind="member" id={m.bioguide_id} label={name} />
    </li>
  );
}

async function TickersSection({ tickers }: { tickers: string[] }) {
  let rows: FollowedTicker[];
  try {
    rows = await getFollowedTickers(tickers);
  } catch (e) {
    return <DataError error={e} context="Followed tickers" />;
  }
  return (
    <div>
      <SectionTitle kicker="Following">Tickers</SectionTitle>
      {rows.length === 0 ? (
        <Quiet>
          You follow no tickers yet. Find one on <a href="/tickers" className="ink-link">Tickers</a>.
        </Quiet>
      ) : (
        <Card className="p-0 sm:p-0">
          <ul className="inset-rows px-2 py-1.5 [--sep-inset:0.5rem] sm:px-3">
            {rows.map((t) => (
              <TickerItem key={t.ticker} t={t} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function TickerItem({ t }: { t: FollowedTicker }) {
  const c = t.congress;
  const i = t.insiders;
  const name = c?.asset_name ?? i?.issuer_name ?? null;
  return (
    <li data-followed-ticker={t.ticker} className="flex items-start gap-3 rounded-[10px] px-2 py-3">
      <a
        href={tickerHref(t.ticker)}
        className="mt-0.5 inline-flex h-7 min-w-14 shrink-0 items-center justify-center rounded-[8px] bg-fill px-2 font-mono text-[13px] font-semibold text-foreground hover:bg-foreground/[0.1]"
      >
        {t.ticker}
      </a>
      <div className="min-w-0 flex-1 space-y-0.5">
        {name ? <p className="truncate text-[14px] font-medium text-foreground">{name}</p> : null}
        <p className="tabular text-[13px] text-muted-foreground">
          <span className="font-medium text-ink-2">Congress:</span>{" "}
          {c ? (
            <>
              {plural(c.trades, "trade")} by {plural(c.politicians, "member")} ({c.buys} bought, {c.sells} sold) ·
              disclosed {range(c.volume_min, c.volume_max)} · last {shortDate(c.last_tx_date)}
            </>
          ) : (
            "no member has traded it"
          )}
        </p>
        <p className="tabular text-[13px] text-muted-foreground">
          <span className="font-medium text-ink-2">Insiders (Form 4):</span>{" "}
          {i ? (
            <a href={insiderIssuerHref(t.ticker)} className="hover:underline">
              {plural(i.trades, "trade")} by {plural(i.insiders, "insider")} ({i.buys} bought, {i.sells} sold) · last{" "}
              {shortDate(i.last_tx_date)}
            </a>
          ) : (
            "no open-market Form 4 trades on file"
          )}
        </p>
      </div>
      <UnfollowButton kind="ticker" id={t.ticker} label={t.ticker} />
    </li>
  );
}

async function CongressActivity({ follows }: { follows: { members: string[]; tickers: string[] } }) {
  try {
    const rows = await getFollowedTrades(follows, 20);
    return (
      <section>
        <SectionTitle kicker="Latest filings" right={<a href={`/feed?watch=${encodeURIComponent([...follows.members, ...follows.tickers].join(","))}#trades`} className="ink-link text-[13px]">Full Following feed →</a>}>
          Congressional trades
        </SectionTitle>
        <FeedList rows={rows} empty="Nothing you follow has a disclosed congressional trade yet." />
      </section>
    );
  } catch (e) {
    return <DataError error={e} context="Congressional trades" />;
  }
}

async function InsiderActivity({ tickers }: { tickers: string[] }) {
  if (tickers.length === 0) return null;
  try {
    const rows = await getFollowedInsiderTrades(tickers, 15);
    return (
      <section>
        <SectionTitle kicker="Latest filings">Corporate insider trades</SectionTitle>
        <p className="mb-3 max-w-[68ch] text-[13px] text-muted-foreground">
          SEC Form 4 open-market trades in the tickers you follow. Values are shares × reported price, kept apart from
          congressional amounts.
        </p>
        {rows.length ? (
          <InsiderTradeList trades={rows} showIssuer />
        ) : (
          <Quiet>No open-market Form 4 trades in the tickers you follow.</Quiet>
        )}
      </section>
    );
  } catch (e) {
    return <DataError error={e} context="Insider trades" />;
  }
}

async function ClusterAlerts({ tickers, clustersOn }: { tickers: string[]; clustersOn: boolean }) {
  if (tickers.length === 0) return null;
  try {
    const alerts = await getFollowedClusterAlerts(tickers, 10);
    return (
      <section>
        <SectionTitle kicker="Alerts" right={<a href="/alerts" className="ink-link text-[13px]">Alert log →</a>}>
          Clusters in your tickers
        </SectionTitle>
        <p className="mb-3 max-w-[68ch] text-[13px] text-muted-foreground">
          Times several members of Congress, or several insiders, traded one of your tickers the same way.{" "}
          {clustersOn
            ? "Your digest includes every cluster alert."
            : "Turn on cluster alerts in Settings to get them by email."}{" "}
          A cluster is not evidence of wrongdoing.
        </p>
        {alerts.length ? (
          <AlertLog>
            {alerts.map((a) => (
              <AlertRowCard key={a.id} alert={a} />
            ))}
          </AlertLog>
        ) : (
          <Quiet>No cluster alert has named a ticker you follow yet.</Quiet>
        )}
      </section>
    );
  } catch (e) {
    return <DataError error={e} context="Cluster alerts" />;
  }
}
