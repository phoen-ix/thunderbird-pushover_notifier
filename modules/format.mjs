// Turns mail data into Pushover notification texts.
// Pure module: translations come in through the `t(key, substitutions)` argument.

import { LIMITS } from "./pushover.mjs";

const ELLIPSIS = "…";
const SUMMARY_LINE_LIMIT = 120;
// Mail clocks are often slightly off; only reject dates clearly in the future.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Length in Unicode code points, which is what Pushover counts. */
export function charLength(text) {
  return Array.from(String(text ?? "")).length;
}

/** Cuts `text` to at most `max` code points, marking the cut with an ellipsis. */
export function truncateChars(text, max) {
  const chars = Array.from(String(text ?? ""));
  if (chars.length <= max) {
    return chars.join("");
  }
  if (max <= 0) {
    return "";
  }
  return chars.slice(0, max - 1).join("").trimEnd() + ELLIPSIS;
}

/** Splits a filter setting into lower-cased terms, one per line. */
export function parseTerms(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map(term => term.trim().toLowerCase())
    .filter(Boolean);
}

/** True if there are no terms, or `value` contains any of them (case-insensitive). */
export function matchesAny(value, terms) {
  if (terms.length === 0) {
    return true;
  }
  const haystack = String(value ?? "").toLowerCase();
  return terms.some(term => haystack.includes(term));
}

/** Collapses the whitespace of a mail body into something readable on a phone. */
export function cleanBody(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Display name of an RFC 5322 mailbox, for when Thunderbird's parser is unavailable. */
export function fallbackSenderName(author) {
  const raw = String(author ?? "").trim();
  const match = raw.match(/^"?([^"<]*?)"?\s*<([^>]*)>$/);
  if (match) {
    return match[1].trim() || match[2].trim();
  }
  return raw;
}

/** Unix timestamp for Pushover, or undefined for missing, broken or future dates. */
export function safeTimestamp(date, now = Date.now()) {
  if (date == null) {
    return undefined;
  }
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(ms) || ms <= 0 || ms > now + MAX_CLOCK_SKEW_MS) {
    return undefined;
  }
  return Math.floor(ms / 1000);
}

/**
 * One notification for one mail: sender as title, subject (plus an optional
 * body preview) as message.
 */
export function buildMailNotification({ sender, accountName, subject, body, date }, settings, t) {
  const titleText = settings.showAccountName && accountName ? `${sender} · ${accountName}` : sender;
  let message = String(subject ?? "").trim() || t("noSubject");
  if (body) {
    const bodyLimit = settings.bodyCharLimit > 0 ? settings.bodyCharLimit : LIMITS.message;
    message += `\n\n${truncateChars(body, bodyLimit)}`;
  }
  return {
    title: truncateChars(titleText, LIMITS.title),
    message: truncateChars(message, LIMITS.message),
    timestamp: safeTimestamp(date),
  };
}

/**
 * One notification for many mails: a count as title and one "Sender: Subject"
 * line per mail, as many as fit, followed by "…and N more".
 */
export function buildSummaryNotification(items, { accountName } = {}, t) {
  const count = String(items.length);
  const titleText = accountName ? `${t("summaryTitle", [count])} · ${accountName}` : t("summaryTitle", [count]);
  const lines = items.map(({ sender, subject }) =>
    truncateChars(`${sender}: ${String(subject ?? "").trim() || t("noSubject")}`, SUMMARY_LINE_LIMIT)
  );

  const shown = [];
  for (const line of lines) {
    const remaining = lines.length - shown.length - 1;
    const candidate = [...shown, line];
    if (remaining > 0) {
      candidate.push(t("summaryMore", [String(remaining)]));
    }
    if (charLength(candidate.join("\n")) > LIMITS.message) {
      break;
    }
    shown.push(line);
  }
  const hidden = lines.length - shown.length;
  if (hidden > 0) {
    shown.push(t("summaryMore", [String(hidden)]));
  }

  return {
    title: truncateChars(titleText, LIMITS.title),
    message: truncateChars(shown.join("\n"), LIMITS.message),
  };
}
