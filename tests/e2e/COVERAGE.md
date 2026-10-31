# End-to-end coverage

What the end-to-end test (`tests/e2e/e2e.mjs`, run by `scripts/e2e.sh` or `npm run test:e2e`) checks, per
user-facing part of the add-on. Each ✅ names `scenario › check` exactly as the test log prints them
(`✔`/`✘` lines; the checks after the last scenario are listed under *Thunderbird's console*). Every check
runs in each Thunderbird build: 140.17.0esr (en-US) and the current release in en-US and de.
❌ rows give one reason: (a) needs a real external account or device, (c) covered at another layer,
(e) left for later (estimate).

Inventory, 2026-10-31, **58 items** (entry points, events, settings-page elements, user-visible messages):

```sh
{ jq -r '"page " + .options_ui.page, "background " + .background.scripts[]' manifest.json
  grep -ohE 'messenger\.[a-zA-Z]+\.on[A-Za-z]+' background.js options/options.mjs | sed 's/^/event /'
  grep -oE ' id="[^"]+"' options/options.html | sed 's/ id="\(.*\)"/control #\1/'
  grep -ohE '\bt\("[A-Za-z]+"' background.js options/options.mjs modules/*.mjs | sed 's/t("\(.*\)"/message \1/'
} | sort -u
```

Plus 23 cross-cutting rows (notification paths, account types, install/update, language, theme, privacy):
**81 rows, ✅ 75, ❌ 6** (a 2, c 2, e 2).

## Entry points and events

| Item | Covered by |
|---|---|
| page options/options.html | ✅ Options page › opens with the stored settings |
| background background.js | ✅ Upgrade from 1.3.3.1 (Manifest V2) to 2.0 keeps settings and migrates consent › 2.0.0 (Manifest V3) is loaded; › the manifest loads without warnings; › the permissions are granted |
| event messenger.messages.onNewMailReceived | ✅ Default mode: sender as title, subject + body preview, emergency priority › one notification per mail (and every notification scenario below) |
| event messenger.runtime.onInstalled | ✅ install: Fresh install › the settings page opens by itself; update: Upgrade from 1.3.3.1 … › consent is migrated for users with keys, › no options tab is opened on update; Update from 1.x without keys › consent is not assumed without keys |
| event messenger.storage.onChanged | ✅ Options page › the successful test replaces the failure shown as last notification |

## Settings page

| Item | Covered by |
|---|---|
| control #settings-form | ✅ Options page › Save stores the settings (clamped) and keeps the loaded sounds |
| control #dataConsent | ✅ Options page: input checks and errors › Save without consent warns that nothing will be sent, › the withdrawn consent is saved; effect: No consent › no notification |
| control #pushoverUserKey | ✅ Options page › opens with the stored settings; Options page: input checks and errors › Save refuses a malformed key, › the malformed key is marked, › typing clears the mark; effect: No user key › no notification |
| control #pushoverAppToken | ✅ Options page: input checks and errors › Check keys needs both keys, › Load sounds needs the token; effect: Default mode: sender as title, … › keys are sent |
| control #toggle-token | ✅ Options page: input checks and errors › Show reveals the token, › Hide masks the token; selecting an account clears the warning |
| control #validate-keys | ✅ Options page › Check keys asks for access to api.pushover.net, › Check keys says when the access was denied, › Check keys asks again, › Check keys validates them and lists the devices |
| control #send-test | ✅ Options page › Send test notification works without host permission (CORS), › Send test confirms the delivery |
| control #credentials-status | ✅ Options page › Send test confirms the delivery; Options page: input checks and errors › Send test refuses a malformed key, › Check keys shows Pushover's error |
| control #enableNotifications | ✅ Notifications switched off › no notification |
| control #accounts-list | ✅ Options page › lists the accounts with their selection |
| control #accounts-warning | ✅ Fresh install › asks for consent, keys and accounts; Options page: input checks and errors › emergency settings, body limit and account warning follow the form, › Hide masks the token; selecting an account clears the warning |
| control #inboxOnly | ✅ Options page › Save stores the settings (clamped) …; effect: Inbox-only mode on: only mail that stays in the Inbox notifies › only the mail still in the Inbox notifies |
| control #skipJunk | ✅ Inbox-only mode off, junk skipped › mail marked as junk does not notify; Inbox-only mode on, junk not skipped › junk-marked mail that stays in the Inbox notifies when junk is not skipped |
| control #filterSender | ✅ Sender and subject filters › only matching sender and subject, case-insensitive |
| control #filterSubject | ✅ Sender and subject filters › only matching sender and subject, case-insensitive |
| control #includeBody | ✅ Default mode: sender as title, … › message is the subject plus the cleaned-up body, › HTML-only mail gets a plain-text preview; IMAP, body preview downloaded from the server › the preview is the plain text of the body |
| control #bodyCharLimit | ✅ Options page: input checks and errors › emergency settings, body limit and account warning follow the form; effect: Default mode: address as title, … › mail without a subject says so; the preview stops at the limit |
| control #showAccountName | ✅ Default mode: sender as title, … › title is the sender name plus account; Burst of mail: one summary › title counts the mails and names the account |
| control #summaryThreshold | ✅ Burst of mail: one summary › a single notification, › one line per mail |
| control #notificationPriority | ✅ Default mode: sender as title, … › emergency priority sends retry/expire and the sound; Default mode: address as title, … › high priority goes to the device, without emergency parameters or sound |
| control #emergency-settings | ✅ Options page: input checks and errors › emergency settings, body limit and account warning follow the form |
| control #retryInterval | ✅ Options page › Save stores the settings (clamped) …; effect: Default mode: sender as title, … › emergency priority sends retry/expire and the sound |
| control #expireTime | ✅ Default mode: sender as title, … › emergency priority sends retry/expire and the sound |
| control #notificationSound | ✅ Default mode: sender as title, … › emergency priority sends retry/expire and the sound; Options page: input checks and errors › a saved sound that is not in the list stays selected |
| control #load-sounds | ✅ Options page › Load sounds replaces the list with the account's sounds (no extra prompt) |
| control #pushoverDevice | ✅ Default mode: address as title, … › high priority goes to the device, without emergency parameters or sound |
| control #device-options | ✅ Options page › Check keys validates them and lists the devices |
| control #delivery-status | ✅ Options page › Load sounds replaces the list …; Options page: input checks and errors › Load sounds needs the token |
| control #debugLogging | ✅ Thunderbird's console › debug messages are written when they are on; Default mode: address as title, … › no debug messages when they are off |
| control #last-status | ✅ Options page › shows the last delivery status; Options page: input checks and errors › and becomes the last status |
| control #save-status | ✅ Options page: input checks and errors › Save with consent confirms, › the confirmation disappears after a few seconds |

## Messages the user sees

| Item | Covered by |
|---|---|
| message keysMalformed | ✅ Options page: input checks and errors › Save refuses a malformed key |
| message keysMissing | ✅ Options page: input checks and errors › Send test refuses a malformed key, › Check keys needs both keys |
| message tokenMissing | ✅ Options page: input checks and errors › Load sounds needs the token |
| message permissionDenied | ✅ Options page › Check keys says when the access was denied |
| message keysValid | ✅ Options page › Check keys validates them and lists the devices (waits for this text) |
| message keysInvalid | ✅ Options page: input checks and errors › Check keys shows Pushover's error |
| message testTitle | ✅ Options page › Send test notification works without host permission (CORS) |
| message testMessage | ✅ Options page › Send test notification works without host permission (CORS) |
| message testSent | ✅ Options page › Send test confirms the delivery |
| message testFailed | ✅ Options page: input checks and errors › a failed test notification shows Pushover's error |
| message soundDefault | ✅ Options page › Load sounds replaces the list with the account's sounds (no extra prompt) |
| message soundsLoaded | ✅ Options page › Load sounds replaces the list with the account's sounds (no extra prompt) |
| message soundsFailed | ✅ Options page: input checks and errors › Load sounds shows Pushover's error |
| message saved | ✅ Options page: input checks and errors › Save with consent confirms |
| message savedWithoutConsent | ✅ Options page: input checks and errors › Save without consent warns that nothing will be sent |
| message lastStatusNone | ✅ Fresh install › asks for consent, keys and accounts |
| message lastStatusOk | ✅ Options page › the successful test replaces the failure shown as last notification |
| message lastStatusError | ✅ Options page › shows the last delivery status |
| message accountsNone | ❌ (e) needs a profile without any mail account, Local Folders included: a second Thunderbird profile in the run, about 30 min |
| message noSubject | ✅ Default mode: address as title, … › mail without a subject says so; the preview stops at the limit |
| message summaryTitle | ✅ Burst of mail: one summary › title counts the mails and names the account |
| message summaryMore | ❌ (c) only with more than 1024 characters of summary lines: `tests/format.test.mjs` › buildSummaryNotification stays within 1024 characters and says how many are hidden |

## Notification paths and cross-cutting

| Item | Covered by |
|---|---|
| POP3: Inbox-only mode off notifies for filtered mail (1.x behaviour) | ✅ Inbox-only mode off (1.x behaviour): filtered mail › mail handled by filters notifies too (the reported problem), › mail moved to a normal folder or marked as junk notifies, deleted mail does not |
| POP3: Inbox-only mode, every filter kind (move, move after junk classification, delete, junk) | ✅ Inbox-only mode on: only mail that stays in the Inbox notifies › the filters moved, deleted and junk-marked the test mail, › only the mail still in the Inbox notifies |
| IMAP: Inbox-only mode off | ✅ IMAP, Inbox-only mode off (1.x behaviour): filtered mail › mail handled by filters notifies too (the reported problem) |
| IMAP: Inbox-only mode, moves on the server | ✅ IMAP, Inbox-only mode on: only mail that stays in the Inbox notifies › the filters moved the test mail on the server, › only the mail still in the Inbox notifies |
| IMAP: body preview downloaded from the server | ✅ IMAP, body preview downloaded from the server › the preview is the plain text of the body |
| Sender without a display name | ✅ Default mode: address as title, … › the address is the title when the sender has no name |
| Mail date as timestamp; future dates dropped | ✅ Default mode: sender as title, … › timestamp is the mail's date; Default mode: address as title, … › mail dated in the future gets no timestamp |
| Only set optional parameters are sent | ✅ Default mode: sender as title, … › no empty optional parameters are sent |
| Account not selected | ✅ Account not selected › no notification |
| Summary of mail from several accounts (no account name) | ❌ (e) needs one burst over the POP3 and the IMAP account; IMAP fetches lag, so about 20 min to make it deterministic |
| Pushover rejects a request (4xx): the batch stops, the error is the last status | ✅ Pushover rejects the request › the batch stops after the first rejected request, › the error is shown as last status |
| Pushover fails once (5xx): retried | ✅ Pushover fails once (HTTP 500) › the request is retried once, › the retry's success is the last status |
| Quota exhausted (429), network errors | ❌ (c) `tests/pushover.test.mjs` › sendNotification reports an exhausted quota (429), › sendNotification retries a network error once, and not at all when retry is off |
| Update from 1.x with keys | ✅ Upgrade from 1.3.3.1 (Manifest V2) to 2.0 keeps settings and migrates consent › all 1.x settings are kept, › consent is migrated for users with keys |
| Update from 1.x without keys | ✅ Update from 1.x without keys › consent is not assumed without keys |
| Fresh install | ✅ Fresh install › the settings page opens by itself, › asks for consent, keys and accounts |
| Language: English | ✅ every check in the en-US builds; Options page › all texts are localized |
| Language: German | ✅ every check in the de build (texts compared with `_locales/de`); Options page › all texts are localized |
| Theme: dark | ✅ Options page › the page follows the dark color scheme |
| Privacy: keys and mail contents never logged | ✅ Thunderbird's console › keys and mail contents are never logged |
| No errors or warnings from the add-on | ✅ Thunderbird's console › no unexpected errors or warnings from the add-on |
| Delivery to a phone by the real Pushover service | ❌ (a) needs a Pushover account, a device and the real API; the mock checks every request the add-on sends instead |
| Real api.pushover.net (TLS, CORS) | ❌ (a) same; the mock mirrors its CORS headers (only messages.json allows cross-origin requests) |
