// Helpers around Thunderbird's messages, folders and messengerUtilities APIs.
// `messenger.*` is only touched inside functions, so this module can be imported by tests.

import { cleanBody, fallbackSenderName } from "./format.mjs";

/** Yields every message of a MessageList, fetching further pages as needed. */
export async function* iterateMessages(list) {
  let page = list;
  while (page) {
    yield* page.messages;
    if (!page.id) {
      return;
    }
    page = await messenger.messages.continueList(page.id);
  }
}

/** Releases a MessageList that will not be read to the end. */
export function discardList(list) {
  if (list?.id) {
    messenger.messages.abortList(list.id).catch(() => {});
  }
}

export async function queryAll(queryInfo) {
  const messages = [];
  for await (const message of iterateMessages(await messenger.messages.query(queryInfo))) {
    messages.push(message);
  }
  return messages;
}

export function isInboxFolder(folder) {
  return Array.isArray(folder?.specialUse) && folder.specialUse.includes("inbox");
}

/** Display name (or address) of the sender. */
export async function getSenderName(author) {
  try {
    const [mailbox] = await messenger.messengerUtilities.parseMailboxString(author);
    if (mailbox) {
      return mailbox.name || mailbox.email || String(author ?? "");
    }
  } catch {
    // Fall through to the simple parser.
  }
  return fallbackSenderName(author);
}

/** Readable plain text of the message body, or "" if there is none or it can't be read (e.g. encrypted). */
export async function getBodyPreview(messageId) {
  try {
    const parts = await messenger.messages.listInlineTextParts(messageId);
    const ofType = type => parts.find(part => part.contentType?.toLowerCase() === type && part.content?.trim());
    const plain = ofType("text/plain");
    if (plain) {
      return cleanBody(plain.content);
    }
    const html = ofType("text/html");
    if (html) {
      return cleanBody(await messenger.messengerUtilities.convertToPlainText(html.content));
    }
  } catch (error) {
    console.warn("Pushover Notifier: could not read message body:", error.message);
  }
  return "";
}

/**
 * Keeps the candidates that are still in an Inbox now, i.e. were not moved,
 * deleted or marked as junk by message filters after Thunderbird reported them.
 *
 * The Inbox the mail arrived in is searched for its Message-ID. The message id
 * alone is not reliable: after a move by a filter that runs after junk
 * classification, `get(id)` still returns the old header, which claims to be
 * in the Inbox. `get()` is only used if the search fails, and if that fails
 * too, the mail is kept: a notification too many is better than a missed one.
 *
 * @param candidates [{ id, headerMessageId, folderId }]
 * @param deps { get(id), queryAll(queryInfo), skipJunk }
 */
export async function filterStillInInbox(candidates, { get, queryAll, skipJunk }) {
  const kept = [];
  for (const candidate of candidates) {
    if (await isStillInInbox(candidate, { get, queryAll, skipJunk })) {
      kept.push(candidate);
    }
  }
  return kept;
}

async function isStillInInbox(candidate, { get, queryAll, skipJunk }) {
  const wanted = message => !(skipJunk && message.junk);

  if (candidate.headerMessageId && candidate.folderId) {
    try {
      const found = await queryAll({ folderId: candidate.folderId, headerMessageId: candidate.headerMessageId });
      return found.some(wanted);
    } catch {
      // Fall back to the message id.
    }
  }
  try {
    const header = await get(candidate.id);
    return (!header.folder || isInboxFolder(header.folder)) && wanted(header);
  } catch {
    return true;
  }
}
