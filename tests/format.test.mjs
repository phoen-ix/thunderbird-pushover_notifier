import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMailNotification,
  buildSummaryNotification,
  charLength,
  cleanBody,
  fallbackSenderName,
  matchesAny,
  parseTerms,
  safeTimestamp,
  truncateChars,
} from "../modules/format.mjs";
import { normalizeSettings } from "../modules/settings.mjs";

const t = (key, subs = []) =>
  ({
    noSubject: "(no subject)",
    summaryTitle: `${subs[0]} new emails`,
    summaryMore: `…and ${subs[0]} more`,
  })[key] ?? key;

test("truncateChars counts code points, not UTF-16 units", () => {
  const emoji = "😀".repeat(10);
  assert.equal(truncateChars(emoji, 10), emoji);
  const cut = truncateChars(emoji, 5);
  assert.equal(charLength(cut), 5);
  assert.equal(cut, "😀😀😀😀…");
  assert.equal(truncateChars("abc", 0), "");
  assert.equal(truncateChars(null, 5), "");
});

test("parseTerms and matchesAny: one case-insensitive term per line", () => {
  const terms = parseTerms("  Boss@Example.com \n\n newsletter\r\n");
  assert.deepEqual(terms, ["boss@example.com", "newsletter"]);
  assert.ok(matchesAny('"The Boss" <boss@example.com>', terms));
  assert.ok(matchesAny("Weekly NEWSLETTER", terms));
  assert.ok(!matchesAny("someone else", terms));
  assert.ok(matchesAny("anything", parseTerms("")), "no terms allows everything");
  assert.ok(matchesAny(undefined, []));
});

test("a 1.x single-line filter keeps working", () => {
  assert.ok(matchesAny("Invoice, March", parseTerms("Invoice, March")));
});

test("cleanBody normalizes line endings and collapses whitespace", () => {
  assert.equal(cleanBody("  Hello\r\n\r\n\r\n\r\nWorld \t  again  \n"), "Hello\n\nWorld again");
});

test("fallbackSenderName extracts the display name or address", () => {
  assert.equal(fallbackSenderName('"Jane Doe" <jane@example.com>'), "Jane Doe");
  assert.equal(fallbackSenderName("Jane Doe <jane@example.com>"), "Jane Doe");
  assert.equal(fallbackSenderName("<jane@example.com>"), "jane@example.com");
  assert.equal(fallbackSenderName("jane@example.com"), "jane@example.com");
  assert.equal(fallbackSenderName(undefined), "");
});

test("safeTimestamp rejects invalid and future dates", () => {
  const now = Date.UTC(2026, 8, 26, 12, 0, 0);
  assert.equal(safeTimestamp(new Date(now - 60_000), now), Math.floor((now - 60_000) / 1000));
  assert.equal(safeTimestamp(new Date(now + 60_000), now), Math.floor((now + 60_000) / 1000), "small clock skew is fine");
  assert.equal(safeTimestamp(new Date(now + 24 * 3600_000), now), undefined);
  assert.equal(safeTimestamp(new Date("garbage"), now), undefined);
  assert.equal(safeTimestamp(new Date(0), now), undefined);
  assert.equal(safeTimestamp(undefined, now), undefined);
});

test("buildMailNotification: sender as title, subject as message", () => {
  const settings = normalizeSettings({});
  const date = new Date(Date.now() - 1000);
  const n = buildMailNotification({ sender: "Jane", subject: "Hello", body: "", date }, settings, t);
  assert.equal(n.title, "Jane");
  assert.equal(n.message, "Hello");
  assert.equal(n.timestamp, Math.floor(date.getTime() / 1000));
});

test("buildMailNotification: empty subject and optional account name", () => {
  const settings = normalizeSettings({ showAccountName: true });
  const n = buildMailNotification({ sender: "Jane", accountName: "Work", subject: "  " }, settings, t);
  assert.equal(n.title, "Jane · Work");
  assert.equal(n.message, "(no subject)");
});

test("buildMailNotification: bodyCharLimit=0 fills up to Pushover's 1024 limit", () => {
  const settings = normalizeSettings({ includeBody: true, bodyCharLimit: 0 });
  const n = buildMailNotification({ sender: "Jane", subject: "Hello", body: "x".repeat(5000) }, settings, t);
  assert.equal(charLength(n.message), 1024);
  assert.ok(n.message.startsWith("Hello\n\nxxx"));
  assert.ok(n.message.endsWith("…"));
});

test("buildMailNotification: bodyCharLimit cuts the body only", () => {
  const settings = normalizeSettings({ includeBody: true, bodyCharLimit: 10 });
  const n = buildMailNotification({ sender: "Jane", subject: "Hello", body: "abcdefghijklmnop" }, settings, t);
  assert.equal(n.message, "Hello\n\nabcdefghi…");
});

test("buildMailNotification caps the title at 250 characters", () => {
  const settings = normalizeSettings({});
  const n = buildMailNotification({ sender: "S".repeat(400), subject: "x" }, settings, t);
  assert.equal(charLength(n.title), 250);
});

test("buildSummaryNotification lists all mails when they fit", () => {
  const items = [
    { sender: "Jane", subject: "One" },
    { sender: "Joe", subject: "" },
  ];
  const n = buildSummaryNotification(items, {}, t);
  assert.equal(n.title, "2 new emails");
  assert.equal(n.message, "Jane: One\nJoe: (no subject)");
});

test("buildSummaryNotification stays within 1024 characters and says how many are hidden", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ sender: `Sender ${i}`, subject: "S".repeat(100) }));
  const n = buildSummaryNotification(items, { accountName: "Work" }, t);
  assert.equal(n.title, "60 new emails · Work");
  assert.ok(charLength(n.message) <= 1024);
  const lines = n.message.split("\n");
  const shown = lines.length - 1;
  assert.equal(lines.at(-1), `…and ${60 - shown} more`);
  assert.ok(shown > 0);
});
