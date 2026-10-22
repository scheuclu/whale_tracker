import assert from "node:assert/strict";
import { test } from "node:test";

import { EXPIRES_IN_DAYS, securityTxt } from "./security-txt.ts";

const NOW = new Date("2026-10-22T14:00:00Z");

const fields = (txt: string) =>
  txt
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf(": ");
      return [l.slice(0, i), l.slice(i + 2)] as const;
    });

test("RFC 9116: Contact and Expires present, each once, Canonical on the served URL", () => {
  const f = fields(securityTxt("https://www.fatcatwatch.com/", NOW));
  const names = f.map(([k]) => k);
  assert.equal(names.filter((n) => n === "Contact").length, 1);
  assert.equal(names.filter((n) => n === "Expires").length, 1);
  const get = (k: string) => f.find(([n]) => n === k)?.[1];
  assert.equal(get("Contact"), "https://www.fatcatwatch.com/contact");
  assert.equal(get("Canonical"), "https://www.fatcatwatch.com/.well-known/security.txt");
});

test("Expires is always in the future and less than a year away", () => {
  const f = fields(securityTxt("https://www.fatcatwatch.com", NOW));
  const expires = f.find(([n]) => n === "Expires")![1];
  assert.match(expires, /^\d{4}-\d\d-\d\dT00:00:00\.000Z$/);
  const days = (Date.parse(expires) - NOW.getTime()) / 86_400_000;
  assert.ok(days > EXPIRES_IN_DAYS - 1 && days < 365, `expires in ${days} days`);
});

test("lines end with LF and the file ends with a newline", () => {
  const txt = securityTxt("https://www.fatcatwatch.com", NOW);
  assert.ok(txt.endsWith("\n"));
  assert.doesNotMatch(txt, /\r/);
});
