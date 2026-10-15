import test, { mock } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

import { istDay, detectWeatherAlerts, alreadySentToday, newAlertsOnly, THRESHOLDS } from "../services/weatherAlerts.js";
import { harvestMilestone, wantsEmail, checkCropDeadlines, runWeatherAlertJob } from "../services/notifications.js";
import { fetchCurrentWeather } from "../features/loanAssistant/services/weatherClient.js";

const at = (iso) => new Date(iso);
// Noon IST on a given day of October 2026, as a Date.
const noonIst = (day) => at(`2026-10-${String(day).padStart(2, "0")}T06:30:00Z`);

// ---------- India time, not the server's ----------

test("days are counted in IST: 00:30 IST is the next day, though it is still the previous day in UTC", () => {
  assert.equal(istDay(at("2026-10-10T18:00:00Z")), istDay(at("2026-10-10T12:00:00Z"))); // 23:30 IST, same IST day as noon
  assert.equal(istDay(at("2026-10-10T19:00:00Z")), istDay(at("2026-10-10T12:00:00Z")) + 1); // 00:30 IST next day
});

// ---------- who gets emailed ----------

test("preferences: the master switch beats everything; unset means on, not off", () => {
  assert.equal(wantsEmail({ notificationPreferences: { emailNotifications: false, deadlineReminders: true } }, "harvest"), false);
  assert.equal(wantsEmail({ notificationPreferences: { emailNotifications: false } }, "weather"), false);
  assert.equal(wantsEmail({ notificationPreferences: { emailNotifications: true, deadlineReminders: false } }, "harvest"), false);
  assert.equal(wantsEmail({ notificationPreferences: { emailNotifications: true, deadlineReminders: false } }, "weather"), true); // reminders toggle is harvest-only
  assert.equal(wantsEmail({}, "harvest"), true); // never saved: the default (on). The old code skipped these users entirely.
  assert.equal(wantsEmail({ notificationPreferences: {} }, "weather"), true);
  assert.equal(wantsEmail(null, "weather"), true);
});

// ---------- harvest reminders: catch-up instead of exact-day ----------

// planted 1 Oct, 10 days to grow => harvest starts 11 Oct; a 5-day window => 11-15 Oct
const crop = { plantDate: at("2026-10-01"), growDuration: 10, harvestDuration: 5 };
const m = (day, sent = {}, extra = {}) => harvestMilestone({ ...crop, ...extra, sent, now: noonIst(day) });

test("the three reminder days still work", () => {
  assert.deepEqual([m(8).send, m(8).daysUntilHarvest], ["threeDay", 3]);
  assert.equal(m(10).send, "oneDay");
  assert.equal(m(11).send, "harvestDay");
  assert.equal(m(7).send, null); // 4 days out: too early
});

test("a missed day is caught up: 2 days out used to send nothing at all", () => {
  const r = m(9);
  assert.equal(r.daysUntilHarvest, 2);
  assert.equal(r.send, "threeDay");
});

test("after a longer outage only the most urgent reminder goes, and the older ones are closed", () => {
  const r = m(11); // nothing was sent in the last three days
  assert.equal(r.send, "harvestDay");
  assert.deepEqual(r.markSent.sort(), ["harvestDay", "oneDay", "threeDay"]);
});

test("reminders already sent are not repeated", () => {
  assert.equal(m(9, { threeDay: true }).send, null);
  assert.equal(m(10, { threeDay: true }).send, "oneDay");
  assert.deepEqual(m(10, { threeDay: true }).markSent, ["oneDay"]);
  assert.equal(m(11, { harvestDay: true, oneDay: true, threeDay: true }).send, null);
});

test("a stale less-urgent flag does not trigger a wrong email once the urgent one went out", () => {
  const r = m(11, { harvestDay: true });
  assert.equal(r.send, null);
  assert.deepEqual(r.markSent.sort(), ["oneDay", "threeDay"]);
});

test("late, but still inside the harvest window: sent, and says how late", () => {
  const r = m(13);
  assert.equal(r.send, "harvestDay");
  assert.equal(r.daysLate, 2);
});

test("harvestDuration is the window: once it is over nothing is sent, the flags just close", () => {
  const r = m(20); // window ended 15 Oct
  assert.equal(r.send, null);
  assert.equal(r.expired, true);
  assert.deepEqual(r.markSent.sort(), ["harvestDay", "oneDay", "threeDay"]);
  // a crop entered today with an old planting date does not email about the past
  assert.equal(harvestMilestone({ plantDate: at("2026-07-01"), growDuration: 60, harvestDuration: 7, now: noonIst(10) }).send, null);
});

test("a one-day window, and a missing duration, still work", () => {
  assert.equal(m(11, {}, { harvestDuration: 1 }).send, "harvestDay");
  assert.equal(m(12, {}, { harvestDuration: 1 }).send, null); // 12 Oct is past a 1-day window
  assert.equal(m(11, {}, { harvestDuration: undefined }).send, "harvestDay");
});

test("the day boundary is IST: at 00:30 IST on harvest day it is already harvest day", () => {
  const r = harvestMilestone({ ...crop, now: at("2026-10-10T19:00:00Z") }); // 00:30 IST on 11 Oct
  assert.equal(r.daysUntilHarvest, 0);
  assert.equal(r.send, "harvestDay");
});

// ---------- the harvest job, end to end with fakes ----------

const query = (docs) => ({ populate: () => query(docs), select: () => query(docs), lean: () => Promise.resolve(docs) });
function fakeCrops(list) {
  const updates = [];
  return {
    updates,
    UserCrop: { find: () => query(list), updateOne: async (filter, change) => { updates.push({ filter, set: change.$set }); } },
  };
}
const userCrop = (id, user, extra = {}) => ({ _id: id, name: "Wheat", type: "grain", plantDate: at("2026-10-01"), growDuration: 10, harvestDuration: 5, notificationsSent: {}, userId: user, ...extra });
const farmer = (extra = {}) => ({ email: "f@example.com", name: "Asha", ...extra });

test("the job sends one reminder, then records exactly what was sent", async () => {
  const { UserCrop, updates } = fakeCrops([userCrop("c1", farmer())]);
  const mails = [];
  const summary = await checkCropDeadlines({ UserCrop, now: noonIst(11), sendMail: async (o) => { mails.push(o); } });
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Harvest Day/);
  assert.deepEqual(summary, { crops: 1, sent: 1, caughtUp: 0, closed: 0, failed: 0 });
  assert.deepEqual(updates[0].set, { "notificationsSent.harvestDay": true, "notificationsSent.oneDay": true, "notificationsSent.threeDay": true });
});

test("a reminder whose email FAILED is not marked sent, so the next run retries it", async () => {
  const { UserCrop, updates } = fakeCrops([userCrop("c1", farmer())]);
  const summary = await checkCropDeadlines({ UserCrop, now: noonIst(11), sendMail: async () => { throw new Error("SMTP down"); } });
  assert.equal(summary.failed, 1);
  assert.equal(summary.sent, 0);
  assert.equal(updates.length, 0); // the old code set the flag anyway and the reminder was lost
});

test("opted-out users, users with no preferences saved, and orphaned crops", async () => {
  const { UserCrop } = fakeCrops([
    userCrop("a", farmer({ email: "off@example.com", notificationPreferences: { emailNotifications: false, deadlineReminders: true } })),
    userCrop("b", farmer({ email: "noreminders@example.com", notificationPreferences: { emailNotifications: true, deadlineReminders: false } })),
    userCrop("c", farmer({ email: "unset@example.com" })), // never saved preferences: must still be reminded
    userCrop("d", null), // the user was deleted
  ]);
  const to = [];
  await checkCropDeadlines({ UserCrop, now: noonIst(11), sendMail: async (o) => { to.push(o.to); } });
  assert.deepEqual(to, ["unset@example.com"]);
});

test("a crop that needs no email today is left alone (no write per crop per day)", async () => {
  const { UserCrop, updates } = fakeCrops([userCrop("c1", farmer(), { plantDate: at("2026-10-05") })]); // harvest 15 Oct, far off
  const mails = [];
  await checkCropDeadlines({ UserCrop, now: noonIst(8), sendMail: async (o) => { mails.push(o); } });
  assert.equal(mails.length, 0);
  assert.equal(updates.length, 0);
});

test("farmer-typed text in the email is escaped", async () => {
  const { UserCrop } = fakeCrops([userCrop("c1", farmer({ name: "<b>Asha</b>" }), { name: "<script>alert(1)</script>" })]);
  const mails = [];
  await checkCropDeadlines({ UserCrop, now: noonIst(11), sendMail: async (o) => { mails.push(o); } });
  assert.ok(!mails[0].html.includes("<script>") && !mails[0].html.includes("<b>Asha"));
  assert.ok(mails[0].html.includes("&lt;script&gt;"));
});

test("the email states the harvest window, using harvestDuration", async () => {
  const { UserCrop } = fakeCrops([userCrop("c1", farmer())]);
  const mails = [];
  await checkCropDeadlines({ UserCrop, now: noonIst(11), sendMail: async (o) => { mails.push(o); } });
  assert.match(mails[0].html, /Harvest Window/);
  assert.match(mails[0].html, /11 October 2026/);
  assert.match(mails[0].html, /15 October 2026/);
});

// ---------- weather: the forecast, not just now ----------

const calm = { main: { temp: 28 }, wind: { speed: 3 }, weather: [{ main: "Clear" }] };
const slot = (hoursAhead, extra, now = noonIst(10)) => ({ dt: now.getTime() / 1000 + hoursAhead * 3600, main: { temp: 28 }, wind: { speed: 3 }, weather: [{ main: "Clear" }], ...extra });
const types = (alerts) => alerts.map((a) => a.type);

test("nothing happening means no alerts", () => {
  assert.deepEqual(detectWeatherAlerts(calm, { list: [slot(3), slot(6)] }, noonIst(10)), []);
});

test("rain coming later today is caught, which a current-conditions-only check could not", () => {
  const alerts = detectWeatherAlerts(calm, { list: [slot(3), slot(9, { rain: { "3h": 20 } })] }, noonIst(10));
  assert.deepEqual(types(alerts), ["heavy_rain"]);
  assert.equal(alerts[0].when, "soon");
  assert.match(alerts[0].message, /next 24 hours/);
});

test("the forecast window is 24 hours: a storm in 30 hours is not an alert today", () => {
  assert.deepEqual(detectWeatherAlerts(calm, { list: [slot(30, { rain: { "3h": 40 } })] }, noonIst(10)), []);
  assert.deepEqual(types(detectWeatherAlerts(calm, { list: [slot(24, { rain: { "3h": 40 } })] }, noonIst(10))), ["heavy_rain"]);
});

test("thresholds are exact: at the line is not over it (as before)", () => {
  const T = THRESHOLDS;
  const f = (s) => types(detectWeatherAlerts(calm, { list: [s] }, noonIst(10)));
  assert.deepEqual(f(slot(3, { rain: { "3h": T.rainMmPerHour * 3 - 0.1 } })), []);
  assert.deepEqual(f(slot(3, { rain: { "3h": T.rainMmPerHour * 3 } })), ["heavy_rain"]);
  assert.deepEqual(f(slot(3, { main: { temp: T.frostBelowC } })), []); // 3C is not below 3C
  assert.deepEqual(f(slot(3, { main: { temp: T.frostBelowC - 0.1 } })), ["frost"]);
  assert.deepEqual(f(slot(3, { wind: { speed: T.windAboveMs } })), []);
  assert.deepEqual(f(slot(3, { wind: { speed: T.windAboveMs + 0.1 } })), ["strong_wind"]);
  assert.deepEqual(f(slot(3, { main: { temp: T.heatAboveC } })), []);
  assert.deepEqual(f(slot(3, { main: { temp: T.heatAboveC + 0.1 } })), ["extreme_heat"]);
});

test("current conditions still raise alerts, and 'now' wins over 'soon' for the same kind", () => {
  const raining = { ...calm, rain: { "1h": 6 } };
  const alerts = detectWeatherAlerts(raining, { list: [slot(3, { rain: { "3h": 30 } })] }, noonIst(10));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].when, "now");
  assert.deepEqual(types(detectWeatherAlerts({ ...calm, main: { temp: 1 } }, { list: [] }, noonIst(10))), ["frost"]);
  assert.deepEqual(types(detectWeatherAlerts({ ...calm, weather: [{ main: "Snow" }] }, { list: [] }, noonIst(10))), ["frost"]);
});

test("several alerts come back in a fixed order", () => {
  const stormy = { ...calm, wind: { speed: 20 }, main: { temp: 45 }, rain: { "1h": 9 } };
  assert.deepEqual(types(detectWeatherAlerts(stormy, { list: [] }, noonIst(10))), ["heavy_rain", "strong_wind", "extreme_heat"]);
});

test("missing or odd weather data never throws", () => {
  assert.deepEqual(detectWeatherAlerts(undefined, undefined), []);
  assert.deepEqual(detectWeatherAlerts({}, { list: [{}] }, noonIst(10)), []);
});

// ---------- one alert per type per day ----------

test("cooldown is by IST day: an alert at 23:30 does not block the one at 00:30, but 08:00 blocks 22:00", () => {
  assert.equal(alreadySentToday(at("2026-10-10T18:00:00Z"), at("2026-10-10T19:00:00Z")), false); // 23:30 -> 00:30 IST, new day
  assert.equal(alreadySentToday(at("2026-10-10T02:30:00Z"), at("2026-10-10T16:30:00Z")), true); // 08:00 -> 22:00 IST, same day
  assert.equal(alreadySentToday(undefined, noonIst(10)), false);
});

test("only the types not yet sent today are kept", () => {
  const alerts = [{ type: "heavy_rain" }, { type: "frost" }];
  const kept = newAlertsOnly(alerts, { heavy_rain: noonIst(10) }, noonIst(10));
  assert.deepEqual(kept.map((a) => a.type), ["frost"]);
  assert.equal(newAlertsOnly(alerts, { heavy_rain: noonIst(9) }, noonIst(10)).length, 2); // yesterday's does not count
});

// ---------- the weather job, end to end with fakes ----------

function fakeUsers(docs) {
  const updates = [];
  return {
    updates,
    User: {
      find: () => query(docs),
      updateOne: async (filter, change) => {
        updates.push(change.$set);
        const doc = docs.find((d) => d._id === filter._id);
        for (const [path, value] of Object.entries(change.$set)) { const [, type] = path.split("."); doc.weatherAlertsSent = { ...(doc.weatherAlertsSent ?? {}), [type]: value }; }
      },
    },
  };
}
const person = (id, extra = {}) => ({ _id: id, email: `${id}@example.com`, name: id, location: "Pune", ...extra });
const rainyWeather = { current: { ...calm, name: "Pune" }, forecast: { list: [slot(6, { rain: { "3h": 30 } })] } };

test("the weather job emails alerts, respects opt-out, and looks each city up once", async () => {
  const { User } = fakeUsers([person("a"), person("b", { notificationPreferences: { emailNotifications: false } }), person("c"), person("d", { location: "pune " })]);
  const mails = [];
  let lookups = 0;
  const summary = await runWeatherAlertJob({ User, now: noonIst(10), fetchWeather: async () => { lookups += 1; return rainyWeather; }, sendMail: async (o) => { mails.push(o.to); } });
  assert.deepEqual(mails.sort(), ["a@example.com", "c@example.com", "d@example.com"]);
  assert.equal(summary.optedOut, 1);
  assert.equal(lookups, 1); // "Pune" and "pune " are one city
  assert.equal(summary.cities, 1);
});

test("the same alert is not sent again the same day, but a new kind is", async () => {
  const { User } = fakeUsers([person("a")]);
  const mails = [];
  // forecasts are built relative to each run's clock, as a real one would be
  const rainyAt = (now, current = {}) => ({ current: { ...calm, name: "Pune", ...current }, forecast: { list: [slot(6, { rain: { "3h": 30 } }, now)] } });
  const run = (now, current) => runWeatherAlertJob({ User, now, fetchWeather: async () => rainyAt(now, current), sendMail: async (o) => { mails.push(o); } });

  await run(noonIst(10));
  await run(at("2026-10-10T10:30:00Z")); // 16:00 IST, same day
  assert.equal(mails.length, 1); // the old job would have sent one per run

  await run(at("2026-10-10T11:30:00Z"), { main: { temp: 1 } }); // rain (already sent today) + frost (new)
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /frost/);
  assert.ok(!/heavy rain/.test(mails[1].subject)); // only the new kind

  await run(noonIst(11)); // next IST day: rain is alerted again
  assert.equal(mails.length, 3);
  assert.match(mails[2].subject, /heavy rain/);
});

test("a failed email is not recorded, so the next run tries again", async () => {
  const { User, updates } = fakeUsers([person("a")]);
  let fail = true;
  const options = { User, now: noonIst(10), fetchWeather: async () => rainyWeather, sendMail: async () => { if (fail) throw new Error("SMTP down"); } };
  const first = await runWeatherAlertJob(options);
  assert.equal(first.failed, 1);
  assert.equal(updates.length, 0);
  fail = false;
  assert.equal((await runWeatherAlertJob(options)).emailed, 1);
});

test("a city the weather service cannot find is counted, not crashed on", async () => {
  const { User } = fakeUsers([person("a", { location: "Nowhereville" })]);
  const summary = await runWeatherAlertJob({ User, now: noonIst(10), fetchWeather: async () => { throw new Error("city not found"); }, sendMail: async () => { throw new Error("must not send"); } });
  assert.equal(summary.failed, 1);
  assert.equal(summary.emailed, 0);
});

test("with no weather key and no injected lookup, the job skips cleanly", async () => {
  const saved = process.env.OPENWEATHER_API_KEY;
  delete process.env.OPENWEATHER_API_KEY;
  try {
    const { User } = fakeUsers([person("a")]);
    assert.equal((await runWeatherAlertJob({ User })).skipped, "no OpenWeather key");
  } finally {
    if (saved !== undefined) process.env.OPENWEATHER_API_KEY = saved;
  }
});

// ---------- the city is encoded, not pasted into the URL ----------

test("the city goes to the weather service as an encoded parameter, never pasted into the URL", async (t) => {
  t.after(() => mock.restoreAll());
  process.env.OPENWEATHER_API_KEY ??= "test-key";
  const calls = [];
  mock.method(axios, "get", async (url, options) => { calls.push({ url, params: options.params }); return { status: 200, data: { coord: { lat: 1, lon: 2 } } }; });
  await fetchCurrentWeather("Navi Mumbai & Raigad");
  assert.equal(calls[0].url.includes("?"), false);
  assert.equal(calls[0].url.includes("Navi"), false);
  assert.equal(calls[0].params.q, "Navi Mumbai & Raigad,IN"); // axios encodes this when it builds the request
});
