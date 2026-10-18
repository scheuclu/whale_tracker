import assert from "node:assert/strict";
import { test } from "node:test";

import { duration } from "./format.ts";
import { medianGapHours, parseRecentRuns, type PipelineRun } from "./queries.ts";

// The run log is JSON the pipeline writes into sync_state.recent_runs
// (pipeline.RunTally.entry). The page reads whatever a newer or older
// pipeline left there, so the parser must shrug at shapes it does not know
// rather than take the Pipeline page down with a thrown error.

function entry(started: string, over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    started,
    finished: started,
    duration_s: 61.5,
    filings_parsed: 2,
    alerts_sent: 1,
    scans_transcribed: 0,
    insiders_stored: 4,
    outcome: "ok",
    error: null,
    ...over,
  };
}

test("parseRecentRuns reads the log the pipeline writes, newest first as stored", () => {
  const raw = JSON.stringify([
    entry("2026-10-18T07:31:10Z"),
    entry("2026-10-18T04:17:02Z", { outcome: "failed", error: "RuntimeError: telegram down" }),
  ]);
  const runs = parseRecentRuns(raw);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], entry("2026-10-18T07:31:10Z"));
  assert.equal(runs[1].outcome, "failed");
  assert.equal(runs[1].error, "RuntimeError: telegram down");
});

test("a missing, malformed or non-list value is an empty log, not an error", () => {
  assert.deepEqual(parseRecentRuns(null), []);
  assert.deepEqual(parseRecentRuns(""), []);
  assert.deepEqual(parseRecentRuns("{not json"), []);
  assert.deepEqual(parseRecentRuns('{"a": 1}'), []);
  assert.deepEqual(parseRecentRuns("[1, \"x\", null]"), []);
});

test("an entry without a start time is dropped; other gaps read as unknown, never as success", () => {
  const runs = parseRecentRuns(
    JSON.stringify([
      { started: "2026-10-18T07:31:10Z" },
      { finished: "2026-10-18T07:31:10Z", outcome: "ok" },
      { started: "2026-10-18T04:17:02Z", outcome: "crashed", filings_parsed: "3" },
    ])
  );
  assert.equal(runs.length, 2);
  assert.equal(runs[0].duration_s, null);
  assert.equal(runs[0].filings_parsed, 0);
  assert.equal(runs[0].outcome, "failed");
  assert.equal(runs[1].outcome, "failed");
  assert.equal(runs[1].filings_parsed, 0);
});

test("medianGapHours measures what GitHub delivered, in any order", () => {
  assert.equal(medianGapHours([]), null);
  assert.equal(medianGapHours([entry("2026-10-18T07:31:10Z")]), null);
  const runs = [
    entry("2026-10-18T06:00:00Z"),
    entry("2026-10-18T00:00:00Z"),
    entry("2026-10-18T01:30:00Z"),
  ];
  // gaps 1.5 h and 4.5 h
  assert.equal(medianGapHours(runs), 3);
  runs.push(entry("2026-10-18T09:00:00Z")); // gaps 1.5, 4.5, 3 -> median 3
  assert.equal(medianGapHours(runs), 3);
  assert.equal(medianGapHours([entry("not a date"), entry("2026-10-18T09:00:00Z")]), null);
});

test("duration renders seconds, minutes and hours; unknown as a dash", () => {
  assert.equal(duration(48), "48s");
  assert.equal(duration(61.5), "1m 02s");
  assert.equal(duration(185), "3m 05s");
  assert.equal(duration(4320), "1h 12m");
  assert.equal(duration(null), "—");
  assert.equal(duration(-1), "—");
});
