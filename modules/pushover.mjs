// Thin client for the Pushover API (https://pushover.net/api).
// Pure module: no `messenger.*` access, so it can be unit-tested with Node.

export const API_BASE = "https://api.pushover.net/1";

// messages.json answers with CORS `*`, the other endpoints do not and need this host permission.
export const HOST_PERMISSION = Object.freeze({ origins: ["https://api.pushover.net/*"] });

export const LIMITS = Object.freeze({
  message: 1024,
  title: 250,
});

export const EMERGENCY = Object.freeze({
  minRetry: 30,
  maxExpire: 10800,
});

export const RETRY_DELAY_MS = 5000;

export const BUILTIN_SOUNDS = Object.freeze({
  pushover: "Pushover (default)",
  bike: "Bike",
  bugle: "Bugle",
  cashregister: "Cash Register",
  classical: "Classical",
  cosmic: "Cosmic",
  falling: "Falling",
  gamelan: "Gamelan",
  incoming: "Incoming",
  intermission: "Intermission",
  magic: "Magic",
  mechanical: "Mechanical",
  pianobar: "Piano Bar",
  siren: "Siren",
  spacealarm: "Space Alarm",
  tugboat: "Tug Boat",
  alien: "Alien Alarm (long)",
  climb: "Climb (long)",
  persistent: "Persistent (long)",
  echo: "Pushover Echo (long)",
  updown: "Up Down (long)",
  vibrate: "Vibrate Only",
  none: "None (silent)",
});

const KEY_PATTERN = /^[A-Za-z0-9]{30}$/;

export function isValidKey(value) {
  return KEY_PATTERN.test(String(value ?? ""));
}

/**
 * Builds the form body for messages.json. Optional parameters are only sent
 * when set, so Pushover applies the user's own defaults.
 */
export function buildRequestParams(settings, { title, message, timestamp }) {
  const params = new URLSearchParams({
    token: settings.pushoverAppToken,
    user: settings.pushoverUserKey,
    message,
    priority: settings.notificationPriority,
  });
  if (title) params.set("title", title);
  if (timestamp) params.set("timestamp", String(timestamp));
  if (settings.notificationSound) params.set("sound", settings.notificationSound);
  if (settings.pushoverDevice) params.set("device", settings.pushoverDevice);
  if (settings.notificationPriority === "2") {
    params.set("retry", String(settings.retryInterval));
    params.set("expire", String(settings.expireTime));
  }
  return params;
}

/**
 * Sends one notification. Server errors and network failures are retried once
 * after RETRY_DELAY_MS (if `retry` is true); 4xx responses are never retried,
 * as Pushover asks.
 *
 * Resolves to { ok: true } or { ok: false, status?, error }.
 */
export async function sendNotification(params, { fetch = globalThis.fetch, sleep = delay, retry = true } = {}) {
  let result = await post(fetch, `${API_BASE}/messages.json`, params);
  if (!result.ok && result.retryable && retry) {
    await sleep(RETRY_DELAY_MS);
    result = await post(fetch, `${API_BASE}/messages.json`, params);
  }
  return strip(result);
}

/**
 * Checks a user/group key and returns its active devices.
 * Needs HOST_PERMISSION.
 */
export async function validateUser({ token, user }, { fetch = globalThis.fetch } = {}) {
  const result = await post(fetch, `${API_BASE}/users/validate.json`, new URLSearchParams({ token, user }));
  return { ...strip(result), devices: result.data?.devices ?? [] };
}

/**
 * Lists the sounds available to the application, including custom sounds
 * uploaded to the owner's account. Needs HOST_PERMISSION.
 */
export async function fetchSounds(token, { fetch = globalThis.fetch } = {}) {
  const url = `${API_BASE}/sounds.json?${new URLSearchParams({ token })}`;
  let result;
  try {
    result = await evaluate(await fetch(url));
  } catch (error) {
    result = networkFailure(error);
  }
  return { ...strip(result), sounds: result.data?.sounds ?? {} };
}

async function post(fetch, url, body) {
  try {
    return await evaluate(await fetch(url, { method: "POST", body }));
  } catch (error) {
    return networkFailure(error);
  }
}

async function evaluate(response) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page); the HTTP status is all we have.
  }
  if (response.ok && data?.status === 1) {
    return { ok: true, data };
  }
  return {
    ok: false,
    status: response.status,
    retryable: response.status >= 500,
    error: describeError(response.status, data),
    data,
  };
}

function describeError(status, data) {
  if (status === 429) {
    return "Pushover message limit reached (HTTP 429)";
  }
  const errors = Array.isArray(data?.errors) ? data.errors.join("; ") : "";
  return errors ? `${errors} (HTTP ${status})` : `HTTP ${status}`;
}

function networkFailure(error) {
  return { ok: false, retryable: true, error: `Network error: ${error?.message ?? error}` };
}

function strip({ ok, status, error }) {
  return ok ? { ok } : { ok, status, error };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
