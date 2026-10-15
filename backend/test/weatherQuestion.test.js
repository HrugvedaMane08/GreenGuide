import test from "node:test";
import assert from "node:assert/strict";

import {
  isWeatherQuestion,
  summarizeWeather,
  buildWeatherAnswerEnglish,
  answerWeatherQuestion,
  NO_DISTRICT_MESSAGE,
} from "../features/loanAssistant/services/weatherQuestion.js";

// ---------- intent detection ----------

test("weather questions are detected", () => {
  for (const q of [
    "Will it rain tomorrow?",
    "What is the weather today?",
    "weather forecast for this week",
    "What is the temperature now?",
    "Is a storm coming?",
    "How is the humidity?",
  ]) {
    assert.equal(isWeatherQuestion(q), true, q);
  }
});

test("scheme questions that mention rain keep the scheme flow", () => {
  for (const q of [
    "Which insurance covers crop loss from heavy rain?",
    "Can I get compensation for hailstorm damage?",
    "How do I apply for a loan after the storm?",
  ]) {
    assert.equal(isWeatherQuestion(q), false, q);
  }
});

test("non-weather questions are not weather", () => {
  for (const q of ["Am I eligible for PM-KISAN?", "What documents do I need?", ""]) {
    assert.equal(isWeatherQuestion(q), false, q);
  }
});

// ---------- summarising ----------

// 2026-10-10 06:00 UTC; Pune is UTC+5:30 (19800 s), so local date is still the 10th.
const NOW = Date.UTC(2026, 9, 10, 6, 0, 0) / 1000;
const TZ = 19800;
const at = (hoursFromNow, temp, extra = {}) => ({ dt: NOW + hoursFromNow * 3600, main: { temp }, ...extra });

const current = {
  dt: NOW,
  timezone: TZ,
  name: "Pune",
  main: { temp: 33.4, feels_like: 32.1, humidity: 29 },
  wind: { speed: 3.2 },
  weather: [{ description: "clear sky" }],
};

const dryForecast = {
  city: { timezone: TZ },
  list: [at(0, 30), at(3, 34), at(24, 28), at(27, 36), at(48, 27), at(51, 37)],
};

test("days are labelled today / tomorrow / weekday and hold min/max", () => {
  const s = summarizeWeather(current, dryForecast);
  assert.equal(s.days.length, 3);
  assert.deepEqual(s.days.map((d) => d.label), ["today", "tomorrow", "Monday"]); // 12 Oct 2026 is a Monday
  assert.equal(s.days[0].tmin, 30);
  assert.equal(s.days[0].tmax, 34);
});

test("grouping uses the location's date, not UTC", () => {
  // 20:00 UTC on the 10th is 01:30 on the 11th in Pune.
  const s = summarizeWeather(current, { city: { timezone: TZ }, list: [at(0, 30), at(14, 25)] });
  assert.equal(s.days.length, 2);
  assert.equal(s.days[1].date, "2026-10-11");
});

test("rain mm is summed per day and heavy rain adds a farming caution", () => {
  const wet = {
    city: { timezone: TZ },
    list: [at(24, 26, { rain: { "3h": 9 }, pop: 1 }), at(27, 25, { rain: { "3h": 8 }, pop: 1 }), at(0, 30)],
  };
  const s = summarizeWeather(current, wet);
  assert.equal(s.days[1].rainMm, 17);
  const text = buildWeatherAnswerEnglish(s, "Will it rain tomorrow?");
  assert.match(text, /tomorrow \(about 17 mm\)/);
  assert.match(text, /avoid spraying/i);
});

test("a dry forecast says no significant rain", () => {
  const text = buildWeatherAnswerEnglish(summarizeWeather(current, dryForecast), "weather?");
  assert.match(text, /No significant rain is expected in the next 3 days/);
  assert.match(text, /Right now in Pune it is 33°C/);
});

test("rain questions lead with the rain outlook, others with current conditions", () => {
  const s = summarizeWeather(current, dryForecast);
  assert.match(buildWeatherAnswerEnglish(s, "Will it rain?"), /^No significant rain/);
  assert.match(buildWeatherAnswerEnglish(s, "What is the temperature?"), /^Right now in Pune/);
});

test("extreme heat adds an irrigation tip", () => {
  const hot = { city: { timezone: TZ }, list: [at(0, 41), at(24, 42)] };
  assert.match(buildWeatherAnswerEnglish(summarizeWeather(current, hot), "temperature"), /irrigate in the early morning/i);
});

// ---------- missing district (no network involved) ----------

test("no land record or no district asks the farmer to set one", async () => {
  for (const land of [null, undefined, {}, { district: "  " }]) {
    const r = await answerWeatherQuestion({ question: "Will it rain?", land });
    assert.equal(r.answer, NO_DISTRICT_MESSAGE);
    assert.equal(r.source, null);
  }
});

test("a failed land lookup is reported as such, not as a missing district", async () => {
  const r = await answerWeatherQuestion({ question: "Will it rain?", land: null, landLookupFailed: true });
  assert.notEqual(r.answer, NO_DISTRICT_MESSAGE);
  assert.match(r.answer, /try again/i);
});
