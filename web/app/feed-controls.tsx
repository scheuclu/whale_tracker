import { ChevronDown, Download } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { BUTTON, BUTTON_PRIMARY, FIELD, MoneyText } from "./ui";

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

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
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
    <span className="relative flex">
      <select name={name} defaultValue={value ?? ""} className={cn(FIELD, "cursor-pointer appearance-none pr-8")}>
        <option value="">{any}</option>
        {!known && value ? <option value={value}>{value}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </span>
  );
}

export function FilterBar({ filters, ignored }: { filters: TransactionFilters; ignored: string[] }) {
  const active = Object.keys(filters).filter((k) => k !== "action").length > 0;
  return (
    <Card className="mb-4 px-4 py-4 sm:px-5">
      <form
        method="get"
        action="/"
        className="grid grid-cols-2 items-end gap-x-3 gap-y-3 sm:grid-cols-4 lg:grid-cols-[repeat(4,minmax(0,1fr))_repeat(2,minmax(0,1.15fr))_minmax(0,1.75fr)_auto]"
      >
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
          <input type="date" name="from" defaultValue={filters.from ?? ""} className={cn(FIELD, "tabular")} />
        </Field>
        <Field label="to">
          <input type="date" name="to" defaultValue={filters.to ?? ""} className={cn(FIELD, "tabular")} />
        </Field>
        <Field label="Scans" className="col-span-2 sm:col-span-1">
          <Select
            name="scans"
            value={filters.transcribed}
            any="Include transcribed scans"
            options={TRANSCRIBED.map((t) => ({ value: t, label: SCANS_LABEL[t] }))}
          />
        </Field>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-3 lg:col-span-1">
          <button type="submit" className={BUTTON_PRIMARY}>
            Apply
          </button>
          {active ? (
            <a href={filters.action ? feedHref({ action: filters.action }) : "/"} className={BUTTON}>
              Reset
            </a>
          ) : null}
        </div>
      </form>
      {ignored.length ? (
        <p className="mt-3 text-xs text-attention">
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
      {span} · disclosed total <MoneyText value={range(totals.volume_min, totals.volume_max)} className="text-ink-2" />
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
        cn(BUTTON, "h-7 px-2.5 text-[11px]")
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
  const pill = BUTTON;
  return (
    <nav className="mt-4 flex items-center justify-center gap-2" aria-label="Trade list pages">
      {newer ? (
        <a href={feedHref(filters, Math.max(offset - page, 0))} className={pill}>
          ← Newer
        </a>
      ) : null}
      {more ? (
        <a href={feedHref(filters, offset + page)} className={pill} rel="next">
          Load more
          <span className="tabular font-normal text-muted-foreground">
            ({(total - offset - shown).toLocaleString()} older)
          </span>
        </a>
      ) : null}
    </nav>
  );
}
