import { test } from "node:test";
import assert from "node:assert/strict";

import { filterStillInInbox, isInboxFolder } from "../modules/mail.mjs";

const inbox = { id: "account1://Inbox", path: "/Inbox", specialUse: ["inbox"] };
const archive = { id: "account1://Archive", path: "/Archive", specialUse: [] };

const candidate = (id, headerMessageId = `${id}@example.com`) => ({ id, headerMessageId, folderId: inbox.id });

function notFound(id) {
  throw new Error(`Message not found: ${id}.`);
}
function searchFails() {
  throw new Error("search failed");
}

test("isInboxFolder uses specialUse", () => {
  assert.ok(isInboxFolder(inbox));
  assert.ok(!isInboxFolder(archive));
  assert.ok(!isInboxFolder({ path: "/INBOX" }));
  assert.ok(!isInboxFolder(undefined));
});

test("keeps mail that is still in the Inbox", async () => {
  const queries = [];
  const kept = await filterStillInInbox([candidate(1)], {
    get: () => assert.fail("the search is enough"),
    queryAll: async info => {
      queries.push(info);
      return [{ id: 1, junk: false }];
    },
    skipJunk: true,
  });
  assert.equal(kept.length, 1);
  assert.deepEqual(queries, [{ folderId: inbox.id, headerMessageId: "1@example.com" }]);
});

test("drops mail a filter moved away, even though get() still returns the old Inbox header", async () => {
  // Observed in Thunderbird 156 for filters running after junk classification.
  const kept = await filterStillInInbox([candidate(1)], {
    get: async () => ({ id: 1, folder: inbox, subject: "", junk: false }),
    queryAll: async () => [],
    skipJunk: true,
  });
  assert.equal(kept.length, 0);
});

test("keeps mail whose id changed without a move (folder repair, compaction)", async () => {
  const kept = await filterStillInInbox([candidate(1)], {
    get: notFound,
    queryAll: async () => [{ id: 99, junk: false }],
    skipJunk: true,
  });
  assert.equal(kept.length, 1);
});

test("drops mail marked as junk after arrival, only if skipJunk is on", async () => {
  const deps = { get: notFound, queryAll: async () => [{ id: 1, junk: true }] };
  assert.equal((await filterStillInInbox([candidate(1)], { ...deps, skipJunk: true })).length, 0);
  assert.equal((await filterStillInInbox([candidate(1)], { ...deps, skipJunk: false })).length, 1);
});

test("falls back to get() when the search fails", async () => {
  const run = (header, skipJunk = true) =>
    filterStillInInbox([candidate(1)], { get: async () => header, queryAll: searchFails, skipJunk });
  assert.equal((await run({ folder: inbox, junk: false })).length, 1, "still in the Inbox");
  assert.equal((await run({ folder: archive, junk: false })).length, 0, "now in another folder");
  assert.equal((await run({ folder: inbox, junk: true })).length, 0, "junk, skipped");
  assert.equal((await run({ folder: inbox, junk: true }, false)).length, 1, "junk, not skipped");
});

test("uses get() for mail without a Message-ID", async () => {
  const kept = await filterStillInInbox([candidate(1, undefined)], {
    get: async () => ({ folder: archive }),
    queryAll: () => assert.fail("nothing to search for"),
    skipJunk: true,
  });
  assert.equal(kept.length, 0);
});

test("keeps mail when both lookups fail: better one notification too many than a missed one", async () => {
  const kept = await filterStillInInbox([candidate(1), candidate(2, undefined)], {
    get: notFound,
    queryAll: searchFails,
    skipJunk: true,
  });
  assert.equal(kept.length, 2);
});

test("handles a mixed batch in order", async () => {
  const inInbox = new Set(["1@example.com", "3@example.com"]);
  const kept = await filterStillInInbox([candidate(1), candidate(2), candidate(3)], {
    get: notFound,
    queryAll: async ({ headerMessageId }) => (inInbox.has(headerMessageId) ? [{ junk: false }] : []),
    skipJunk: true,
  });
  assert.deepEqual(kept.map(c => c.id), [1, 3]);
});
