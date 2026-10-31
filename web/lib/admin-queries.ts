import { getDb } from "./db";

/**
 * Display names for the ids accounts follow, for `/admin`. A member's id that
 * is not in the roster, or a CIK with no stored Form 4, has no entry: the
 * page shows the id itself rather than inventing a name.
 */
export async function getFollowNames(
  bioguideIds: string[],
  ciks: string[]
): Promise<{ members: Map<string, string>; insiders: Map<string, string> }> {
  const db = await getDb();
  const lookup = (sql: (marks: string) => string, ids: string[]) =>
    ids.length === 0
      ? new Map<string, string>()
      : new Map(
          (db.prepare(sql(ids.map(() => "?").join(","))).all(...ids) as { id: string; name: string }[]).map((r) => [
            r.id,
            r.name,
          ])
        );
  return {
    members: lookup((m) => `SELECT bioguide_id AS id, full_name AS name FROM politicians WHERE bioguide_id IN (${m})`, bioguideIds),
    insiders: lookup((m) => `SELECT cik AS id, name FROM insiders WHERE cik IN (${m})`, ciks),
  };
}
