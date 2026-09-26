import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, isActive, normalizeSettings } from "../modules/settings.mjs";

test("defaults are complete and valid", () => {
  assert.deepEqual(normalizeSettings({}), { ...DEFAULTS, selectedAccounts: [] });
});

test("1.x settings are read unchanged", () => {
  const old = {
    pushoverUserKey: "u".repeat(30),
    pushoverAppToken: "a".repeat(30),
    enableNotifications: true,
    selectedAccounts: ["account1", "account3"],
    filterSender: "boss@example.com",
    filterSubject: "",
    includeBody: true,
    bodyCharLimit: 0,
    notificationPriority: "1",
    notificationSound: "cosmic",
    retryInterval: 60,
    expireTime: 3600,
  };
  const s = normalizeSettings(old);
  for (const [key, value] of Object.entries(old)) {
    assert.deepEqual(s[key], value, key);
  }
});

test("NaN and garbage fall back to defaults", () => {
  const s = normalizeSettings({
    bodyCharLimit: NaN,
    retryInterval: "",
    expireTime: "abc",
    summaryThreshold: null,
    notificationPriority: "7",
    selectedAccounts: "account1",
  });
  assert.equal(s.bodyCharLimit, DEFAULTS.bodyCharLimit);
  assert.equal(s.retryInterval, DEFAULTS.retryInterval);
  assert.equal(s.expireTime, DEFAULTS.expireTime);
  assert.equal(s.summaryThreshold, DEFAULTS.summaryThreshold);
  assert.equal(s.notificationPriority, "0");
  assert.deepEqual(s.selectedAccounts, []);
});

test("numbers are clamped to Pushover's limits", () => {
  let s = normalizeSettings({ retryInterval: 5, expireTime: 99999, bodyCharLimit: 5000 });
  assert.equal(s.retryInterval, 30);
  assert.equal(s.expireTime, 10800);
  assert.equal(s.bodyCharLimit, 1024);

  s = normalizeSettings({ retryInterval: 600, expireTime: 60 });
  assert.equal(s.expireTime, 600, "expire is never shorter than the retry interval");

  assert.equal(normalizeSettings({ bodyCharLimit: -3 }).bodyCharLimit, 0);
  assert.equal(normalizeSettings({ retryInterval: "90" }).retryInterval, 90, "numeric strings from inputs");
});

test("summary threshold: 0 disables, 1 becomes 2", () => {
  assert.equal(normalizeSettings({ summaryThreshold: 0 }).summaryThreshold, 0);
  assert.equal(normalizeSettings({ summaryThreshold: -4 }).summaryThreshold, 0);
  assert.equal(normalizeSettings({ summaryThreshold: 1 }).summaryThreshold, 2);
  assert.equal(normalizeSettings({ summaryThreshold: 500 }).summaryThreshold, 100);
});

test("priority accepts numbers and strings, stored as string", () => {
  assert.equal(normalizeSettings({ notificationPriority: 2 }).notificationPriority, "2");
  assert.equal(normalizeSettings({ notificationPriority: "-2" }).notificationPriority, "-2");
});

test("keys are trimmed", () => {
  const s = normalizeSettings({ pushoverUserKey: `  ${"u".repeat(30)}\n`, pushoverAppToken: ` ${"a".repeat(30)} ` });
  assert.equal(s.pushoverUserKey, "u".repeat(30));
  assert.equal(s.pushoverAppToken, "a".repeat(30));
});

test("isActive needs enable, consent and both keys", () => {
  const base = { pushoverUserKey: "u".repeat(30), pushoverAppToken: "a".repeat(30), enableNotifications: true, dataConsent: true };
  assert.ok(isActive(normalizeSettings(base)));
  assert.ok(!isActive(normalizeSettings({ ...base, dataConsent: false })));
  assert.ok(!isActive(normalizeSettings({ ...base, enableNotifications: false })));
  assert.ok(!isActive(normalizeSettings({ ...base, pushoverAppToken: " " })));
});
