import { test } from "node:test";
import assert from "node:assert/strict";

import { filterStillInInbox, isInboxFolder } from "../modules/mail.mjs";

const inbox = { id: "account1://INBOX", specialUse: ["inbox"] };
const archive = { id: "account1://Archive", specialUse: [] };

const candidate = (id, headerMessageId = `${id}@example.com`) => ({ id, headerMessageId, folderId: inbox.id });

function notFound(id) {
  throw new Error(`Message not found: ${id}.`);
}

test("isInboxFolder uses specialUse", () => {
  assert.ok(isInboxFolder(inbox));
  assert.ok(!isInboxFolder(archive));
  assert.ok(!isInboxFolder({ path: "/INBOX" }));
  assert.ok(!isInboxFolder(undefined));
});

test("keeps mail that is still in the Inbox", async () => {
  const kept = await filterStillInInbox([candidate(1)], {
    get: async () => ({ id: 1, folder: inbox, junk: false }),
    queryAll: async () => assert.fail("no fallback needed"),
    skipJunk: true,
  });
  assert.equal(kept.length, 1);
});

test("drops mail a filter moved (id no longer resolves, not found in the Inbox)", async () => {
  const queries = [];
  const kept = await filterStillInInbox([candidate(1)], {
    get: notFound,
    queryAll: async info => {
      queries.push(info);
      return [];
    },
    skipJunk: true,
  });
  assert.equal(kept.length, 0);
  assert.deepEqual(queries, [{ folderId: inbox.id, headerMessageId: "1@example.com" }]);
});

test("keeps mail whose id changed without a move (folder repair, compaction)", async () => {
  const kept = await filterStillInInbox([candidate(1)], {
    get: notFound,
    queryAll: async () => [{ id: 99, junk: false }],
    skipJunk: true,
  });
  assert.equal(kept.length, 1);
});

test("drops mail reported in another folder (stale header guard)", async () => {
  const kept = await filterStillInInbox([candidate(1)], {
    get: async () => ({ id: 1, folder: archive, junk: false }),
    queryAll: async () => [],
    skipJunk: false,
  });
  assert.equal(kept.length, 0);
});

test("drops mail marked as junk after arrival, only if skipJunk is on", async () => {
  const deps = { get: async () => ({ id: 1, folder: inbox, junk: true }), queryAll: async () => [] };
  assert.equal((await filterStillInInbox([candidate(1)], { ...deps, skipJunk: true })).length, 0);
  assert.equal((await filterStillInInbox([candidate(1)], { ...deps, skipJunk: false })).length, 1);

  const viaQuery = { get: notFound, queryAll: async () => [{ id: 2, junk: true }] };
  assert.equal((await filterStillInInbox([candidate(1)], { ...viaQuery, skipJunk: true })).length, 0);
});

test("keeps mail when both lookups fail: better one notification too many than a missed one", async () => {
  const kept = await filterStillInInbox([candidate(1), candidate(2, undefined)], {
    get: notFound,
    queryAll: async () => {
      throw new Error("search failed");
    },
    skipJunk: true,
  });
  assert.equal(kept.length, 2);
});

test("handles a mixed batch in order", async () => {
  const headers = { 1: { folder: inbox }, 3: { folder: inbox } };
  const kept = await filterStillInInbox([candidate(1), candidate(2), candidate(3)], {
    get: async id => headers[id] ?? notFound(id),
    queryAll: async () => [],
    skipJunk: true,
  });
  assert.deepEqual(kept.map(c => c.id), [1, 3]);
});
