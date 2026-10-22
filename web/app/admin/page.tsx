import type { Metadata } from "next";

import { getAdminSession } from "@/lib/admin-session";
import { topicLabel } from "@/lib/contact";
import { contactBackend } from "@/lib/contact-blob";
import { ADMIN_PAGE_SIZE, listMessages, parseMessageFilter, SCAN_LIMIT, type AdminMessage } from "@/lib/contact-store";
import { cn } from "@/lib/utils";
import { Card, Empty } from "../charts";
import { PAGE_STACK, PageHeader } from "../page-header";
import { BUTTON, BUTTON_PRIMARY, FIELD, FOCUS_RING, Segmented, Tag } from "../ui";
import { signOutAdmin, toggleHandled } from "./actions";
import { AdminSignIn } from "./sign-in";

// Per request, never cached: lib/cache-policy.ts keeps /admin out of the CDN
// page rule and next.config.ts marks it no-store and noindex.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

function when(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function replyHref(m: AdminMessage): string {
  const subject = `Re: your message to FatCat Watch (${topicLabel(m.topic).toLowerCase()})`;
  return `mailto:${encodeURIComponent(m.email).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}`;
}

function MessageCard({ m }: { m: AdminMessage }) {
  const handled = m.handledAt !== null;
  return (
    <li>
      <Card className={cn("space-y-2.5", handled && "opacity-75")}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
          <Tag variant="outline">{topicLabel(m.topic)}</Tag>
          <span className="min-w-0 break-all font-medium text-foreground">
            {m.name ? `${m.name} · ` : null}
            {m.email}
          </span>
          <time dateTime={m.createdAt.toISOString()} className="tabular text-xs text-muted-foreground">
            {when(m.createdAt)}
          </time>
          {handled ? (
            <span className="text-xs text-ok">handled {when(m.handledAt!)}</span>
          ) : (
            <span className="text-xs font-medium text-attention">open</span>
          )}
          <div className="ml-auto flex gap-2">
            <a href={replyHref(m)} className={BUTTON}>
              Reply
            </a>
            {/* A form, so triage works before hydration and without JS. */}
            <form action={toggleHandled.bind(null, m.id, !handled)}>
              <button type="submit" className={handled ? BUTTON : BUTTON_PRIMARY}>
                {handled ? "Reopen" : "Mark handled"}
              </button>
            </form>
          </div>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-2">{m.message}</p>
      </Card>
    </li>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; q?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const session = await getAdminSession();
  if (!session) {
    const error = typeof params.error === "string" ? params.error : null;
    return <AdminSignIn error={error === null ? null : error === "AccessDenied" ? "denied" : "failed"} />;
  }

  const filter = parseMessageFilter(params.status);
  const query = (typeof params.q === "string" ? params.q : "").trim().slice(0, 200);

  const header = (
    <PageHeader
      eyebrow="Admin"
      title="Contact messages"
      subtitle={`Signed in as ${session.label}.`}
      aside={
        <form action={signOutAdmin}>
          <button type="submit" className={BUTTON}>
            Sign out
          </button>
        </form>
      }
    />
  );

  const backend = contactBackend();
  if (!backend) {
    return (
      <div className={PAGE_STACK}>
        {header}
        <Empty>No Blob store is connected to this deployment (BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN), so there are no messages to read.</Empty>
      </div>
    );
  }

  let data: Awaited<ReturnType<typeof listMessages>>;
  try {
    data = await listMessages(backend, { filter, query });
  } catch (err) {
    console.error("[admin] could not list messages", err);
    return (
      <div className={PAGE_STACK}>
        {header}
        <Empty>Messages could not be loaded from the Blob store. Check the function logs.</Empty>
      </div>
    );
  }

  const href = (status: string) => {
    const sp = new URLSearchParams({ status });
    if (query) sp.set("q", query);
    return `/admin?${sp}`;
  };

  return (
    <div className={PAGE_STACK}>
      {header}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="Message state"
            items={[
              { key: "open", label: `Open · ${data.open}`, href: href("open"), active: filter === "open" },
              { key: "handled", label: `Handled · ${data.handled}`, href: href("handled"), active: filter === "handled" },
              { key: "all", label: `All · ${data.open + data.handled}`, href: href("all"), active: filter === "all" },
            ]}
          />
          {/* A GET form: the search is in the URL, survives a reload, needs no JS. */}
          <form method="get" action="/admin" role="search" className="flex w-full gap-2 sm:w-auto">
            <input type="hidden" name="status" value={filter} />
            <label htmlFor="admin-q" className="sr-only">
              Search by email
            </label>
            <input
              id="admin-q"
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Search by email"
              className={cn(FIELD, FOCUS_RING, "sm:w-64")}
            />
            <button type="submit" className={BUTTON}>
              Search
            </button>
          </form>
        </div>
        <p className="text-xs text-muted-foreground">
          {data.matched === 0
            ? "No messages match."
            : data.matched > ADMIN_PAGE_SIZE
              ? `Newest ${ADMIN_PAGE_SIZE} of ${data.matched} matching messages.`
              : `${data.matched} matching message${data.matched === 1 ? "" : "s"}, newest first.`}
          {data.truncated ? ` Only the newest ${SCAN_LIMIT} were read; ${data.truncated} older are not shown.` : null}
          {data.unreadable ? ` ${data.unreadable} stored file${data.unreadable === 1 ? "" : "s"} could not be read as a message.` : null}
          {query ? (
            <>
              {" "}
              <a href={`/admin?status=${filter}`} className="underline underline-offset-2 hover:text-primary">
                Clear search
              </a>
            </>
          ) : null}
        </p>
        {data.rows.length ? (
          <ul className="space-y-3">
            {data.rows.map((m) => (
              <MessageCard key={m.id} m={m} />
            ))}
          </ul>
        ) : (
          <Empty>{filter === "open" && !query ? "Nothing open. Every message has been handled." : "Nothing here."}</Empty>
        )}
      </section>
    </div>
  );
}
