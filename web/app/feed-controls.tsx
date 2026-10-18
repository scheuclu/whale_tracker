import { Download } from "lucide-react";
import { ASSET_TYPE_LABEL, OWNER_LABEL, range } from "@/lib/format";
import {
  CHAMBERS,
  OWNERS,
  PARTIES,
  TRANSCRIBED,
  exportHref,
  feedHref,
  type TransactionFilters,
} from "@/lib/feed-filters";
import type { TransactionTotals } from "@/lib/queries";
import { Card } from "./charts";

/**
 * The feed's filter bar and pagination. Plain GET forms and links: the
 * state is the URL, so a filtered view can be shared, bookmarked and
 * exported, and nothing here needs JavaScript.
 */

const PARTY_LABEL: Record<string, string> = {
  D: "Democrat",
  R: "Republican",
  I: "Independent",
  L: "Libertarian",
};

const CHAMBER_LABEL: Record<string, string> = { house: "House", senate: "Senate" };

const SCANS_LABEL: Record<string, string> = {
  only: "Only transcribed scans",
  exclude: "Exclude transcribed scans",
};

const FIELD =
  "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground " +
  "focus:border-primary/50 focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      <span className="uppercase tracking-[0.06em]">{label}</span>
      {children}
    </label>
  );
}

function Select({
  name,
  value,
  options,
  any,
}: {
  name: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  any: string;
}) {
  // Keep a value the list does not know (an asset code the data uses but
  // the reference table omits) selectable, or the form would drop it.
  const known = options.some((o) => o.value === value);
  return (
    <select name={name} defaultValue={value ?? ""} className={FIELD}>
      <option value="">{any}</option>
      {!known && value ? <option value={value}>{value}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function FilterBar({ filters, ignored }: { filters: TransactionFilters; ignored: string[] }) {
  const active = Object.keys(filters).filter((k) => k !== "action").length > 0;
  return (
    <Card className="mb-4 px-4 py-3">
      <form method="get" action="/" className="flex flex-wrap items-end gap-x-3 gap-y-2">
        {/* The direction pills own this one; the form must not lose it. */}
        {filters.action ? <input type="hidden" name="action" value={filters.action} /> : null}
        {filters.ticker ? <input type="hidden" name="ticker" value={filters.ticker} /> : null}
        <Field label="Chamber">
          <Select
            name="chamber"
            value={filters.chamber}
            any="Both"
            options={CHAMBERS.map((c) => ({ value: c, label: CHAMBER_LABEL[c] }))}
          />
        </Field>
        <Field label="Party">
          <Select
            name="party"
            value={filters.party}
            any="Any"
            options={PARTIES.map((p) => ({ value: p, label: PARTY_LABEL[p] ?? p }))}
          />
        </Field>
        <Field label="Asset type">
          <Select
            name="type"
            value={filters.assetType}
            any="Any"
            options={Object.entries(ASSET_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
          />
        </Field>
        <Field label="Owner">
          <Select
            name="owner"
            value={filters.owner}
            any="Any"
            options={OWNERS.map((o) => ({ value: o, label: o === "self" ? "member" : OWNER_LABEL[o] ?? o }))}
          />
        </Field>
        <Field label="Traded from">
          <input type="date" name="from" defaultValue={filters.from ?? ""} className={FIELD} />
        </Field>
        <Field label="to">
          <input type="date" name="to" defaultValue={filters.to ?? ""} className={FIELD} />
        </Field>
        <Field label="Scans">
          <Select
            name="scans"
            value={filters.transcribed}
            any="Include transcribed scans"
            options={TRANSCRIBED.map((t) => ({ value: t, label: SCANS_LABEL[t] }))}
          />
        </Field>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="h-8 rounded-full border border-primary/40 bg-primary/10 px-3 text-xs font-medium text-foreground transition-colors hover:bg-primary/20"
          >
            Apply
          </button>
          {active ? (
            <a
              href={filters.action ? feedHref({ action: filters.action }) : "/"}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
            >
              Reset
            </a>
          ) : null}
        </div>
      </form>
      {ignored.length ? (
        <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          Ignored unrecognised filter{ignored.length === 1 ? "" : "s"}: {ignored.join(", ")}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * "Trades 121–240 of 5,928 · disclosed total …". The total is the whole
 * filtered set's, not this page's: the feed paginates, and a figure summed
 * over one page would understate what it claims. It is a range because the
 * disclosures are brackets; an open-ended bracket anywhere in the set makes
 * the ceiling unknowable and the total reads "≥ floor".
 */
export function ShownLine({
  offset,
  shown,
  totals,
}: {
  offset: number;
  shown: number;
  totals: TransactionTotals;
}) {
  const all = totals.trades;
  const span = shown === all ? `${all.toLocaleString()} trades` : `Trades ${(offset + 1).toLocaleString()}–${(offset + shown).toLocaleString()} of ${all.toLocaleString()}`;
  const counted = all - totals.transcribed;
  return (
    <p className="mb-3 text-xs text-muted-foreground">
      {span} · disclosed total {range(totals.volume_min, totals.volume_max)}
      {shown === all ? "" : ` across all ${all.toLocaleString()}`}
      {totals.transcribed
        ? ` · ${totals.transcribed.toLocaleString()} transcribed from scans, not in the total (${counted.toLocaleString()} counted)`
        : ""}
    </p>
  );
}

export function ExportLink({ filters, className }: { filters: TransactionFilters; className?: string }) {
  return (
    <a
      href={exportHref(filters)}
      className={
        className ??
        "inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      }
      title="Every matching trade as CSV. Amounts are exported as min/max bracket columns."
      download
    >
      <Download className="size-3" aria-hidden />
      CSV
    </a>
  );
}

/**
 * Pagination as offset links. "Load more" is the next page, newest first;
 * the whole-set totals above do not change as the reader pages.
 */
export function Pagination({
  filters,
  offset,
  shown,
  total,
  page,
}: {
  filters: TransactionFilters;
  offset: number;
  shown: number;
  total: number;
  page: number;
}) {
  const more = offset + shown < total;
  const newer = offset > 0;
  if (!more && !newer) return null;
  const pill =
    "rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
  return (
    <nav className="mt-4 flex items-center justify-center gap-2" aria-label="Trade list pages">
      {newer ? (
        <a href={feedHref(filters, Math.max(offset - page, 0))} className={pill}>
          ← Newer
        </a>
      ) : null}
      {more ? (
        <a href={feedHref(filters, offset + page)} className={pill} rel="next">
          Load more ({(total - offset - shown).toLocaleString()} older)
        </a>
      ) : null}
    </nav>
  );
}
