/**
 * `/api/health`: one URL an uptime monitor can poll to learn whether the
 * dashboard can read its data and whether that data is still being kept
 * current. Pure apart from `readHealthInputs`, so the verdict is testable.
 *
 * Two clocks, because they answer different questions:
 *
 * - the **last pipeline write** (`MAX(sync_state.updated_at)`): every
 *   scheduled run writes its source statuses and run log there, including a
 *   run that found nothing new. This is what goes stale when the pipeline
 *   stops, so it is what the threshold is applied to;
 * - the **last filing write** (`MAX(filings.updated_at)`): the `data_as_of`
 *   the API and the header pill report. On a quiet day no filing changes for
 *   many hours while the pipeline is perfectly healthy, so it is reported
 *   but never judged.
 *
 * Nothing secret is returned: no error text (it can name configuration),
 * no environment, no paths. The operator reads the cause on /pipeline or in
 * the runtime logs.
 */

import { parseRecentRuns } from "./queries";

/**
 * Past this the header's sync pill turns amber and the health check reports
 * `degraded`. The poll is scheduled every 90 minutes, but GitHub delivers
 * scheduled runs late and unevenly (a ~5 h median gap), so a few hours
 * without a write is normal, not stale.
 */
export const STALE_AFTER_HOURS = 12;

/** This many newest runs failing in a row reports `degraded`. */
export const FAILED_RUNS_DEGRADED = 2;

export type HealthInputs = {
  /** Last write by any pipeline run (sync_state), ISO 8601. */
  lastPipelineWrite: string | null;
  /** Last filing change (filings), ISO 8601 — the API's `data_as_of`. */
  lastFilingWrite: string | null;
  /** Outcome of the newest logged run, if the log has one. */
  lastRunOutcome: "ok" | "failed" | null;
  /** Newest runs in a row whose outcome was `failed`. */
  consecutiveFailedRuns: number;
};

export type HealthReport = {
  status: "ok" | "degraded";
  checked_at: string;
  checks: {
    database: { ok: boolean };
    freshness: {
      ok: boolean;
      last_pipeline_write: string | null;
      age_hours: number | null;
      stale_after_hours: number;
      last_filing_write: string | null;
      last_run_outcome: "ok" | "failed" | null;
      consecutive_failed_runs: number;
    };
  };
  /** Why the status is `degraded`, in words; empty when ok. */
  problems: string[];
};

/** Parse a stored timestamp as UTC (`2026-10-22T13:13:51Z`; a bare `YYYY-MM-DD HH:MM:SS` is UTC too). */
export function parseUtc(ts: string | null): number | null {
  if (!ts) return null;
  let s = ts.trim().replace(" ", "T");
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += "Z";
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** The threshold: `HEALTH_STALE_AFTER_HOURS` when it is a positive number, else the default. */
export function staleAfterHours(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HEALTH_STALE_AFTER_HOURS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : STALE_AFTER_HOURS;
}

export function assessHealth(
  inputs: HealthInputs | null,
  { now = Date.now(), staleAfter = STALE_AFTER_HOURS }: { now?: number; staleAfter?: number } = {}
): HealthReport {
  const checkedAt = new Date(now).toISOString();
  const problems: string[] = [];
  if (!inputs) {
    problems.push("database unreachable");
    return {
      status: "degraded",
      checked_at: checkedAt,
      checks: {
        database: { ok: false },
        freshness: {
          ok: false,
          last_pipeline_write: null,
          age_hours: null,
          stale_after_hours: staleAfter,
          last_filing_write: null,
          last_run_outcome: null,
          consecutive_failed_runs: 0,
        },
      },
      problems,
    };
  }
  const written = parseUtc(inputs.lastPipelineWrite);
  const ageHours = written === null ? null : Math.round(((now - written) / 3_600_000) * 100) / 100;
  let fresh = true;
  if (ageHours === null) {
    fresh = false;
    problems.push("no pipeline write recorded");
  } else if (ageHours > staleAfter) {
    fresh = false;
    problems.push(`last pipeline write ${ageHours.toFixed(1)} h ago (threshold ${staleAfter} h)`);
  }
  // A failed run still writes its log entry, so a pipeline failing on every
  // run would look fresh by the clock alone. One failure is a passing error
  // (a source timing out); two in a row is the pipeline being broken.
  if (inputs.consecutiveFailedRuns >= FAILED_RUNS_DEGRADED) {
    fresh = false;
    problems.push(`last ${inputs.consecutiveFailedRuns} pipeline runs failed`);
  }
  return {
    status: problems.length ? "degraded" : "ok",
    checked_at: checkedAt,
    checks: {
      database: { ok: true },
      freshness: {
        ok: fresh,
        last_pipeline_write: inputs.lastPipelineWrite,
        age_hours: ageHours,
        stale_after_hours: staleAfter,
        last_filing_write: inputs.lastFilingWrite,
        last_run_outcome: inputs.lastRunOutcome,
        consecutive_failed_runs: inputs.consecutiveFailedRuns,
      },
    },
    problems,
  };
}

/** The three facts, read in one pass. Throws when the database cannot be opened or read. */
export function readHealthInputs(db: {
  prepare: (sql: string) => { get: () => unknown };
}): HealthInputs {
  const row = db
    .prepare(
      `SELECT (SELECT MAX(updated_at) FROM sync_state) AS pipeline,
              (SELECT MAX(updated_at) FROM filings) AS filing,
              (SELECT value FROM sync_state WHERE key = 'recent_runs') AS runs`
    )
    .get() as { pipeline: string | null; filing: string | null; runs: string | null };
  // Newest first, as pipeline.record_run keeps it (and parseRecentRuns reads it).
  const runs = parseRecentRuns(row.runs);
  let failed = 0;
  while (failed < runs.length && runs[failed].outcome === "failed") failed++;
  return {
    lastPipelineWrite: row.pipeline,
    lastFilingWrite: row.filing,
    lastRunOutcome: runs[0]?.outcome ?? null,
    consecutiveFailedRuns: failed,
  };
}
