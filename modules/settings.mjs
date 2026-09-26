// Stored settings, their defaults and validation.
// Keys from 1.x are unchanged, so upgrades need no migration.

import { EMERGENCY, LIMITS } from "./pushover.mjs";

export const DEFAULTS = Object.freeze({
  pushoverUserKey: "",
  pushoverAppToken: "",
  pushoverDevice: "",
  enableNotifications: true,
  dataConsent: false,
  selectedAccounts: Object.freeze([]),
  inboxOnly: false,
  skipJunk: true,
  filterSender: "",
  filterSubject: "",
  includeBody: false,
  bodyCharLimit: 0,
  showAccountName: false,
  summaryThreshold: 5,
  notificationPriority: "0",
  notificationSound: "",
  retryInterval: 60,
  expireTime: 3600,
  debugLogging: false,
});

const PRIORITIES = ["-2", "-1", "0", "1", "2"];
const MAX_SUMMARY_THRESHOLD = 100;

/**
 * Returns a complete, valid settings object for any (partial, outdated or
 * hand-edited) input. Invalid values fall back to their defaults.
 */
export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULTS, ...raw };
  const retryInterval = clamp(toInt(s.retryInterval, DEFAULTS.retryInterval), EMERGENCY.minRetry, EMERGENCY.maxExpire);
  const summaryThreshold = toInt(s.summaryThreshold, DEFAULTS.summaryThreshold);

  return {
    pushoverUserKey: toText(s.pushoverUserKey).trim(),
    pushoverAppToken: toText(s.pushoverAppToken).trim(),
    pushoverDevice: toText(s.pushoverDevice).trim(),
    enableNotifications: Boolean(s.enableNotifications),
    dataConsent: Boolean(s.dataConsent),
    selectedAccounts: Array.isArray(s.selectedAccounts)
      ? s.selectedAccounts.filter(id => typeof id === "string")
      : [],
    inboxOnly: Boolean(s.inboxOnly),
    skipJunk: Boolean(s.skipJunk),
    filterSender: toText(s.filterSender),
    filterSubject: toText(s.filterSubject),
    includeBody: Boolean(s.includeBody),
    // 0 means "no own limit": the body fills the message up to Pushover's cap.
    bodyCharLimit: clamp(toInt(s.bodyCharLimit, DEFAULTS.bodyCharLimit), 0, LIMITS.message),
    showAccountName: Boolean(s.showAccountName),
    // 0 disables the summary; a "summary" of a single mail makes no sense.
    summaryThreshold: summaryThreshold <= 0 ? 0 : clamp(summaryThreshold, 2, MAX_SUMMARY_THRESHOLD),
    notificationPriority: PRIORITIES.includes(String(s.notificationPriority))
      ? String(s.notificationPriority)
      : DEFAULTS.notificationPriority,
    notificationSound: toText(s.notificationSound).trim(),
    retryInterval,
    expireTime: clamp(toInt(s.expireTime, DEFAULTS.expireTime), retryInterval, EMERGENCY.maxExpire),
    debugLogging: Boolean(s.debugLogging),
  };
}

export function hasCredentials(settings) {
  return Boolean(settings.pushoverUserKey && settings.pushoverAppToken);
}

/** True when the add-on is allowed and able to send notifications at all. */
export function isActive(settings) {
  return settings.enableNotifications && settings.dataConsent && hasCredentials(settings);
}

export async function loadSettings() {
  return normalizeSettings(await messenger.storage.local.get(DEFAULTS));
}

export async function saveSettings(values) {
  const settings = normalizeSettings(values);
  await messenger.storage.local.set(settings);
  return settings;
}

/** Remembers the outcome of the last delivery (shown on the options page). */
export function saveLastStatus({ ok, error }) {
  return messenger.storage.local.set({ lastStatus: { ok, time: Date.now(), error: error ?? "" } });
}

function toInt(value, fallback) {
  const number = typeof value === "number" ? value : Number.parseInt(toText(value).trim(), 10);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function toText(value) {
  return value == null ? "" : String(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
