import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  matchSubscriberDigest,
  renderDigestEmail,
  renderVerificationEmail,
  subscriptionActionUrls,
} from "./email-digest.ts";

const SECRET = "test-alerts-secret-at-least-16-bytes";

describe("email-digest", () => {
  it("renders verification email with verify, manage, and unsubscribe links", () => {
    const urls = subscriptionActionUrls("reader@example.com", SECRET, 1700000000);
    const mail = renderVerificationEmail(
      {
        email: "reader@example.com",
        members: ["P000197"],
        tickers: ["NVDA"],
        clusters: true,
        weeklyDigest: false,
      },
      urls
    );
    assert.ok(mail.subject.includes("Confirm"));
    assert.ok(mail.html.includes("P000197"));
    assert.ok(mail.html.includes("NVDA"));
    assert.ok(mail.text.includes(urls.verifyUrl));
    assert.ok(mail.text.includes(urls.manageUrl));
    assert.ok(mail.text.includes(urls.unsubscribeUrl));
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
