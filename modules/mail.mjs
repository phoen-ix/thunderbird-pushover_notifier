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
 * Thunderbird's message ids do not follow moves: `get()` of a moved message
 * throws. Ids can also change without a move (folder repair, compaction), so
 * a failed `get()` is double-checked by searching the original folder for the
 * Message-ID. If even that fails, the message is kept: a notification too many
 * is better than a missed one.
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
  let header = null;
  try {
    header = await get(candidate.id);
  } catch {
    // Moved, deleted or re-indexed; checked below.
  }
  if (header) {
    if (header.folder && !isInboxFolder(header.folder)) {
      return false;
    }
    return !(skipJunk && header.junk);
  }

  if (!candidate.headerMessageId || !candidate.folderId) {
    return true;
  }
  try {
    const found = await queryAll({ folderId: candidate.folderId, headerMessageId: candidate.headerMessageId });
    if (found.length === 0) {
      return false;
    }
    return !(skipJunk && found.every(message => message.junk));
  } catch {
    return true;
  }
}
