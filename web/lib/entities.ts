import type Database from "better-sqlite3";

import { getDb } from "./db";
import { memberSlug, slugBioguide } from "./format";
import { COUNTED } from "./queries";

/**
 * URL identity for members and tickers: slug → the display name every query
 * keys on, and the lists the sitemap enumerates.
 *
 * A member is still *grouped* by display name (`COALESCE(p.full_name,
 * f.filer_name)`, as everywhere in queries.ts); the slug only has to find
 * that name again. Roster-matched members resolve by bioguide id, so a URL
 * keeps working when the roster respells the name; an unmatched filer
 * resolves by the slug of the name printed on the PDF.
 */

export type MemberRef = {
  name: string;
  bioguideId: string | null;
  /** The canonical slug; differs from the requested one when it must redirect. */
  slug: string;
};

type Entry = { name: string; bioguideId: string | null; weight: number };
type Index = { byBioguide: Map<string, Entry>; bySlug: Map<string, Entry> };

const indexes = new WeakMap<Database.Database, Index>();

/**
 * Every name a member page can be asked for — from filings of any status,
 * so a member whose only filings are unread scans (linked from /scans)
 * still resolves. Built once per database handle; the handle is replaced
 * when the TTL refetches the file, which rebuilds it.
 */
function memberIndex(db: Database.Database): Index {
  let idx = indexes.get(db);
  if (idx) return idx;
  const rows = db
    .prepare(
      `SELECT COALESCE(p.full_name, f.filer_name) AS name, p.bioguide_id AS bioguide_id,
              COUNT(*) AS weight
       FROM filings f
       LEFT JOIN politicians p ON p.id = f.politician_id
       GROUP BY name, p.bioguide_id`
    )
    .all() as { name: string; bioguide_id: string | null; weight: number }[];
  idx = { byBioguide: new Map(), bySlug: new Map() };
  // A name with a roster row anywhere is that member; its unmatched filings
  // group under the same name, so the id is the one to put in the URL.
  const byName = new Map<string, Entry>();
  for (const r of rows) {
    const prev = byName.get(r.name);
    const weight = (prev?.weight ?? 0) + r.weight;
    const bioguideId = prev?.bioguideId ?? r.bioguide_id ?? null;
    byName.set(r.name, { name: r.name, bioguideId, weight });
  }
  for (const r of rows) {
    if (r.bioguide_id && !idx.byBioguide.has(r.bioguide_id)) idx.byBioguide.set(r.bioguide_id, byName.get(r.name)!);
  }
  for (const e of byName.values()) {
    const key = memberSlug(e.name);
    const prev = idx.bySlug.get(key);
    // Two names with one slug ("Smith, J." / "Smith J"): the busier wins, the
    // other stays reachable through its bioguide id if it has one.
    if (!prev || e.weight > prev.weight) idx.bySlug.set(key, e);
  }
  indexes.set(db, idx);
  return idx;
}

/** The member a `/members/<slug>` URL names, or null when nobody matches. */
export async function resolveMemberSlug(raw: string): Promise<MemberRef | null> {
  const slug = raw.toLowerCase();
  const idx = memberIndex(await getDb());
  const bioguide = slugBioguide(slug);
  const entry = (bioguide && idx.byBioguide.get(bioguide)) || idx.bySlug.get(slug);
  if (!entry) return null;
  // Canonical id: the one in the URL when it named this member, else the name's.
  const id = bioguide && idx.byBioguide.get(bioguide) === entry ? bioguide : entry.bioguideId;
  return { name: entry.name, bioguideId: id, slug: memberSlug(entry.name, id) };
}

/** The member a legacy `?m=<display name>` link meant, by exact name. */
export async function resolveMemberName(name: string): Promise<MemberRef | null> {
  const idx = memberIndex(await getDb());
  for (const e of idx.bySlug.values()) {
    if (e.name === name) return { name: e.name, bioguideId: e.bioguideId, slug: memberSlug(e.name, e.bioguideId) };
  }
  // Not an exact name (a hand-edited link): try it as a slug of one.
  return resolveMemberSlug(memberSlug(name));
}

export type SitemapMember = { name: string; bioguide_id: string | null; last_filed: string | null };
export type SitemapTicker = { ticker: string; last_filed: string | null };

/** Every member with at least one counted trade, and the date they last filed. */
export async function getSitemapMembers(): Promise<SitemapMember[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT COALESCE(p.full_name, f.filer_name) AS name,
              MAX(p.bioguide_id) AS bioguide_id,
              MAX(f.filing_date) AS last_filed
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       LEFT JOIN politicians p ON p.id = t.politician_id
       WHERE f.status IN ${COUNTED}
       GROUP BY name
       ORDER BY name`
    )
    .all() as SitemapMember[];
}

/** Every ticker with at least one counted trade, and when it last appeared in a filing. */
export async function getSitemapTickers(): Promise<SitemapTicker[]> {
  const db = await getDb();
  return db
    .prepare(
      `SELECT t.ticker, MAX(f.filing_date) AS last_filed
       FROM transactions t
       JOIN filings f ON f.id = t.filing_id
       WHERE f.status IN ${COUNTED} AND t.ticker IS NOT NULL AND t.ticker != ''
       GROUP BY t.ticker
       ORDER BY t.ticker`
    )
    .all() as SitemapTicker[];
}

/**
 * The span of filing dates with counted trades — the dataset's temporal
 * coverage and the section pages' lastmod. Filing dates, not trade dates: a
 * few filings carry mistyped trade dates decades off, and the corpus is the
 * filings.
 */
export async function getFilingSpan(): Promise<{ first: string | null; last: string | null }> {
  const db = await getDb();
  return db
    .prepare(`SELECT MIN(filing_date) AS first, MAX(filing_date) AS last FROM filings WHERE status IN ${COUNTED}`)
    .get() as { first: string | null; last: string | null };
}
