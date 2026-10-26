import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  matchSubscriberDigest,
  renderDigestEmail,
  renderSignInEmail,
  subscriptionActionUrls,
} from "./email-digest.ts";

const SECRET = "test-alerts-secret-at-least-16-bytes";

describe("email-digest", () => {
  it("renders the sign-in email around the one link it carries", () => {
    const url = "https://www.fatcatwatch.com/api/auth/email/callback?token=abc.def";
    const mail = renderSignInEmail(url);
    assert.ok(mail.subject.includes("sign-in link"));
    assert.ok(mail.text.includes(url));
    assert.ok(mail.html.includes(url));
    assert.ok(mail.text.includes("15 minutes"));
  });

  it("matches subscriber digest against database and preserves bracket-range and Form 4 separation", async () => {
    const matches = await matchSubscriberDigest(
      {
        members: ["P000197"],
        tickers: ["MSFT", "BBD"],
        clusters: true,
      },
      "2020-01-01"
    );
    assert.ok(matches.congressTrades.length > 0, "finds congressional trades for Pelosi / MSFT");

    const urls = subscriptionActionUrls("reader@example.com", SECRET, 1700000000);
    const digest = renderDigestEmail(matches, urls);
    assert.ok(digest.html.includes("disclosed"), "labels congressional amounts as disclosed bracket ranges");
    assert.ok(
      digest.html.includes("never summed with congressional trades"),
      "states congressional and insider separation"
    );
  });
});
