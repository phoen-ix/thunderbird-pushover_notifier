# Pushover Notifier – Thunderbird Add-on

Sends a [Pushover](https://pushover.net) notification to your phone (or any other Pushover device) when new mail arrives in Thunderbird. It is useful for mail accounts that don't allow forwarding.

This add-on is not affiliated with or endorsed by Pushover. It was created independently. Use at your own risk.

## Features

- A notification per new mail: the **sender** as title, the **subject** as message, and the mail's date as timestamp.
- **Only mail that stays in the Inbox after your message filters ran** (optional). Mail your filters move to another folder, delete or mark as junk does not notify you.
- An optional **body preview**, also for HTML-only mail, trimmed to Pushover's 1024-character limit.
- **Burst summary**: when many mails arrive at once (e.g. at startup), you get one summary instead of dozens of pushes.
- Choose which **accounts** to monitor, skip junk, and filter by **sender** or **subject** (several terms, case-insensitive).
- Pushover **priority** (including emergency with retry and expire), **sound** (including your custom sounds) and target **device**.
- Settings page with **key check**, **test notification** and the result of the last delivery.
- English and German user interface.

## Requirements

- Thunderbird **140 or newer** (140 ESR, 153 ESR or the current release). Thunderbird 128 users can keep using version 1.3.3.1.
- A Pushover account (user key) and a Pushover application (API token). You can create one at <https://pushover.net/apps/build>.

## Setup

1. Install the add-on. Its settings page opens automatically. You can also reach it later via *Add-ons and Themes → Pushover Notifier → Options*.
2. Read the privacy notice and tick the consent checkbox.
3. Enter your **user key** and **API token**. Use **Check keys** to verify them (Thunderbird asks once for permission to access `api.pushover.net`), and **Send test notification** to see a push arrive.
4. Select the **accounts** to monitor and click **Save settings**.

## Settings

| Setting | Meaning |
|---|---|
| Send notifications for new mail | Master switch. |
| Accounts to monitor | Only mail in these accounts notifies you. POP3 accounts that use the global Inbox deliver into *Local Folders*, so select that account for them. |
| Only notify for mail that stays in the Inbox after message filters ran | See [Inbox-only mode](#inbox-only-mode). Without it, new mail in the Inbox and in normal folders notifies you. Special folders like Junk, Trash, Sent or Archives never do. |
| Skip mail marked as junk | No notification for mail Thunderbird classified as junk. |
| Only mail from senders / with subjects containing | One term per line. A mail must contain at least one term; case doesn't matter. Empty means all mail. |
| Include a preview of the mail body | Adds the start of the body. *Maximum preview length*: 0 means as much as fits into Pushover's 1024 characters. |
| Show the account name in the title | Useful when you monitor several accounts. |
| Send one summary when at least N mails arrive at once | 0 turns summaries off. |
| Priority, Sound, Device | Passed to Pushover. *Load sounds from Pushover* adds your custom sounds. *Device* can be left empty to send to all devices. |
| Emergency: repeat every / stop after | Only for emergency priority. Pushover requires at least 30 s between repeats and at most 10800 s (3 h) in total. |
| Debug messages | Writes details to *Tools → Developer Tools → Error Console*. Keys and mail contents are never logged. |

## Inbox-only mode

Thunderbird reports new mail after running your message filters and junk classification. However, some filters act later: filters set to run *after junk classification*, and moves on IMAP servers that take a moment to complete. Thunderbird also reports each mail only once, in the folder where it first landed.

With **Only notify for mail that stays in the Inbox** enabled, the add-on therefore:

1. ignores new mail reported in any folder other than an Inbox,
2. waits about 5 seconds,
3. checks each mail again and only notifies you about those still in the Inbox that were not marked as junk in the meantime.

Known limits:

- A filter move that takes longer than about 5 seconds (a very slow IMAP server) can still produce a notification.
- With the IMAP delete model *"Just mark it as deleted"*, a mail moved away on a server without MOVE support stays in the Inbox (marked as deleted) and may still notify you.
- Notifications arrive a few seconds later than without this mode.

## Privacy

For each new mail that passes your settings, this add-on sends the **sender**, **subject** and, only if you enable it, a **preview of the body** to Pushover (`api.pushover.net`). It sends them over HTTPS, using your own Pushover user key and API token. Pushover then delivers the notification to your devices; see [Pushover's privacy policy](https://pushover.net/privacy).

Nothing is sent to the add-on's author or to anyone else, and the add-on collects no statistics. The keys and settings are stored locally in your Thunderbird profile. The add-on sends nothing until you give your consent on its settings page.

## Development

The add-on is plain JavaScript (ES modules) without a build step.

```sh
npm install      # installs web-ext (dev only)
npm test         # unit tests (node:test)
npm run lint     # web-ext lint; warnings about "messagesRead"/"accountsRead" are expected (Thunderbird-only permissions)
npm run build    # creates web-ext-artifacts/pushover-notifier-<version>.xpi
```

To try it out, open *Tools → Developer Tools → Debug Add-ons* in Thunderbird, click *Load Temporary Add-on…* and select `manifest.json`.

Layout:

- `background.js`: event page. It receives `messages.onNewMailReceived`, queues mail, runs the Inbox check and sends notifications.
- `modules/`: settings, notification formatting, mail helpers, Pushover client and i18n. The pure parts are unit-tested in `tests/`.
- `options/`: the settings page.
- `_locales/`: translations.

## License

MIT, see [LICENSE](LICENSE).
