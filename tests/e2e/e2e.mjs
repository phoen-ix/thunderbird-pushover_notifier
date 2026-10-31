// End-to-end test: runs the add-on in a real, headless Thunderbird.
//
// Mail is delivered by a local POP3 server; message filters on the account move,
// delete and junk-mark some of it. Notifications go to a local mock of
// api.pushover.net. Thunderbird is driven through Marionette.
//
// Usually started through run.sh (Docker). Direct use needs Thunderbird, git and
// openssl:  TB_BINARY=/path/to/thunderbird node tests/e2e/e2e.mjs
// Set E2E_VERBOSE=1 to see Thunderbird's console output, E2E_ARTIFACTS=<dir>
// to save screenshots of the options page.

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Marionette } from "./marionette.mjs";
import { buildMail, createCertificates, startImapServer, startPop3Server, startPushoverMock } from "./servers.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const TB_BINARY = process.env.TB_BINARY ?? "thunderbird";
const VERBOSE = Boolean(process.env.E2E_VERBOSE);
// Directory for screenshots of the options page (optional).
const ARTIFACTS = process.env.E2E_ARTIFACTS;
// The time screenshots show as the last delivery, so they don't change between runs.
const SCREENSHOT_TIME = Date.parse("2026-06-15T10:00:00+02:00");
const ADDON_ID = "pushover-notifier@monumental.at";
// Last 1.x release (Manifest V2); installed first to test the upgrade path.
const LEGACY_COMMIT = "afb8089";
const MARIONETTE_PORT = 28280;
const USER_KEY = "uQiRzpo4DXghDmr9QzzfQu27cmVRsG";
const APP_TOKEN = "azGDORePK8gMaC0QOYAMyEEuzJnyUi";
// Long enough for the Inbox recheck (5 s) plus sending; anything later is a bug.
const SETTLE_MS = 10000;
// How long filter moves may take to show up in the folders (IMAP: on the server).
const FOLDERS_TIMEOUT_MS = 30000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failures = [];
const consoleLines = [];
// Subjects and bodies of the test mail: the add-on must never log them.
const mailContents = new Set();
/** The add-on's debug messages in Thunderbird's console so far. */
const debugLines = () => consoleLines.filter(line => /Pushover Notifier.*(Queued|Ignoring new mail|left the Inbox|Notification sent)/.test(line));
let messages = {};

/** The add-on's translation of `key` for Thunderbird's UI language, like i18n.getMessage(). */
function msg(key, substitutions = []) {
  const { message, placeholders = {} } = messages[key];
  return message.replace(/\$(\w+)\$/g, (_, name) => substitutions[Number(placeholders[name.toLowerCase()].content.slice(1)) - 1]);
}

function loadMessages(locale) {
  const read = lang => JSON.parse(readFileSync(path.join(REPO, "_locales", lang, "messages.json"), "utf8"));
  const lang = locale.split("-")[0];
  messages = existsSync(path.join(REPO, "_locales", lang)) ? read(lang) : read("en");
}

function check(condition, description, detail) {
  console.log(`  ${condition ? "✔" : "✘"} ${description}${!condition && detail !== undefined ? `\n      got: ${JSON.stringify(detail)}` : ""}`);
  if (!condition) {
    failures.push(description);
  }
}

// ---------------------------------------------------------------------------
// Chrome-context scripts (run inside Thunderbird)

const INIT = `
  const [caBase64] = arguments;
  Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).addCertFromBase64(caBase64, "C,,");
  return { version: Services.appinfo.version, locale: Services.locale.appLocaleAsBCP47 };
`;

// Runs a mailnews URL (e.g. a folder update) and waits for it to finish.
const URL_HELPERS = `
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const runUrl = start =>
    new Promise((resolve, reject) =>
      start({
        OnStartRunningUrl() {},
        OnStopRunningUrl(url, status) {
          status == 0 ? resolve() : reject(new Error(url.spec + " failed: 0x" + (status >>> 0).toString(16)));
        },
      })
    );
  const fetchNewMail = server => {
    const inbox = server.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
    return server.type == "pop3"
      ? runUrl(listener => MailServices.pop3.GetNewMail(null, listener, inbox, server))
      : runUrl(listener => inbox.getNewMessages(null, listener));
  };
`;

// A POP3 or IMAP account with the folders "Newsletters" and "Later" and these filters:
//   subject "newsletter" → moved to Newsletters (normal filter)
//   subject "later-move" → moved to Later (filter running after junk classification)
//   subject "spammy"     → marked as junk
//   subject "delete-me"  → deleted
const CREATE_ACCOUNT = `
  const [type, port, name] = arguments;
  ${URL_HELPERS}
  const waitUntil = async (condition, what) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for " + what);
  };

  const server = MailServices.accounts.createIncomingServer("tester", "127.0.0.1", type);
  server.port = port;
  server.socketType = Ci.nsMsgSocketType.plain;
  server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
  server.password = "secret";
  server.prettyName = name;
  const identity = MailServices.accounts.createIdentity();
  identity.email = "tester@example.com";
  const account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  account.addIdentity(identity);

  const root = server.rootFolder;
  const folderNames = ["Newsletters", "Later"];
  if (type == "pop3") {
    server.QueryInterface(Ci.nsIPop3IncomingServer).leaveMessagesOnServer = false;
    server.QueryInterface(Ci.nsILocalMailIncomingServer).createDefaultMailboxes();
  } else {
    // No IDLE: Thunderbird fetches new mail only when the test asks, after all
    // of it is on the server. With IDLE it starts fetching while GreenMail is
    // still receiving it, so how the mail is split into fetches, and whether
    // the filters treat each mail as new, depends on timing.
    server.QueryInterface(Ci.nsIImapIncomingServer).useIdle = false;
    await runUrl(listener => MailServices.imap.discoverAllFolders(root, listener, null));
    folderNames.push("Trash");
  }
  for (const folderName of folderNames) {
    if (!root.containsChildNamed(folderName)) {
      root.createSubfolder(folderName, null);
    }
  }
  await waitUntil(
    () => folderNames.every(folderName => root.containsChildNamed(folderName)) && root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox),
    "the folders of " + name
  );
  if (type == "imap") {
    // Initial sync, so that later mail counts as new.
    await fetchNewMail(server);
  }

  const filters = server.getFilterList(null);
  const addFilter = (filterName, filterType, subjectContains, configure) => {
    const filter = filters.createFilter(filterName);
    filter.filterType = filterType;
    const term = filter.createTerm();
    term.attrib = Ci.nsMsgSearchAttrib.Subject;
    term.op = Ci.nsMsgSearchOp.Contains;
    const value = term.value;
    value.attrib = Ci.nsMsgSearchAttrib.Subject;
    value.str = subjectContains;
    term.value = value;
    term.booleanAnd = true;
    filter.appendTerm(term);
    const action = filter.createAction();
    configure(action);
    filter.appendAction(action);
    filter.enabled = true;
    filters.insertFilterAt(filters.filterCount, filter);
  };
  const Action = Ci.nsMsgFilterAction;
  addFilter("Newsletters", Ci.nsMsgFilterType.InboxRule, "newsletter", a => {
    a.type = Action.MoveToFolder;
    a.targetFolderUri = root.getChildNamed("Newsletters").URI;
  });
  addFilter("After junk classification", Ci.nsMsgFilterType.PostPlugin, "later-move", a => {
    a.type = Action.MoveToFolder;
    a.targetFolderUri = root.getChildNamed("Later").URI;
  });
  addFilter("Mark junk", Ci.nsMsgFilterType.InboxRule, "spammy", a => {
    a.type = Action.JunkScore;
    a.junkScore = 100;
  });
  addFilter("Delete", Ci.nsMsgFilterType.InboxRule, "delete-me", a => {
    a.type = Action.Delete;
  });
  filters.saveToDefaultFile();

  return account.key;
`;

const GET_NEW_MAIL = `
  const [accountKey] = arguments;
  ${URL_HELPERS}
  await fetchNewMail(MailServices.accounts.getAccount(accountKey).incomingServer);
`;

// Subjects per folder, from the local folder databases. IMAP folders are updated
// from the server first: a folder's local copy only learns about mail a filter
// moved into it when the folder is updated.
const FOLDER_CONTENTS = `
  const [accountKey] = arguments;
  ${URL_HELPERS}
  const server = MailServices.accounts.getAccount(accountKey).incomingServer;
  if (server.type == "imap") {
    for (const folder of server.rootFolder.descendants) {
      const imapFolder = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
      // An update that is already running may never call the listener: don't wait for it.
      await Promise.race([
        runUrl(listener => imapFolder.updateFolderWithListener(null, listener)).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
    }
  }
  const result = {};
  for (const folder of server.rootFolder.descendants) {
    result[folder.name] = [...folder.messages].map(hdr =>
      hdr.mime2DecodedSubject + (hdr.getStringProperty("junkscore") == "100" ? " [junk]" : "")
    );
  }
  return result;
`;

// Message-IDs in the account's local Inbox database: what the add-on's Inbox
// check searches. Read only, so watching it doesn't change what Thunderbird does.
const INBOX_MESSAGE_IDS = `
  const [accountKey] = arguments;
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const inbox = MailServices.accounts.getAccount(accountKey).incomingServer.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
  return [...inbox.messages].map(hdr => hdr.messageId);
`;

const EXTENSION_INFO = `
  const [id] = arguments;
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const extension = ExtensionParent.GlobalManager.getExtension(id);
  const tabmail = Services.wm.getMostRecentWindow("mail:3pane")?.document.getElementById("tabmail");
  return extension && {
    version: extension.version,
    manifestVersion: extension.manifestVersion,
    warnings: extension.warnings,
    permissions: [...extension.permissions],
    optionsUrl: extension.baseURI.resolve("options/options.html"),
    tabs: (tabmail?.tabInfo ?? []).map(tab => tab.browser?.currentURI?.spec ?? tab.mode?.name ?? ""),
  };
`;

// Acts on the page in the Thunderbird tab showing `url`. Scripts run through
// the actor Marionette uses for Firefox tabs, with system privileges (needed
// for trusted mouse events). "screenshot" takes the rectangle [x, y, width,
// height] of the page (CSS pixels) and returns a PNG at twice that size.
const IN_TAB = `
  const [url, action, script, args] = arguments;
  const win = Services.wm.getMostRecentWindow("mail:3pane");
  const tabmail = win.document.getElementById("tabmail");
  const tab = tabmail.tabInfo.find(info => info.browser?.currentURI?.spec == url);
  if (!tab) {
    throw new Error("No tab shows " + url);
  }
  const windowGlobal = tab.browser.browsingContext.currentWindowGlobal;
  const run = (code, codeArgs = []) =>
    windowGlobal.getActor("MarionetteCommands").executeScript(code, codeArgs, { sandboxName: "system", timeout: 30000 });
  if (action == "run") {
    return run(script, args);
  }
  if (action == "close") {
    tabmail.closeTab(tab);
    return null;
  }
  if (action == "screenshot") {
    const [x, y, width, height] = args;
    const snapshot = await windowGlobal.drawSnapshot(new win.DOMRect(x, y, width, height), 2, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = width * 2;
    canvas.height = height * 2;
    canvas.getContext("2d").drawImage(snapshot, 0, 0);
    snapshot.close();
    return canvas.toDataURL("image/png").split(",")[1];
  }
  throw new Error("Unknown action " + action);
`;

// A click through the widget layer, so it counts as user input (needed for permissions.request).
const CLICK = `
  const element = document.querySelector(arguments[0]);
  element.scrollIntoView({ block: "center" });
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  for (const type of ["mousedown", "mouseup"]) {
    if (typeof window.synthesizeMouseEvent == "function") {
      window.synthesizeMouseEvent(type, x, y, { button: 0, buttons: type == "mousedown" ? 1 : 0, clickCount: 1 }, {});
    } else {
      window.windowUtils.sendMouseEvent(type, x, y, 0, 1, 0); // Thunderbird 140
    }
  }
`;

const OPEN_OPTIONS = `
  const [id] = arguments;
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const extension = ExtensionParent.GlobalManager.getExtension(id);
  const url = extension.baseURI.resolve("options/options.html");
  Services.wm.getMostRecentWindow("mail:3pane").document.getElementById("tabmail").openTab("contentTab", { url });
  return url;
`;

// Clicks "Allow" (or the first other button) in the prompt Thunderbird shows for permissions.request().
const ANSWER_PERMISSION_PROMPT = `
  const [allow] = arguments;
  const win = Services.wm.getMostRecentWindow("mail:3pane");
  const notification = win.PopupNotifications.getNotification("addon-webext-permissions");
  if (!notification) {
    return false;
  }
  (allow ? notification.mainAction : notification.secondaryActions[0]).callback();
  win.PopupNotifications.remove(notification);
  return true;
`;

const STORAGE = `
  const [id, action, data] = arguments;
  const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
  const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
  const extension = ExtensionParent.GlobalManager.getExtension(id);
  const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(extension));
  if (action == "set") {
    // Like storage.local.set(): open pages of the add-on hear about the change.
    const changes = await db.set(data);
    if (changes) {
      ExtensionStorageIDB.notifyListeners(extension.id, changes);
    }
    return null;
  }
  return db.get(data);
`;

// ---------------------------------------------------------------------------

async function main() {
  const workDir = mkdtempSync(path.join(tmpdir(), "pushover-e2e-"));
  const certificates = createCertificates(workDir);
  const pop3 = await startPop3Server();
  const imap = process.env.GREENMAIL_JAR ? await startImapServer(process.env.GREENMAIL_JAR) : null;
  const pushover = await startPushoverMock(certificates);
  const thunderbird = launchThunderbird(workDir, pushover.port);

  let tb;
  try {
    tb = await Marionette.connect(MARIONETTE_PORT);
    await tb.startSession();
    const { version, locale } = await tb.chrome(INIT, certificates.caBase64);
    loadMessages(locale);

    // Each account: its key and how test mail gets into its Inbox.
    const pop3Account = {
      key: await tb.chrome(CREATE_ACCOUNT, "pop3", pop3.port, "E2E POP3"),
      deliver: async mails => pop3.setMessages(mails),
    };
    const imapAccount = imap && {
      key: await tb.chrome(CREATE_ACCOUNT, "imap", imap.imapPort, "E2E IMAP"),
      deliver: async mails => {
        for (const { raw } of mails) {
          await imap.deliver(raw);
        }
      },
    };
    const accountKey = pop3Account.key;
    console.log(`Thunderbird ${version} (${locale}); accounts: POP3${imap ? ", IMAP (GreenMail)" : ""}\n`);

    const storage = {
      set: values => tb.chrome(STORAGE, ADDON_ID, "set", values),
      get: keys => tb.chrome(STORAGE, ADDON_ID, "get", keys),
    };
    /**
     * The account's folders once `done(folders)` holds, or as they are when
     * FOLDERS_TIMEOUT_MS has passed. Filter moves on IMAP take a while to show.
     */
    const waitForFolders = async (account, done) => {
      const deadline = Date.now() + FOLDERS_TIMEOUT_MS;
      for (;;) {
        const folders = await tb.chrome(FOLDER_CONTENTS, account.key);
        if (done(folders) || Date.now() >= deadline) {
          return folders;
        }
        await sleep(500);
      }
    };
    /**
     * Watches when `mail` leaves the account's local Inbox. stop() returns
     * { seen, leftAt }: whether it was ever there, and when it was first found
     * gone (null: still there).
     */
    const watchInbox = (account, mail) => {
      const messageId = `${mail.id}@e2e.test`;
      let seen = false;
      let leftAt = null;
      let stopped = false;
      const polling = (async () => {
        while (!stopped && leftAt === null) {
          const inInbox = (await tb.chrome(INBOX_MESSAGE_IDS, account.key)).includes(messageId);
          if (inInbox) {
            seen = true;
          } else if (seen) {
            leftAt = Date.now();
          }
          await sleep(200);
        }
      })();
      return {
        async stop() {
          stopped = true;
          await polling;
          return { seen, leftAt };
        },
      };
    };

    let mailNumber = 0;
    const mail = fields => {
      mailNumber++;
      const message = {
        id: `mail-${mailNumber}-${Date.now()}`,
        from: '"Alice Example" <alice@example.com>',
        subject: `Message ${mailNumber}`,
        text: "Hello from Alice.",
        // Whole seconds, two minutes ago: comparable with Pushover's timestamp.
        date: new Date(Math.floor(Date.now() / 1000 - 120) * 1000),
        ...fields,
      };
      mailContents.add(message.subject).add(message.html ?? message.text);
      return { ...message, raw: buildMail(message) };
    };
    /** Delivers `mails` to the account's Inbox, lets Thunderbird fetch them, returns the notifications sent. */
    const receive = async (mails, expected, account = pop3Account) => {
      pushover.clear();
      await account.deliver(mails);
      await tb.chrome(GET_NEW_MAIL, account.key);
      const deadline = Date.now() + 20000;
      while (pushover.requests.length < expected && Date.now() < deadline) {
        await sleep(200);
      }
      await sleep(SETTLE_MS);
      return [...pushover.requests];
    };

    // -- Upgrade from 1.x ---------------------------------------------------
    console.log("Upgrade from 1.3.3.1 (Manifest V2) to 2.0 keeps settings and migrates consent");
    const legacyDir = mkdtempSync(path.join(workDir, "legacy-"));
    execSync(`git -c safe.directory='*' -C "${REPO}" archive ${LEGACY_COMMIT} | tar -x -C "${legacyDir}"`);
    await tb.send("Addon:Install", { path: legacyDir, temporary: true });
    await sleep(1000);
    const legacySettings = {
      pushoverUserKey: USER_KEY,
      pushoverAppToken: APP_TOKEN,
      enableNotifications: true,
      selectedAccounts: [accountKey],
      filterSender: "",
      filterSubject: "",
      includeBody: false,
      bodyCharLimit: 0,
      notificationPriority: "0",
      notificationSound: "",
      retryInterval: 60,
      expireTime: 3600,
    };
    await storage.set(legacySettings);
    await tb.send("Addon:Install", { path: REPO, temporary: true });
    await sleep(3000);
    const info = await tb.chrome(EXTENSION_INFO, ADDON_ID);
    check(info?.version === "2.0.0" && info.manifestVersion === 3, "2.0.0 (Manifest V3) is loaded", info);
    check(info?.warnings.length === 0, "the manifest loads without warnings", info?.warnings);
    check(
      ["messagesRead", "accountsRead", "storage"].every(p => info?.permissions.includes(p)),
      "the permissions are granted",
      info?.permissions
    );
    check(!info?.tabs.some(url => url.includes("options/options.html")), "no options tab is opened on update", info?.tabs);
    const migrated = await storage.get([...Object.keys(legacySettings), "dataConsent"]);
    check(migrated.dataConsent === true, "consent is migrated for users with keys", migrated.dataConsent);
    check(
      Object.entries(legacySettings).every(([key, value]) => JSON.stringify(migrated[key]) === JSON.stringify(value)),
      "all 1.x settings are kept",
      migrated
    );

    const base = {
      ...legacySettings,
      dataConsent: true,
      inboxOnly: false,
      skipJunk: true,
      summaryThreshold: 0,
      showAccountName: false,
      debugLogging: true,
    };
    const scenario = async (title, settings, run) => {
      console.log(`\n${title}`);
      await storage.set({ ...base, ...settings });
      await run();
    };

    // -- Default mode: format, body preview, emergency priority ------------
    await scenario(
      "Default mode: sender as title, subject + body preview, emergency priority",
      { includeBody: true, showAccountName: true, notificationPriority: "2", notificationSound: "cosmic" },
      async () => {
        const plain = mail({ subject: "Plain hello", text: "Hello Alice here.\n\nSecond   paragraph." });
        const html = mail({
          from: "Bob <bob@example.com>",
          subject: "HTML only",
          html: "<html><body><p>Hi <b>there</b></p><p>Line two</p></body></html>",
        });
        const sent = await receive([plain, html], 2);
        check(sent.length === 2, "one notification per mail", sent.length);
        const alice = sent.find(r => r.title?.startsWith("Alice"));
        const bob = sent.find(r => r.title?.startsWith("Bob"));
        check(alice?.title === "Alice Example · E2E POP3", "title is the sender name plus account", alice?.title);
        check(
          alice?.message === "Plain hello\n\nHello Alice here.\n\nSecond paragraph.",
          "message is the subject plus the cleaned-up body",
          alice?.message
        );
        check(
          bob?.message?.startsWith("HTML only\n\n") && /Hi there/.test(bob.message) && /Line two/.test(bob.message) && !/</.test(bob.message),
          "HTML-only mail gets a plain-text preview",
          bob?.message
        );
        check(alice?.timestamp === String(plain.date.getTime() / 1000), "timestamp is the mail's date", alice?.timestamp);
        check(
          alice?.priority === "2" && alice.retry === "60" && alice.expire === "3600" && alice.sound === "cosmic",
          "emergency priority sends retry/expire and the sound",
          alice
        );
        check(alice?.token === APP_TOKEN && alice.user === USER_KEY, "keys are sent");
        check(!("device" in (alice ?? {})), "no empty optional parameters are sent", alice);
      }
    );

    await scenario(
      "Default mode: address as title, no subject, body limit, high priority, device, no debug messages",
      { includeBody: true, bodyCharLimit: 10, notificationPriority: "1", pushoverDevice: "pixel", debugLogging: false },
      async () => {
        const debugBefore = debugLines().length;
        const sent = await receive(
          [
            mail({ from: "carol@example.com", subject: "", text: "0123456789 and more" }),
            mail({ subject: "From the future", date: new Date(Date.now() + 86400000) }),
          ],
          2
        );
        const carol = sent.find(r => r.title === "carol@example.com");
        const future = sent.find(r => r.message?.startsWith("From the future"));
        check(Boolean(carol), "the address is the title when the sender has no name", sent.map(r => r.title));
        check(
          carol?.message === `${msg("noSubject")}\n\n012345678…`,
          "mail without a subject says so; the preview stops at the limit",
          carol?.message
        );
        check(
          carol?.priority === "1" && carol.device === "pixel" && !("retry" in carol) && !("sound" in carol),
          "high priority goes to the device, without emergency parameters or sound",
          carol
        );
        check(future && !("timestamp" in future), "mail dated in the future gets no timestamp", future);
        check(debugLines().length === debugBefore, "no debug messages when they are off", debugLines().slice(debugBefore));
      }
    );

    // -- The reported problem, and the new option ---------------------------
    const filteredMails = () => [
      mail({ subject: "Stays in the Inbox" }),
      mail({ subject: "Weekly newsletter" }),
      mail({ subject: "please later-move this" }),
      mail({ subject: "spammy offer" }),
      mail({ subject: "delete-me please" }),
    ];
    await scenario("Inbox-only mode off (1.x behaviour): filtered mail", { skipJunk: false }, async () => {
      const withoutOption = await receive(filteredMails(), 5);
      console.log(`    notified: ${JSON.stringify(withoutOption.map(r => r.message))}`);
      check(withoutOption.length > 1, "mail handled by filters notifies too (the reported problem)", withoutOption.length);
      const notified = withoutOption.map(r => r.message);
      check(
        notified.includes("Weekly newsletter") && notified.includes("spammy offer") && !notified.includes("delete-me please"),
        "mail moved to a normal folder or marked as junk notifies, deleted mail does not",
        notified
      );
    });

    await scenario("Inbox-only mode off, junk skipped", {}, async () => {
      const notified = (await receive(filteredMails(), 3)).map(r => r.message);
      check(
        notified.includes("Stays in the Inbox") && !notified.includes("spammy offer"),
        "mail marked as junk does not notify",
        notified
      );
    });

    await scenario("Inbox-only mode on: only mail that stays in the Inbox notifies", { inboxOnly: true }, async () => {
      const sent = await receive(filteredMails(), 1);
      const filtered = folders =>
        folders.Newsletters?.some(s => s === "Weekly newsletter") &&
        folders.Later?.some(s => s === "please later-move this") &&
        folders.Trash?.some(s => s === "delete-me please") &&
        folders.Inbox?.some(s => s === "spammy offer [junk]");
      const folders = await waitForFolders(pop3Account, filtered);
      console.log(`    folders: ${JSON.stringify(folders)}`);
      check(filtered(folders), "the filters moved, deleted and junk-marked the test mail", folders);
      check(
        sent.length === 1 && sent[0].message === "Stays in the Inbox",
        "only the mail still in the Inbox notifies",
        sent.map(r => r.message)
      );
    });

    await scenario("Inbox-only mode on, junk not skipped", { inboxOnly: true, skipJunk: false }, async () => {
      const sent = await receive(filteredMails(), 2);
      check(
        sent.map(r => r.message).sort().join("|") === "Stays in the Inbox|spammy offer",
        "junk-marked mail that stays in the Inbox notifies when junk is not skipped",
        sent.map(r => r.message)
      );
    });

    // -- IMAP: filters run on the server's Inbox, moves happen on the server --
    if (imapAccount) {
      await scenario("IMAP, Inbox-only mode off (1.x behaviour): filtered mail", { selectedAccounts: [imapAccount.key], skipJunk: false }, async () => {
        const sent = await receive(filteredMails(), 5, imapAccount);
        console.log(`    notified: ${JSON.stringify(sent.map(r => r.message))}`);
        check(sent.length > 1, "mail handled by filters notifies too (the reported problem)", sent.length);
      });

      await scenario("IMAP, Inbox-only mode on: only mail that stays in the Inbox notifies", { selectedAccounts: [imapAccount.key], inboxOnly: true }, async () => {
        const lateMove = "please later-move this";
        const mails = filteredMails();
        const watch = watchInbox(imapAccount, mails.find(m => m.subject === lateMove));
        const sent = await receive(mails, 1, imapAccount);
        const filtered = folders =>
          folders.Newsletters?.includes("Weekly newsletter") &&
          folders.Later?.includes(lateMove) &&
          !(folders.Inbox ?? folders.INBOX ?? []).some(s => /newsletter|later-move|delete-me/.test(s));
        const folders = await waitForFolders(imapAccount, filtered);
        const { seen, leftAt } = await watch.stop();
        console.log(`    folders: ${JSON.stringify(folders)}`);
        check(filtered(folders), "the filters moved the test mail on the server", folders);

        // The add-on checks the Inbox once, about 5 s after the mail was reported
        // (README: known limits). The filter running after junk classification
        // moves the mail on the server; when that move is still running at the
        // check (a busy machine), the mail notifies. Thunderbird 140 always gets
        // there: it skips these filters while the new mail keeps the Inbox
        // locked and runs them at the next update of the folder (here: in
        // waitForFolders). That is accepted only if the move demonstrably ended
        // after the notification was on its way (with 1 s for the check itself).
        // A move that ended long before means the Inbox check failed: the bug
        // fixed in 2.0, so it still fails the test.
        const lateNotification = sent.find(r => r.message === lateMove);
        const slowMove = Boolean(lateNotification) && seen && (leftAt === null || leftAt > lateNotification.receivedAt - 1000);
        if (slowMove) {
          console.log(
            `    ⚠ the move by the after-junk filter ended ${leftAt === null ? "after the watch" : `${leftAt - lateNotification.receivedAt} ms after the notification`}: ` +
              "its notification is the documented limit, not counted as a failure"
          );
        }
        const expected = slowMove ? ["Stays in the Inbox", lateMove] : ["Stays in the Inbox"];
        check(
          sent.map(r => r.message).sort().join("|") === expected.sort().join("|"),
          "only the mail still in the Inbox notifies",
          { notified: sent.map(r => ({ message: r.message, receivedAt: r.receivedAt })), lateMove: { seen, leftAt } }
        );
      });

      await scenario("IMAP, body preview downloaded from the server", { selectedAccounts: [imapAccount.key], includeBody: true }, async () => {
        const sent = await receive(
          [mail({ from: "Bob <bob@example.com>", subject: "IMAP HTML", html: "<p>Hello <i>from</i> IMAP</p>" })],
          1,
          imapAccount
        );
        const preview = sent.find(r => r.message?.startsWith("IMAP HTML"));
        check(preview?.message === "IMAP HTML\n\nHello from IMAP", "the preview is the plain text of the body", sent.map(r => r.message));
      });

      // Inbox-only mode waits 5 s (not 1.5 s) for more mail: room for the second fetch.
      await scenario(
        "Burst of mail over two accounts: one summary",
        { selectedAccounts: [accountKey, imapAccount.key], summaryThreshold: 3, showAccountName: true, inboxOnly: true },
        async () => {
          pushover.clear();
          await imapAccount.deliver([mail({ subject: "Burst over IMAP" })]);
          await tb.chrome(GET_NEW_MAIL, imapAccount.key);
          const sent = await receive([mail({ subject: "Burst over POP3 1" }), mail({ subject: "Burst over POP3 2" })], 1);
          check(sent.length === 1 && sent[0].message.split("\n").length === 3, "a single notification for the mail of both accounts", sent);
          check(sent[0]?.title === msg("summaryTitle", ["3"]), "title counts the mails without an account name", sent[0]?.title);
        }
      );
    } else {
      console.log("\nIMAP scenarios skipped: GREENMAIL_JAR is not set.");
    }

    // -- Summary, filters, consent, errors ----------------------------------
    await scenario("Burst of mail: one summary", { summaryThreshold: 5, showAccountName: true }, async () => {
      const sent = await receive(Array.from({ length: 6 }, (_, i) => mail({ subject: `Burst ${i + 1}` })), 1);
      check(sent.length === 1, "a single notification", sent.length);
      check(sent[0]?.title === `${msg("summaryTitle", ["6"])} · E2E POP3`, "title counts the mails and names the account", sent[0]?.title);
      check(sent[0]?.message.split("\n").length === 6, "one line per mail", sent[0]?.message);
    });

    await scenario("Sender and subject filters", { filterSender: "ALICE", filterSubject: "invoice\nreport" }, async () => {
      const sent = await receive(
        [
          mail({ subject: "Invoice 42" }),
          mail({ subject: "Monthly Report" }),
          mail({ subject: "Lunch?" }),
          mail({ from: "Bob <bob@example.com>", subject: "Invoice 43" }),
        ],
        2
      );
      check(
        sent.map(r => r.message).sort().join("|") === "Invoice 42|Monthly Report",
        "only matching sender and subject, case-insensitive",
        sent.map(r => r.message)
      );
    });

    // Every reason not to send anything.
    for (const [title, settings] of [
      ["Account not selected", { selectedAccounts: [] }],
      ["No consent", { dataConsent: false }],
      ["Notifications switched off", { enableNotifications: false }],
      ["No user key", { pushoverUserKey: "" }],
    ]) {
      await scenario(title, settings, async () => {
        check((await receive([mail({})], 0)).length === 0, "no notification");
      });
    }

    await scenario("Pushover fails once (HTTP 500)", {}, async () => {
      pushover.setMode("error-once");
      const sent = await receive([mail({ subject: "Retried" })], 2);
      check(sent.length === 2 && sent.every(r => r.message === "Retried"), "the request is retried once", sent.map(r => r.message));
      const { lastStatus } = await storage.get(["lastStatus"]);
      check(lastStatus?.ok === true, "the retry's success is the last status", lastStatus);
    });

    await scenario("Pushover rejects the request", {}, async () => {
      pushover.setMode("reject");
      const sent = await receive([mail({}), mail({}), mail({})], 1);
      pushover.setMode("ok");
      check(sent.length === 1, "the batch stops after the first rejected request", sent.length);
      const { lastStatus } = await storage.get(["lastStatus"]);
      check(
        lastStatus?.ok === false && /application token is invalid/.test(lastStatus.error),
        "the error is shown as last status",
        lastStatus
      );
    });

    // -- Options page ---------------------------------------------------------
    await scenario("Options page", { notificationSound: "", pushoverDevice: "" }, async () => {
      pushover.clear();
      const url = await tb.chrome(OPEN_OPTIONS, ADDON_ID);
      const page = await OptionsPage.open(tb, url);
      /** Shows the last delivery at SCREENSHOT_TIME (only when taking screenshots). */
      const pinLastStatusTime = async () => {
        if (ARTIFACTS) {
          const { lastStatus } = await storage.get(["lastStatus"]);
          await storage.set({ lastStatus: { ...lastStatus, time: SCREENSHOT_TIME } });
          check(
            await page.waitFor(`return document.getElementById("last-status").textContent.includes(new Date(${SCREENSHOT_TIME}).toLocaleString())`),
            "the last status follows storage changes"
          );
        }
      };
      try {
        const loaded = await page.waitFor(`return document.getElementById("pushoverUserKey").value === ${JSON.stringify(USER_KEY)}`);
        check(loaded, "opens with the stored settings");
        const texts = await page.run(`
          return {
            heading: document.querySelector("h1").textContent,
            untranslated: [...document.querySelectorAll("[data-i18n]")].filter(e => !e.textContent.trim()).length,
            accounts: [...document.querySelectorAll('input[name="account"]')].map(e => e.nextSibling.textContent + ":" + e.checked),
            lastStatus: document.getElementById("last-status").textContent,
          };
        `);
        check(texts.heading === msg("optionsTitle") && texts.untranslated === 0, "all texts are localized", texts);
        check(texts.accounts.includes("E2E POP3:true"), "lists the accounts with their selection", texts.accounts);
        check(/application token is invalid/.test(texts.lastStatus), "shows the last delivery status", texts.lastStatus);
        await pinLastStatusTime();
        await page.screenshot("options-delivery-error");

        await page.click("#send-test");
        check(
          await page.waitFor(`return document.getElementById("credentials-status").textContent === ${JSON.stringify(msg("testSent"))}`),
          "Send test confirms the delivery"
        );
        check(
          pushover.requests.some(r => r.title === msg("testTitle") && r.message === msg("testMessage")),
          "Send test notification works without host permission (CORS)",
          pushover.requests
        );
        check(
          await page.waitFor(`return document.getElementById("last-status").classList.contains("ok")`),
          "the successful test replaces the failure shown as last notification"
        );

        /** Answers the permission prompt once it shows; false if it never does. */
        const answerPrompt = async allow => {
          for (let i = 0; i < 50; i++) {
            if (await tb.chrome(ANSWER_PERMISSION_PROMPT, allow)) {
              return true;
            }
            await sleep(100);
          }
          return false;
        };
        await page.click("#validate-keys");
        check(await answerPrompt(false), "Check keys asks for access to api.pushover.net");
        check(
          await page.waitFor(`return document.getElementById("credentials-status").textContent === ${JSON.stringify(msg("permissionDenied"))}`),
          "Check keys says when the access was denied"
        );
        await page.click("#validate-keys");
        check(await answerPrompt(true), "Check keys asks again");
        await page.waitFor(`return document.getElementById("credentials-status").textContent === ${JSON.stringify(msg("keysValid", ["pixel, iphone"]))}`);
        const validation = await page.run(`
          return {
            status: document.getElementById("credentials-status").textContent,
            devices: [...document.querySelectorAll("#device-options option")].map(o => o.value),
          };
        `);
        check(
          pushover.calls.includes("POST /1/users/validate.json") && validation.devices.join() === "pixel,iphone",
          "Check keys validates them and lists the devices",
          validation
        );

        await page.click("#load-sounds");
        await page.waitFor(`return !document.getElementById("delivery-status").hidden`);
        const sounds = await page.run(`return {
          status: document.getElementById("delivery-status").textContent,
          options: [...document.getElementById("notificationSound").options].map(o => o.textContent),
        }`);
        check(
          sounds.status === msg("soundsLoaded", ["2"]) && sounds.options.join() === [msg("soundDefault"), "Pushover (default)", "My E2E Sound"].join(),
          "Load sounds replaces the list with the account's sounds (no extra prompt)",
          sounds
        );

        await page.run(`
          document.getElementById("notificationSound").value = "e2e-custom";
          document.getElementById("inboxOnly").checked = true;
          document.getElementById("retryInterval").value = "5";
        `);
        await page.click('button[type="submit"]');
        await page.waitFor(`return document.getElementById("save-status").classList.contains("ok")`);
        const saved = await storage.get(["notificationSound", "inboxOnly", "retryInterval", "customSounds"]);
        check(
          saved.notificationSound === "e2e-custom" && saved.inboxOnly === true && saved.retryInterval === 30 && saved.customSounds?.["e2e-custom"],
          "Save stores the settings (clamped) and keeps the loaded sounds",
          saved
        );
        await page.screenshot("options-settings", "#accounts-list");

        // Pretend the system uses a dark theme: the page should switch to its dark colors.
        await tb.chrome(`Services.prefs.setIntPref("ui.systemUsesDarkTheme", 1);`);
        const dark = await page.waitFor(
          `return getComputedStyle(document.body).backgroundColor != "rgb(247, 247, 249)"`
        );
        check(dark, "the page follows the dark color scheme");
        await page.screenshot("options-settings.dark", "#accounts-list");
        await tb.chrome(`Services.prefs.clearUserPref("ui.systemUsesDarkTheme");`);
      } finally {
        await page.close();
      }
    });

    await scenario("Options page: input checks and errors", { notificationSound: "retired-sound" }, async () => {
      const page = await OptionsPage.open(tb, await tb.chrome(OPEN_OPTIONS, ADDON_ID));
      /** Sets a field like typing does. */
      const type = (id, value) =>
        page.run(
          `const e = document.getElementById(arguments[0]);
           e.value = arguments[1];
           for (const name of ["input", "change"]) e.dispatchEvent(new Event(name, { bubbles: true }));`,
          id,
          value
        );
      /** Clicks `selector` and waits until the status `statusId` shows `text` (hidden first, so an old text doesn't count). */
      const clickShows = async (selector, statusId, text) => {
        await page.run(`document.getElementById(arguments[0]).hidden = true`, statusId);
        await page.click(selector);
        return page.waitFor(`const e = document.getElementById(${JSON.stringify(statusId)}); return !e.hidden && e.textContent === ${JSON.stringify(text)}`);
      };
      const shown = () =>
        page.run(`return {
          token: document.getElementById("pushoverAppToken").type + " " + document.getElementById("toggle-token").textContent,
          emergency: !document.getElementById("emergency-settings").hidden,
          bodyLimit: !document.getElementById("bodyCharLimit").disabled,
          accountsWarning: !document.getElementById("accounts-warning").hidden,
          userKeyMarked: document.getElementById("pushoverUserKey").classList.contains("invalid"),
        }`);
      try {
        check(
          await page.waitFor(`return document.getElementById("notificationSound").value === "retired-sound"`),
          "a saved sound that is not in the list stays selected"
        );
        let state = await shown();
        check(
          state.token === `password ${msg("buttonShow")}` && !state.emergency && !state.bodyLimit && !state.accountsWarning,
          "token masked; no emergency settings, body limit or account warning",
          state
        );
        await page.click("#toggle-token");
        await type("notificationPriority", "2");
        await page.click("#includeBody");
        await page.click('input[name="account"]:checked');
        state = await shown();
        check(state.token === `text ${msg("buttonHide")}`, "Show reveals the token", state.token);
        check(state.emergency && state.bodyLimit && state.accountsWarning, "emergency settings, body limit and account warning follow the form", state);
        await page.click("#toggle-token");
        await page.click(`input[name="account"][value="${accountKey}"]`);
        state = await shown();
        check(state.token === `password ${msg("buttonShow")}` && !state.accountsWarning, "Hide masks the token; selecting an account clears the warning", state);

        pushover.clear();
        await type("pushoverUserKey", "not-a-key");
        check(await clickShows('button[type="submit"]', "save-status", msg("keysMalformed")), "Save refuses a malformed key");
        check((await shown()).userKeyMarked, "the malformed key is marked");
        check((await storage.get(["pushoverUserKey"])).pushoverUserKey === USER_KEY, "nothing is saved");
        check(await clickShows("#send-test", "credentials-status", msg("keysMissing")), "Send test refuses a malformed key");
        await type("pushoverUserKey", USER_KEY);
        check(!(await shown()).userKeyMarked, "typing clears the mark");
        await type("pushoverAppToken", "");
        check(await clickShows("#validate-keys", "credentials-status", msg("keysMissing")), "Check keys needs both keys");
        check(await clickShows("#load-sounds", "delivery-status", msg("tokenMissing")), "Load sounds needs the token");
        check(pushover.calls.length === 0, "nothing is sent to Pushover without valid keys", pushover.calls);
        await type("pushoverAppToken", APP_TOKEN);

        await page.click("#dataConsent");
        check(await clickShows('button[type="submit"]', "save-status", msg("savedWithoutConsent")), "Save without consent warns that nothing will be sent");
        check((await storage.get(["dataConsent"])).dataConsent === false, "the withdrawn consent is saved");
        await page.click("#dataConsent");
        check(await clickShows('button[type="submit"]', "save-status", msg("saved")), "Save with consent confirms");
        check(await page.waitFor(`return document.getElementById("save-status").hidden`), "the confirmation disappears after a few seconds");

        pushover.setMode("reject");
        const error = "application token is invalid (HTTP 400)";
        check(await clickShows("#send-test", "credentials-status", msg("testFailed", [error])), "a failed test notification shows Pushover's error");
        check(await page.waitFor(`return document.getElementById("last-status").classList.contains("error")`), "and becomes the last status");
        check(await clickShows("#validate-keys", "credentials-status", msg("keysInvalid", [error])), "Check keys shows Pushover's error");
        check(await clickShows("#load-sounds", "delivery-status", msg("soundsFailed", [error])), "Load sounds shows Pushover's error");
      } finally {
        pushover.setMode("ok");
        await page.close();
      }
    });

    // -- Install and update without settings ---------------------------------
    /** Uninstalls the add-on, then installs `dirs` one after another (temporarily), each given 3 s to start. */
    const reinstall = async (...dirs) => {
      await tb.send("Addon:Uninstall", { id: ADDON_ID });
      for (const dir of dirs) {
        await tb.send("Addon:Install", { path: dir, temporary: true });
        await sleep(3000);
      }
    };

    console.log("\nUpdate from 1.x without keys");
    await reinstall(legacyDir, REPO);
    const { dataConsent } = await storage.get(["dataConsent"]);
    check(dataConsent === undefined, "consent is not assumed without keys", dataConsent);

    console.log("\nFresh install");
    await reinstall(REPO);
    let fresh;
    for (let i = 0; i < 50; i++) {
      fresh = await tb.chrome(EXTENSION_INFO, ADDON_ID);
      if (fresh?.tabs.includes(fresh.optionsUrl)) {
        break;
      }
      await sleep(200);
    }
    check(fresh?.tabs.includes(fresh.optionsUrl), "the settings page opens by itself", fresh);
    const page = await OptionsPage.open(tb, fresh.optionsUrl);
    try {
      await page.waitFor(`return document.querySelector('input[name="account"]') !== null`);
      const state = await page.run(`
        return {
          consent: document.getElementById("dataConsent").checked,
          userKey: document.getElementById("pushoverUserKey").value,
          accountsWarning: !document.getElementById("accounts-warning").hidden,
          lastStatus: document.getElementById("last-status").textContent,
        };
      `);
      check(
        !state.consent && state.userKey === "" && state.accountsWarning && state.lastStatus === msg("lastStatusNone"),
        "asks for consent, keys and accounts",
        state
      );
      await page.screenshot("options-first-run", "#accounts-list");
    } finally {
      await page.close();
    }
  } catch (error) {
    failures.push(error.message);
    console.error(error);
  } finally {
    tb?.close();
    thunderbird.kill("SIGKILL");
    pop3.close();
    imap?.close();
    pushover.close();
  }

  console.log("\nThunderbird's console");
  const unexpected = consoleLines.filter(
    line =>
      /Pushover Notifier|moz-extension/.test(line) &&
      /error|warn/i.test(line) &&
      // Provoked on purpose by "Pushover rejects the request".
      !/application token is invalid/.test(line)
  );
  check(unexpected.length === 0, "no unexpected errors or warnings from the add-on", unexpected);
  check(debugLines().length > 0, "debug messages are written when they are on");
  const secrets = [USER_KEY, APP_TOKEN, ...[...mailContents].filter(Boolean)];
  const leaks = consoleLines.filter(line => /Pushover Notifier/.test(line) && secrets.some(secret => line.includes(secret)));
  check(leaks.length === 0, "keys and mail contents are never logged", leaks);

  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed.`);
    if (!VERBOSE) {
      console.log("Re-run with E2E_VERBOSE=1 to see Thunderbird's console output.");
    }
    process.exit(1);
  }
  console.log("\nAll end-to-end checks passed.");
}

/** The add-on's options page in a Thunderbird tab. */
class OptionsPage {
  static async open(tb, url) {
    const page = new OptionsPage(tb, url);
    if (!(await page.waitFor(`return document.readyState == "complete"`))) {
      throw new Error(`The options page did not load: ${url}`);
    }
    return page;
  }

  constructor(tb, url) {
    this.tb = tb;
    this.url = url;
  }

  run(script, ...args) {
    return this.tb.chrome(IN_TAB, this.url, "run", script, args);
  }

  /** Polls `condition` (a script returning a boolean); false on timeout. */
  async waitFor(condition, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.run(condition)) {
          return true;
        }
      } catch {
        // The tab may still be loading.
      }
      await sleep(100);
    }
    return false;
  }

  click(selector) {
    return this.run(CLICK, selector);
  }

  /**
   * Saves a screenshot to $E2E_ARTIFACTS, if set: the settings column, down to
   * the section holding `untilSelector`, or to the save bar (at most 2400 CSS
   * pixels). The save bar, fixed to the window bottom, is shown at the end of
   * the page instead.
   */
  async screenshot(name, untilSelector) {
    if (!ARTIFACTS) {
      return;
    }
    const rect = await this.run(`
      window.scrollTo(0, 0);
      const saveBar = document.querySelector(".save-bar");
      saveBar.style.position = "static";
      const main = document.querySelector("main").getBoundingClientRect();
      const last = arguments[0] ? document.querySelector(arguments[0]).closest("section") : saveBar;
      const end = last.getBoundingClientRect().bottom + 12;
      return [Math.floor(main.left) - 24, 0, Math.ceil(main.width) + 48, Math.min(Math.ceil(end), 2400)];
    `, untilSelector);
    const png = await this.tb.chrome(IN_TAB, this.url, "screenshot", null, rect);
    await this.run(`document.querySelector(".save-bar").style.position = "";`);
    writeFileSync(path.join(ARTIFACTS, `${name}.png`), Buffer.from(png, "base64"));
  }

  close() {
    return this.tb.chrome(IN_TAB, this.url, "close");
  }
}

function launchThunderbird(workDir, proxyPort) {
  const profile = mkdtempSync(path.join(workDir, "profile-"));
  const prefs = {
    "marionette.port": MARIONETTE_PORT,
    // All HTTPS goes through the mock proxy, which only serves api.pushover.net.
    "network.proxy.type": 1,
    "network.proxy.ssl": "127.0.0.1",
    "network.proxy.ssl_port": proxyPort,
    "network.proxy.http": "127.0.0.1",
    "network.proxy.http_port": proxyPort,
    "security.OCSP.enabled": 0,
    // Quiet, reproducible startup.
    "app.update.disabledForTesting": true,
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.reportingpolicy.firstRun": false,
    "mail.shell.checkDefaultClient": false,
    "mailnews.start_page.enabled": false,
    "mail.provider.suppress_dialog_on_startup": true,
    "mail.biff.show_alert": false,
    "mail.biff.play_sound": false,
    "extensions.update.enabled": false,
    "extensions.blocklist.enabled": false,
    "extensions.autoDisableScopes": 0,
    [`extensions.webextensions.ExtensionStorageIDB.migrated.${ADDON_ID}`]: true,
    // Console output of the add-on on stdout.
    "devtools.console.stdout.content": true,
    "devtools.console.stdout.chrome": true,
    "browser.dom.window.dump.enabled": true,
  };
  writeFileSync(
    path.join(profile, "user.js"),
    Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join("\n")
  );

  const args = ["--headless", "--marionette", "--remote-allow-system-access", "--no-remote", "--profile", profile];
  const child = spawn(TB_BINARY, args, {
    env: {
      ...process.env,
      MOZ_HEADLESS: "1",
      // Chrome-context scripts: --remote-allow-system-access is enough up to
      // Thunderbird 158; 159 also wants this variable.
      MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
      // Containers usually lack the user namespaces Gecko's sandbox needs.
      MOZ_DISABLE_CONTENT_SANDBOX: "1",
      MOZ_DISABLE_GMP_SANDBOX: "1",
      MOZ_DISABLE_RDD_SANDBOX: "1",
      MOZ_DISABLE_SOCKET_PROCESS_SANDBOX: "1",
      MOZ_DISABLE_UTILITY_SANDBOX: "1",
      MOZ_CRASHREPORTER_DISABLE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        consoleLines.push(line);
        if (VERBOSE) {
          console.log(`    [tb] ${line}`);
        }
      }
    });
  }
  return child;
}

await main();
