import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RETRY_DELAY_MS,
  buildRequestParams,
  fetchSounds,
  isValidKey,
  sendNotification,
  validateUser,
} from "../modules/pushover.mjs";
import { normalizeSettings } from "../modules/settings.mjs";

const TOKEN = "a".repeat(30);
const USER = "u".repeat(30);

function fakeFetch(...responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
    });
  };
  return { fetch, calls };
}

const noSleep = async () => {};

test("isValidKey accepts 30 alphanumeric characters only", () => {
  assert.ok(isValidKey("azGDORePK8gMaC0QOYAMyEEuzJnyUi"));
  assert.ok(!isValidKey("azGDORePK8gMaC0QOYAMyEEuzJnyU"));
  assert.ok(!isValidKey("azGDORePK8gMaC0QOYAMyEEuzJnyU!"));
  assert.ok(!isValidKey(""));
});

test("buildRequestParams only sends optional parameters when set", () => {
  const params = buildRequestParams(normalizeSettings({ pushoverAppToken: TOKEN, pushoverUserKey: USER }), {
    title: "",
    message: "Hello",
  });
  assert.deepEqual([...params.keys()].sort(), ["message", "priority", "token", "user"]);
  assert.equal(params.get("priority"), "0");
});

test("buildRequestParams sends sound, device, title, timestamp, and retry/expire for emergency", () => {
  const settings = normalizeSettings({
    pushoverAppToken: TOKEN,
    pushoverUserKey: USER,
    notificationSound: "cosmic",
    pushoverDevice: "phone",
    notificationPriority: "2",
    retryInterval: 45,
    expireTime: 20000,
  });
  const params = buildRequestParams(settings, { title: "Jane", message: "Hi", timestamp: 1790000000 });
  assert.equal(params.get("sound"), "cosmic");
  assert.equal(params.get("device"), "phone");
  assert.equal(params.get("title"), "Jane");
  assert.equal(params.get("timestamp"), "1790000000");
  assert.equal(params.get("retry"), "45");
  assert.equal(params.get("expire"), "10800");
});

test("sendNotification succeeds on status 1", async () => {
  const { fetch, calls } = fakeFetch({ body: { status: 1, request: "abc" } });
  const result = await sendNotification(new URLSearchParams({ message: "x" }), { fetch, sleep: noSleep });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.pushover.net/1/messages.json");
  assert.equal(calls[0].init.method, "POST");
});

test("sendNotification does not retry 4xx and reports Pushover's errors", async () => {
  const { fetch, calls } = fakeFetch({ status: 400, body: { status: 0, errors: ["application token is invalid"] } });
  const result = await sendNotification(new URLSearchParams(), { fetch, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, "application token is invalid (HTTP 400)");
  assert.equal(calls.length, 1);
});

test("sendNotification reports an exhausted quota (429)", async () => {
  const { fetch, calls } = fakeFetch({ status: 429, body: { status: 0, errors: ["message limit reached"] } });
  const result = await sendNotification(new URLSearchParams(), { fetch, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.match(result.error, /429/);
  assert.equal(calls.length, 1);
});

test("sendNotification retries a 5xx once after the delay", async () => {
  const { fetch, calls } = fakeFetch({ status: 503, body: "<html>" }, { body: { status: 1 } });
  const sleeps = [];
  const result = await sendNotification(new URLSearchParams(), { fetch, sleep: async ms => sleeps.push(ms) });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [RETRY_DELAY_MS]);
});

test("sendNotification retries a network error once, and not at all when retry is off", async () => {
  let { fetch, calls } = fakeFetch(new TypeError("NetworkError"), new TypeError("NetworkError"));
  let result = await sendNotification(new URLSearchParams(), { fetch, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.match(result.error, /Network error/);
  assert.equal(calls.length, 2);

  ({ fetch, calls } = fakeFetch({ status: 500, body: {} }));
  result = await sendNotification(new URLSearchParams(), { fetch, sleep: noSleep, retry: false });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});

test("results never contain the token or user key", async () => {
  const { fetch } = fakeFetch({ status: 400, body: { status: 0, token: "invalid", errors: ["application token is invalid"] } });
  const params = new URLSearchParams({ token: TOKEN, user: USER, message: "secret body" });
  const result = await sendNotification(params, { fetch, sleep: noSleep });
  const text = JSON.stringify(result);
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(USER));
  assert.ok(!text.includes("secret body"));
});

test("validateUser returns the active devices", async () => {
  const { fetch, calls } = fakeFetch({ body: { status: 1, devices: ["iphone", "pixel"] } });
  const result = await validateUser({ token: TOKEN, user: USER }, { fetch });
  assert.deepEqual(result, { ok: true, devices: ["iphone", "pixel"] });
  assert.equal(calls[0].url, "https://api.pushover.net/1/users/validate.json");
});

test("fetchSounds returns the sound map", async () => {
  const { fetch, calls } = fakeFetch({ body: { status: 1, sounds: { pushover: "Pushover (default)", mine: "My sound" } } });
  const result = await fetchSounds(TOKEN, { fetch });
  assert.equal(result.ok, true);
  assert.equal(result.sounds.mine, "My sound");
  assert.equal(calls[0].url, `https://api.pushover.net/1/sounds.json?token=${TOKEN}`);
});
