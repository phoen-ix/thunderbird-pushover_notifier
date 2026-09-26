import { loadSettings, normalizeSettings, saveLastStatus, saveSettings } from "../modules/settings.mjs";
import {
  BUILTIN_SOUNDS,
  HOST_PERMISSION,
  buildRequestParams,
  fetchSounds,
  isValidKey,
  sendNotification,
  validateUser,
} from "../modules/pushover.mjs";
import { localizeDocument, t } from "../modules/i18n.mjs";

const CHECKBOXES = [
  "dataConsent",
  "enableNotifications",
  "inboxOnly",
  "skipJunk",
  "includeBody",
  "showAccountName",
  "debugLogging",
];
const VALUES = [
  "pushoverUserKey",
  "pushoverAppToken",
  "pushoverDevice",
  "filterSender",
  "filterSubject",
  "bodyCharLimit",
  "summaryThreshold",
  "notificationPriority",
  "notificationSound",
  "retryInterval",
  "expireTime",
];
const KEY_FIELDS = ["pushoverUserKey", "pushoverAppToken"];
const SAVED_MESSAGE_MS = 4000;

const $ = id => document.getElementById(id);

init().catch(error => console.error("Pushover Notifier options:", error));

async function init() {
  localizeDocument();

  const [settings, stored, accounts] = await Promise.all([
    loadSettings(),
    messenger.storage.local.get({ customSounds: null, lastStatus: null }),
    messenger.accounts.list(false),
  ]);

  renderAccounts(accounts);
  renderSounds(stored.customSounds, settings.notificationSound);
  fillForm(settings);
  renderLastStatus(stored.lastStatus);
  updateDependentFields();

  $("settings-form").addEventListener("submit", onSave);
  $("settings-form").addEventListener("change", updateDependentFields);
  $("toggle-token").addEventListener("click", onToggleToken);
  $("validate-keys").addEventListener("click", onValidate);
  $("send-test").addEventListener("click", onSendTest);
  $("load-sounds").addEventListener("click", onLoadSounds);
  for (const id of KEY_FIELDS) {
    $(id).addEventListener("input", () => $(id).classList.remove("invalid"));
  }
  messenger.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.lastStatus) {
      renderLastStatus(changes.lastStatus.newValue);
    }
  });
}

function renderAccounts(accounts) {
  const list = $("accounts-list");
  if (accounts.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = t("accountsNone");
    list.append(empty);
    return;
  }
  for (const account of accounts) {
    const label = document.createElement("label");
    label.className = "check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "account";
    checkbox.value = account.id;
    const name = document.createElement("span");
    name.textContent = account.name;
    label.append(checkbox, name);
    list.append(label);
  }
}

function renderSounds(customSounds, selected) {
  const select = $("notificationSound");
  const sounds = customSounds && Object.keys(customSounds).length > 0 ? customSounds : BUILTIN_SOUNDS;
  select.replaceChildren(new Option(t("soundDefault"), ""));
  for (const [value, label] of Object.entries(sounds)) {
    select.append(new Option(label, value));
  }
  // Keep a saved sound selectable even if it is not in the current list.
  if (selected && !Object.hasOwn(sounds, selected)) {
    select.append(new Option(selected, selected));
  }
  select.value = selected ?? "";
}

function renderLastStatus(status) {
  const element = $("last-status");
  if (!status) {
    element.textContent = t("lastStatusNone");
    element.className = "status";
    return;
  }
  const time = new Date(status.time).toLocaleString();
  element.textContent = status.ok ? t("lastStatusOk", [time]) : t("lastStatusError", [time, status.error]);
  element.className = `status ${status.ok ? "ok" : "error"}`;
}

function fillForm(settings) {
  for (const id of CHECKBOXES) {
    $(id).checked = settings[id];
  }
  for (const id of VALUES) {
    $(id).value = String(settings[id]);
  }
  for (const checkbox of document.querySelectorAll('input[name="account"]')) {
    checkbox.checked = settings.selectedAccounts.includes(checkbox.value);
  }
}

function readForm() {
  const values = {};
  for (const id of CHECKBOXES) {
    values[id] = $(id).checked;
  }
  for (const id of VALUES) {
    values[id] = $(id).value;
  }
  values.selectedAccounts = Array.from(
    document.querySelectorAll('input[name="account"]:checked'),
    checkbox => checkbox.value
  );
  return values;
}

function updateDependentFields() {
  $("emergency-settings").hidden = $("notificationPriority").value !== "2";
  $("bodyCharLimit").disabled = !$("includeBody").checked;
  $("accounts-warning").hidden = document.querySelector('input[name="account"]:checked') !== null
    || document.querySelector('input[name="account"]') === null;
}

/** Highlights malformed keys. Empty keys are allowed (the add-on simply stays inactive). */
function checkKeys() {
  let valid = true;
  for (const id of KEY_FIELDS) {
    const value = $(id).value.trim();
    const ok = value === "" || isValidKey(value);
    $(id).classList.toggle("invalid", !ok);
    valid &&= ok;
  }
  return valid;
}

async function onSave(event) {
  event.preventDefault();
  const status = $("save-status");
  if (!checkKeys()) {
    showStatus(status, t("keysMalformed"), "error");
    return;
  }
  const settings = await saveSettings(readForm());
  // Show the values as stored, e.g. after clamping out-of-range numbers.
  fillForm(settings);
  updateDependentFields();
  if (settings.enableNotifications && !settings.dataConsent) {
    showStatus(status, t("savedWithoutConsent"), "error");
  } else {
    showStatus(status, t("saved"), "ok", SAVED_MESSAGE_MS);
  }
}

function onToggleToken() {
  const input = $("pushoverAppToken");
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  $("toggle-token").textContent = t(reveal ? "buttonHide" : "buttonShow");
}

async function onValidate() {
  const status = $("credentials-status");
  const settings = normalizeSettings(readForm());
  if (!checkKeys() || !settings.pushoverUserKey || !settings.pushoverAppToken) {
    showStatus(status, t("keysMissing"), "error");
    return;
  }
  // Request the permission before any await, while the click still counts as user input.
  if (!(await messenger.permissions.request(HOST_PERMISSION))) {
    showStatus(status, t("permissionDenied"), "error");
    return;
  }
  await withBusyButton($("validate-keys"), async () => {
    const result = await validateUser({ token: settings.pushoverAppToken, user: settings.pushoverUserKey });
    if (!result.ok) {
      showStatus(status, t("keysInvalid", [result.error]), "error");
      return;
    }
    $("device-options").replaceChildren(...result.devices.map(device => new Option(device, device)));
    showStatus(status, t("keysValid", [result.devices.join(", ") || "–"]), "ok");
  });
}

async function onSendTest() {
  const status = $("credentials-status");
  const settings = normalizeSettings(readForm());
  if (!checkKeys() || !settings.pushoverUserKey || !settings.pushoverAppToken) {
    showStatus(status, t("keysMissing"), "error");
    return;
  }
  await withBusyButton($("send-test"), async () => {
    const params = buildRequestParams(settings, { title: t("testTitle"), message: t("testMessage") });
    const result = await sendNotification(params, { retry: false });
    await saveLastStatus(result);
    if (result.ok) {
      showStatus(status, t("testSent"), "ok");
    } else {
      showStatus(status, t("testFailed", [result.error]), "error");
    }
  });
}

async function onLoadSounds() {
  const status = $("delivery-status");
  const { pushoverAppToken: token } = normalizeSettings(readForm());
  if (!token || !isValidKey(token)) {
    showStatus(status, t("tokenMissing"), "error");
    return;
  }
  // Request the permission before any await, while the click still counts as user input.
  if (!(await messenger.permissions.request(HOST_PERMISSION))) {
    showStatus(status, t("permissionDenied"), "error");
    return;
  }
  await withBusyButton($("load-sounds"), async () => {
    const result = await fetchSounds(token);
    if (!result.ok) {
      showStatus(status, t("soundsFailed", [result.error]), "error");
      return;
    }
    await messenger.storage.local.set({ customSounds: result.sounds });
    renderSounds(result.sounds, $("notificationSound").value);
    showStatus(status, t("soundsLoaded", [String(Object.keys(result.sounds).length)]), "ok");
  });
}

async function withBusyButton(button, action) {
  button.disabled = true;
  try {
    await action();
  } finally {
    button.disabled = false;
  }
}

const hideTimers = new WeakMap();

function showStatus(element, text, kind, hideAfterMs = 0) {
  clearTimeout(hideTimers.get(element));
  element.textContent = text;
  element.className = `status ${kind}`;
  element.hidden = false;
  if (hideAfterMs > 0) {
    hideTimers.set(element, setTimeout(() => (element.hidden = true), hideAfterMs));
  }
}
