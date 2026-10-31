import type { Metadata } from "next";
import { cookies } from "next/headers";
import { isAdminEmail, sortAccounts, summarizeAccounts, type FollowCount } from "@/lib/admin";
import { getFollowNames } from "@/lib/admin-queries";
import { googleCredentials, readSession, SESSION_COOKIE } from "@/lib/auth";
import { resendConfigured } from "@/lib/email-digest";
import { insiderHref, memberHref, shortDate, tickerHref } from "@/lib/format";
import { pageMetadata } from "@/lib/seo";
import { plural } from "@/lib/site";
import { subscriptionBackend } from "@/lib/subscription-blob";
import { listAllSubscriptions, receivesDigest, type StoredSubscription } from "@/lib/subscription-store";
import { alertsSecret } from "@/lib/subscription-token";
import { SignInPanel } from "../account-client";
import { Card, ColumnSeries, SectionTitle, StatTile } from "../charts";
import { DataTable } from "../data-table";
import { DataError, PAGE_STACK, PageHeader, Quiet } from "../page-header";
import { StatusNote } from "../ui";

/**
 * The operator's view of reader accounts: who signed up, when, and what each
 * one follows and gets emailed. Read straight from the account store on
 * every request.
 *
 * Rendered from the session cookie, so — like `/account` — it is left out of
 * the CDN page cache (`PAGE_SOURCE` in lib/cache-policy.ts) and Next sends
 * it `private, no-store`. Only a session whose address is in `ADMIN_EMAILS`
 * sees anything (lib/admin.ts); everyone else gets the sign-in panel or a
 * refusal, never a count. No analytics events: every row is an address.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Accounts",
  description: "Reader accounts on FatCat Watch and what each one follows. For the site operator only.",
  path: "/admin",
  noindex: true,
});

const WEEKS = 12;

type Gate =
  | { state: "unconfigured" }
  | { state: "signed_out" }
  | { state: "refused"; email: string }
  | { state: "admin"; email: string };

async function gate(): Promise<Gate> {
  const secret = alertsSecret();
  if (!secret || !subscriptionBackend()) return { state: "unconfigured" };
  const session = readSession((await cookies()).get(SESSION_COOKIE)?.value, secret);
  if (!session) return { state: "signed_out" };
  return isAdminEmail(session.email) ? { state: "admin", email: session.email } : { state: "refused", email: session.email };
}

export default async function AdminPage() {
  const g = await gate();
  const header = (
    <PageHeader eyebrow="Admin" title="Accounts" subtitle="Who signed up, and what each account follows and gets by email." />
  );

  if (g.state !== "admin") {
    return (
      <div className={PAGE_STACK}>
        {header}
        {g.state === "unconfigured" ? (
          <Quiet>Accounts are not configured on this deployment.</Quiet>
        ) : g.state === "refused" ? (
          <Quiet>
            This page is for the site operator. You are signed in as {g.email}, which is not an admin address.
          </Quiet>
        ) : (
          <div className="max-w-[440px] space-y-3">
            <Quiet>For the site operator: sign in with an admin address.</Quiet>
            <SignInPanel
              next="/admin"
              error={null}
              googleEnabled={googleCredentials() !== null}
              emailEnabled={resendConfigured()}
            />
          </div>
        )}
      </div>
    );
  }

  let accounts: StoredSubscription[];
  let unreadable: number;
  try {
    ({ accounts, unreadable } = await listAllSubscriptions(subscriptionBackend()!));
  } catch (e) {
    return (
      <div className={PAGE_STACK}>
        {header}
        <DataError error={e} context="Account store" />
      </div>
    );
  }

  const s = summarizeAccounts(accounts, new Date(), WEEKS);
  const names = await getFollowNames(
    s.members.map((m) => m.id),
    s.insiders.map((i) => i.id)
  ).catch(() => ({ members: new Map<string, string>(), insiders: new Map<string, string>() }));
  const weeks = s.signupsByWeek.map((w) => ({ ...w, label: weekLabel(w.week) }));

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        eyebrow={`Admin · ${g.email}`}
        title="Accounts"
        subtitle="Who signed up, and what each account follows and gets by email. Read from the account store on every load."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Accounts" value={String(s.total)} hint={`${s.verified} confirmed`} />
          <StatTile label="New, last 7 days" value={String(s.newLast7Days)} hint={`${s.newLast30Days} in the last 30 days`} />
          <StatTile label="Get the digest" value={String(s.receivingDigest)} hint={`${s.unsubscribed} unsubscribed`} />
          <StatTile
            label="Follow something"
            value={String(s.followingSomething)}
            hint={`${s.clusters} cluster alerts · ${s.weeklyDigest} weekly`}
          />
        </div>
      </PageHeader>

      {unreadable > 0 ? (
        <StatusNote tone="error" as="p" className="text-[14px] text-foreground">
          {plural(unreadable, "account record")} could not be read and {unreadable === 1 ? "is" : "are"} not counted
          above.
        </StatusNote>
      ) : null}

      <section>
        <SectionTitle right={<span>UTC weeks from Monday</span>}>Signups per week</SectionTitle>
        <Card>
          <ColumnSeries
            data={weeks.map((w) => ({
              key: w.week,
              label: w.label,
              value: w.signups,
              valueLabel: plural(w.signups, "signup"),
            }))}
          />
          <DataTable
            caption={`Accounts created per week, last ${WEEKS} weeks`}
            columns={["Week of", "Signups"]}
            rows={weeks.map((w) => [w.label, w.signups])}
          />
        </Card>
      </section>

      <section>
        <SectionTitle>Most followed</SectionTitle>
        <div className="grid gap-3 md:grid-cols-3">
          <FollowList
            title="Members"
            rows={s.members}
            href={(id) => memberHref(names.members.get(id) ?? id, id)}
            label={(id) => names.members.get(id) ?? id}
          />
          <FollowList title="Tickers" rows={s.tickers} href={tickerHref} label={(id) => id} mono />
          <FollowList
            title="Insiders"
            rows={s.insiders}
            href={(id) => insiderHref(names.insiders.get(id), id)}
            label={(id) => names.insiders.get(id) ?? `CIK ${id}`}
          />
        </div>
      </section>

      <section>
        <SectionTitle right={<span>newest first</span>}>Every account</SectionTitle>
        {accounts.length === 0 ? (
          <Quiet>No one has signed up yet.</Quiet>
        ) : (
          <Card className="p-0 sm:p-0">
            <ul className="inset-rows px-2 py-1.5 [--sep-inset:0.5rem] sm:px-3">
              {sortAccounts(accounts).map((a) => (
                <AccountItem key={a.id} a={a} names={names} />
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

function weekLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const TOP = 10;

function FollowList({
  title,
  rows,
  href,
  label,
  mono = false,
}: {
  title: string;
  rows: FollowCount[];
  href: (id: string) => string;
  label: (id: string) => string;
  mono?: boolean;
}) {
  return (
    <Card className="space-y-2">
      <p className="text-[14px] font-semibold text-foreground">
        {title} <span className="font-normal text-muted-foreground">· {rows.length} followed</span>
      </p>
      {rows.length === 0 ? (
        <Quiet className="text-[13px]">None followed yet.</Quiet>
      ) : (
        <ol className="space-y-1 text-[14px]">
          {rows.slice(0, TOP).map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-3">
              <a href={href(r.id)} className={mono ? "truncate font-mono text-[13px] hover:underline" : "truncate hover:underline"}>
                {label(r.id)}
              </a>
              <span className="tabular shrink-0 text-[13px] text-muted-foreground">{plural(r.followers, "follower")}</span>
            </li>
          ))}
        </ol>
      )}
      {rows.length > TOP ? <p className="text-[12.5px] text-muted-foreground">and {rows.length - TOP} more</p> : null}
    </Card>
  );
}

/** What the digest sender does with this record, in words (lib/subscription-store.ts `receivesDigest`). */
function emailState(a: StoredSubscription): { tone: "ok" | "attention"; text: string } {
  if (!a.verified) return { tone: "attention", text: "Not confirmed" };
  if (!a.emailAlerts) return { tone: "attention", text: "Unsubscribed" };
  return receivesDigest(a) ? { tone: "ok", text: "Gets the digest" } : { tone: "attention", text: "Nothing to email" };
}

function AccountItem({
  a,
  names,
}: {
  a: StoredSubscription;
  names: { members: Map<string, string>; insiders: Map<string, string> };
}) {
  const state = emailState(a);
  const nothing = a.members.length + a.tickers.length + a.insiders.length === 0;
  return (
    <li data-admin-account={a.email} className="space-y-1.5 rounded-[10px] px-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <a href={`mailto:${a.email}`} className="min-w-0 break-all text-[15px] font-semibold hover:underline">
          {a.email}
        </a>
        <StatusNote tone={state.tone} className="shrink-0 text-[13px] text-ink-2">
          {state.text}
        </StatusNote>
      </div>
      <p className="tabular text-[13px] text-muted-foreground">
        Signed up {shortDate(a.createdAt.slice(0, 10))} · last change {shortDate(a.updatedAt.slice(0, 10))} · last
        digest {a.lastSentDate ? shortDate(a.lastSentDate) : "never"} · cluster alerts {a.clusters ? "on" : "off"} ·
        weekly roundup {a.weeklyDigest ? "on" : "off"}
      </p>
      {nothing ? (
        <p className="text-[13px] text-muted-foreground">Follows nothing yet.</p>
      ) : (
        <dl className="space-y-0.5 text-[13px]">
          <Follows label="Members" ids={a.members} render={(id) => (
            <a href={memberHref(names.members.get(id) ?? id, id)} className="hover:underline">
              {names.members.get(id) ?? id}
            </a>
          )} />
          <Follows label="Tickers" ids={a.tickers} render={(id) => (
            <a href={tickerHref(id)} className="font-mono hover:underline">
              {id}
            </a>
          )} />
          <Follows label="Insiders" ids={a.insiders} render={(id) => (
            <a href={insiderHref(names.insiders.get(id), id)} className="hover:underline">
              {names.insiders.get(id) ?? `CIK ${id}`}
            </a>
          )} />
        </dl>
      )}
    </li>
  );
}

function Follows({ label, ids, render }: { label: string; ids: string[]; render: (id: string) => React.ReactNode }) {
  if (ids.length === 0) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 font-medium text-ink-2">{label}</dt>
      <dd className="min-w-0 text-foreground">
        {ids.map((id, i) => (
          <span key={id}>
            {i > 0 ? ", " : null}
            {render(id)}
          </span>
        ))}
      </dd>
    </div>
  );
}
