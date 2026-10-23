# Screenshots

The add-on has one screen, its settings page (*Add-ons and Themes → Pushover Notifier → Options*). These screenshots come from the end-to-end test in the current Thunderbird release, with test accounts and a local Pushover mock. Regenerate them with `scripts/docs-screenshots.sh` (see [Screenshots](../../README.md#screenshots)).

## After a fresh install

The settings page opens by itself after installing. Nothing is sent until you tick the consent checkbox, enter your keys and select at least one account.

<img src="options-first-run.png" alt="Top of the settings page after a fresh install: consent unticked, empty keys, a warning that no account is selected" width="800">

## Keys checked

*Check keys* verified the keys and listed the devices; one of the two accounts is monitored.

<img src="options-settings.png" alt="Top of the settings page: consent given, keys checked with the devices pixel and iphone, one of two accounts selected" width="800">

## All settings, with a failed delivery

The whole page. *Last notification* at the bottom shows the last delivery, here an error Pushover returned for an invalid application token.

<img src="options-delivery-error.png" alt="The whole settings page; the Last notification section shows a failed delivery: application token is invalid" width="800">

## Dark mode

The page follows Thunderbird's light or dark color scheme.

<img src="options-settings.dark.png" alt="Top of the settings page in dark mode" width="800">

## German

The user interface is available in English and German.

<img src="options-settings.de.png" alt="Top of the settings page in German: Pushover Notifier – Einstellungen" width="800">
