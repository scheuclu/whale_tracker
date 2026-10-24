import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTrackRecord } from "./api-v1.ts";
import { getMemberTrack, getTrackLeaderboard } from "./track-queries.ts";

// Against the committed database, which gains the track tables only on the
// pipeline's first run after the merge: either state must read cleanly —
// "being computed" before, a consistent leaderboard after — and never throw.

test("the committed database reads as computing or as a consistent leaderboard", async () => {
  const board = await getTrackLeaderboard(90);
  if (!board.available) {
    assert.deepEqual(board.ranked, []);
    assert.deepEqual(board.unranked, []);
  } else {
    board.ranked.forEach((r, i) => assert.equal(r.rank, i + 1));
    for (const r of board.unranked) assert.equal(r.rank, null);
  }
  const member = await getMemberTrack("Nancy Pelosi");
  assert.equal(member.available, board.available);
  const api = await buildTrackRecord("https://x.test", new URLSearchParams());
  assert.equal(api.status, 200);
  assert.equal((api.body as { data: { available: boolean } }).data.available, board.available);
});
