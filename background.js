// Event page: collects new mail reported by Thunderbird and sends it to Pushover.
//
// Mail is queued briefly before sending, so that
//   - message filters get time to move mail out of the Inbox ("Inbox only" mode),
//   - a burst of mail across folders and accounts becomes a single summary.
// The wait is deliberately short: a pending timer does not keep the event page
// alive, and Thunderbird suspends idle event pages after about 30 seconds.

import { isActive, loadSettings, saveLastStatus } from "./modules/settings.mjs";
import {
  discardList,
  filterStillInInbox,
  getBodyPreview,
  getSenderName,
  isInboxFolder,
  iterateMessages,
  queryAll,
} from "./modules/mail.mjs";
import { buildMailNotification, buildSummaryNotification, matchesAny, parseTerms } from "./modules/format.mjs";
import { buildRequestParams, sendNotification } from "./modules/pushover.mjs";

// Time given to filters (including "after junk classification" filters and
// IMAP moves) before checking whether a mail is still in the Inbox. The check
// runs once: a move still running then notifies anyway (README: known limits).
// Waiting for messages.onMoved wouldn't help: whether a move is coming at all
// can't be told, so every notification would have to wait for the slowest move.
const RECHECK_DELAY_MS = 5000;
// Quiet time after the last new-mail event before the queue is sent.
const DEBOUNCE_MS = 1500;
// Upper bound for how long the first queued mail may wait.
const MAX_WAIT_MS = 20000;
// A failed request is only retried while there is still time before the page may be suspended.
const RETRY_BUDGET_MS = 12000;

const t = (key, substitutions) => messenger.i18n.getMessage(key, substitutions);

let queue = [];
let firstQueuedAt = 0;
let flushTimer = null;
let flushChain = Promise.resolve();
let debugEnabled = false;

messenger.messages.onNewMailReceived.addListener(onNewMail);
messenger.runtime.onInstalled.addListener(onInstalled);

async function onNewMail(folder, messageList) {
  const settings = await loadSettings();
  debugEnabled = settings.debugLogging;

  if (!isActive(settings)) {
    debug("Ignoring new mail: notifications are disabled, not consented to, or keys are missing");
    discardList(messageList);
    return;
  }
  if (!settings.selectedAccounts.includes(folder.accountId)) {
    debug("Ignoring new mail in an account that is not selected:", folder.accountId);
    discardList(messageList);
    return;
  }
  if (settings.inboxOnly && !isInboxFolder(folder)) {
    debug("Ignoring new mail outside the Inbox:", folder.path);
    discardList(messageList);
    return;
  }

  const senderTerms = parseTerms(settings.filterSender);
  const subjectTerms = parseTerms(settings.filterSubject);
  const now = Date.now();
  let queued = 0;

  for await (const message of iterateMessages(messageList)) {
    if (settings.skipJunk && message.junk) {
      continue;
    }
    if (!matchesAny(message.author, senderTerms) || !matchesAny(message.subject, subjectTerms)) {
      continue;
    }
    queue.push({
      id: message.id,
      headerMessageId: message.headerMessageId,
      folderId: folder.id,
      accountId: folder.accountId,
      author: message.author ?? "",
      subject: message.subject ?? "",
      date: message.date,
    });
    queued++;
  }

  debug(`Queued ${queued} message(s) from ${folder.path}`);
  if (queued > 0) {
    scheduleFlush(now, settings.inboxOnly ? RECHECK_DELAY_MS : DEBOUNCE_MS);
  }
}

function scheduleFlush(now, wait) {
  firstQueuedAt ||= now;
  const due = Math.min(now + wait, firstQueuedAt + MAX_WAIT_MS);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    // Flushes run one after another: Pushover asks for at most two parallel connections.
    flushChain = flushChain.then(flush).catch(error => console.error("Pushover Notifier:", error));
  }, Math.max(0, due - Date.now()));
}

async function flush() {
  const batch = queue;
  queue = [];
  firstQueuedAt = 0;

  const started = Date.now();
  const settings = await loadSettings();
  debugEnabled = settings.debugLogging;
  if (!isActive(settings) || batch.length === 0) {
    return;
  }

  let candidates = batch;
  if (settings.inboxOnly) {
    candidates = await filterStillInInbox(batch, {
      get: id => messenger.messages.get(id),
      queryAll,
      skipJunk: settings.skipJunk,
    });
    debug(`${batch.length - candidates.length} of ${batch.length} message(s) left the Inbox after filtering`);
  }
  if (candidates.length === 0) {
    return;
  }

  const senders = await Promise.all(candidates.map(candidate => getSenderName(candidate.author)));
  const accountNames = settings.showAccountName ? await getAccountNames(candidates) : new Map();
  const send = notification => deliver(notification, settings, started);

  if (settings.summaryThreshold > 0 && candidates.length >= settings.summaryThreshold) {
    const accountIds = new Set(candidates.map(candidate => candidate.accountId));
    const accountName = accountIds.size === 1 ? accountNames.get(candidates[0].accountId) : undefined;
    const items = candidates.map((candidate, i) => ({ sender: senders[i], subject: candidate.subject }));
    await send(buildSummaryNotification(items, { accountName }, t));
    return;
  }

  for (const [i, candidate] of candidates.entries()) {
    const body = settings.includeBody ? await getBodyPreview(candidate.id) : "";
    const notification = buildMailNotification(
      {
        sender: senders[i],
        accountName: accountNames.get(candidate.accountId),
        subject: candidate.subject,
        body,
        date: candidate.date,
      },
      settings,
      t
    );
    // Stop at the first failure: bad keys or an exhausted quota would fail for every mail.
    if (!(await send(notification))) {
      break;
    }
  }
}

async function deliver(notification, settings, started) {
  const result = await sendNotification(buildRequestParams(settings, notification), {
    retry: Date.now() - started < RETRY_BUDGET_MS,
  });
  if (result.ok) {
    debug("Notification sent");
  } else {
    console.error("Pushover Notifier: sending the notification failed:", result.error);
  }
  await saveLastStatus(result);
  return result.ok;
}

async function getAccountNames(candidates) {
  const names = new Map();
  for (const accountId of new Set(candidates.map(candidate => candidate.accountId))) {
    try {
      const account = await messenger.accounts.get(accountId);
      if (account) {
        names.set(accountId, account.name);
      }
    } catch {
      // Account removed in the meantime; the title just lacks its name.
    }
  }
  return names;
}

async function onInstalled({ reason, previousVersion }) {
  if (reason === "install") {
    await messenger.runtime.openOptionsPage();
    return;
  }
  // 2.0 asks for explicit consent before sending mail data to Pushover. Users
  // of 1.x who already entered their keys made that choice when they set it up.
  if (reason === "update" && Number.parseInt(previousVersion, 10) < 2) {
    const stored = await messenger.storage.local.get(["pushoverUserKey", "pushoverAppToken", "dataConsent"]);
    if (stored.dataConsent === undefined && stored.pushoverUserKey && stored.pushoverAppToken) {
      await messenger.storage.local.set({ dataConsent: true });
    }
  }
}

function debug(...args) {
  if (debugEnabled) {
    console.debug("Pushover Notifier:", ...args);
  }
}
