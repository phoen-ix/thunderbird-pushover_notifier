# Changelog

## 2.0.0

Rewrite for current Thunderbird versions (Manifest V3).

### New
- **Inbox-only mode**: optionally notify only for mail that is still in the Inbox after message filters ran. Mail moved, deleted or marked as junk by filters no longer notifies you.
- **Burst summary**: when several mails arrive at once (default: 5 or more), you get one summary notification instead of one per mail.
- **Check keys** and **Send test notification** buttons; the settings page shows the result of the last delivery.
- Load **custom sounds** from Pushover and pick a target **device**.
- Sender and subject filters accept several terms (one per line) and ignore case.
- Option to show the account name in the notification title.
- German translation.

### Changed
- **New notification layout**: the sender is the title and the subject is the message. The mail's date is used as the notification time.
- **Requires Thunderbird 140 or newer.** Thunderbird 128 users stay on 1.3.3.1.
- **Mail marked as junk no longer notifies** by default ("Skip mail marked as junk").
- **Summary instead of many single notifications** when 5 or more mails arrive at once. Set the threshold to 0 for the old behaviour.
- The add-on asks for explicit **consent** before sending mail data to Pushover. Existing users who had already entered their keys are migrated automatically.
- Access to `api.pushover.net` is only requested when you use *Check keys* or *Load sounds*. Sending notifications doesn't need it.

### Fixed
- Every incoming mail registered an additional event listener.
- The Pushover token and user key were written to the error console.
- Notifications with a long body preview failed silently (Pushover's 1024-character limit is now respected).
- Body previews were empty for HTML and most multipart mails.
- Only the first 100 mails of a large batch were processed.
- An empty "sound" parameter was sent; the emergency expire time was not limited to 3 hours; empty number fields were saved as `NaN`.
- Leading or trailing spaces in pasted keys broke delivery.

## 1.3.3.1
- Last Manifest V2 version.
