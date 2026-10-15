// Answers weather questions from live OpenWeather data for the farmer's district.
//
// Until now a weather question went through the scheme pipeline: it retrieved
// whichever scheme shared a word with it ("rain" -> crop insurance) and the model
// could only say it could not see a forecast. Here the answer is assembled in code
// from the fetched numbers, so nothing in it can be invented; only the final
// translation into the farmer's language uses the model.
//
// All functions work on the ENGLISH translation of the question.

import { fetchCurrentWeather, fetchForecast, WeatherError } from "./weatherClient.js";

const WEATHER_TERMS = [
  "weather", "rain", "rains", "rainy", "raining", "rainfall", "forecast", "temperature",
  "storm", "thunderstorm", "humidity", "hail", "hailstorm", "cyclone", "wind", "windy",
];

// "Which insurance covers crop loss from heavy rain?" mentions rain but is a
// scheme question; those must keep the scheme flow, so any of these words wins.
const SCHEME_TERMS = [
  "scheme", "schemes", "yojana", "subsidy", "subsidies", "loan", "loans", "credit", "kcc",
  "insurance", "premium", "claim", "compensation", "pmfby", "apply", "application",
  "eligib", "benefit", "benefits", "pension", "bank", "grant", "fund", "document", "documents",
];

const hasWord = (text, term) => new RegExp(`\\b${term}`, "i").test(text);

export function isWeatherQuestion(englishQuestion) {
  const q = String(englishQuestion || "");
  if (SCHEME_TERMS.some((t) => hasWord(q, t))) return false;
  return WEATHER_TERMS.some((t) => hasWord(q, t));
}

export const NO_DISTRICT_MESSAGE =
  "To tell you the weather I need to know where your farm is. Please add a land record with your district " +
  "on the Loan Assistant page, then ask me again.";

const LOOKUP_FAILED_MESSAGE =
  "I couldn't look up your farm's location right now. Please try again in a moment.";

function failureMessage(err, place) {
  if (err instanceof WeatherError && err.code === "NOT_FOUND") {
    return `I couldn't find weather for "${place}". Please check the district spelling on your land record.`;
  }
  return `Sorry, I couldn't get the weather for ${place} right now. Please try again in a moment.`;
}

const round = (n) => Math.round(n);

/**
 * Reduces OpenWeather's current + 3-hourly forecast payloads to the figures the
 * answer needs. Days are grouped by the LOCATION's calendar date (city.timezone),
 * not the server's, so "tomorrow" means tomorrow where the farm is.
 */
export function summarizeWeather(current, forecast) {
  const tz = forecast?.city?.timezone ?? current?.timezone ?? 0;
  const dayKey = (dt) => new Date((dt + tz) * 1000).toISOString().slice(0, 10);
  const todayKey = dayKey(current.dt);

  const byDay = {};
  for (const e of forecast?.list || []) {
    const key = dayKey(e.dt);
    const d = (byDay[key] ||= { temps: [], rainMm: 0, pop: 0 });
    d.temps.push(e.main.temp);
    d.rainMm += e.rain?.["3h"] || 0;
    d.pop = Math.max(d.pop, e.pop || 0);
  }

  const days = Object.keys(byDay)
    .sort()
    .slice(0, 5)
    .map((key, i) => {
      const d = byDay[key];
      const weekday = new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
      return {
        date: key,
        label: key === todayKey ? "today" : i === 1 && key > todayKey ? "tomorrow" : weekday,
        tmin: Math.min(...d.temps),
        tmax: Math.max(...d.temps),
        rainMm: d.rainMm,
        pop: d.pop,
      };
    });

  return {
    place: current.name,
    temp: current.main.temp,
    feelsLike: current.main.feels_like,
    humidity: current.main.humidity,
    windMs: current.wind?.speed ?? 0,
    description: current.weather?.[0]?.description || "unknown conditions",
    days,
  };
}

function currentSentence(s) {
  return (
    `Right now in ${s.place} it is ${round(s.temp)}°C (feels like ${round(s.feelsLike)}°C) with ${s.description}, ` +
    `humidity ${s.humidity}% and wind ${s.windMs.toFixed(1)} m/s.`
  );
}

function rainSentence(s) {
  const wet = s.days.filter((d) => d.rainMm >= 1 || d.pop >= 0.6);
  if (wet.length === 0) return `No significant rain is expected in the next ${s.days.length} days.`;

  const parts = wet.map((d) => (d.rainMm >= 1 ? `${d.label} (about ${round(d.rainMm)} mm)` : `${d.label} (a chance of showers)`));
  let text = `Rain is expected on ${parts.join(", ")}.`;
  if (wet.some((d) => d.rainMm >= 15)) {
    text += " On the heavy-rain days avoid spraying and delay sowing or fertiliser application.";
  }
  return text;
}

function temperatureSentence(s) {
  const maxes = s.days.map((d) => d.tmax);
  const lo = round(Math.min(...maxes));
  const hi = round(Math.max(...maxes));
  let text = lo === hi ? `Daytime highs will be around ${hi}°C.` : `Daytime highs will be between ${lo}°C and ${hi}°C.`;
  if (hi >= 40) text += " In this heat irrigate in the early morning or evening.";
  if (Math.min(...s.days.map((d) => d.tmin)) <= 4) text += " Nights may be cold enough to harm tender crops, so cover them.";
  return text;
}

/**
 * Builds the English answer. Leads with rain when the farmer asked about rain,
 * otherwise with current conditions.
 */
export function buildWeatherAnswerEnglish(summary, englishQuestion = "") {
  const asksRain = /\b(rain|rains|rainy|raining|rainfall|storm|thunderstorm|hail|forecast)/i.test(englishQuestion);
  const current = currentSentence(summary);
  const rain = rainSentence(summary);
  const temp = temperatureSentence(summary);
  return (asksRain ? [rain, current, temp] : [current, rain, temp]).join(" ");
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Which of the farmer's districts to report on.
 *
 * A farmer can have plots in several districts and nothing says which one a bare
 * "Will it rain?" means, so: if the question names one of their districts ("rain in
 * Nashik?") answer just that; otherwise answer for each distinct district, largest
 * holding first, up to MAX_DISTRICTS. `omitted` counts any districts left out.
 */
export const MAX_DISTRICTS = 3;

export function pickDistricts(question, lands = []) {
  const groups = new Map();
  for (const plot of lands) {
    const name = String(plot?.district ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const group = groups.get(key) ?? { name, acres: 0 };
    group.acres += Number(plot.areaAcres) > 0 ? Number(plot.areaAcres) : 0;
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => b.acres - a.acres || a.name.localeCompare(b.name));

  const named = ordered.filter((g) => new RegExp(`(?<!\\w)${escapeRegex(g.name)}(?!\\w)`, "i").test(String(question || "")));
  if (named.length > 0) return { chosen: named.map((g) => g.name), omitted: 0 };

  const chosen = ordered.slice(0, MAX_DISTRICTS).map((g) => g.name);
  return { chosen, omitted: ordered.length - chosen.length, next: ordered[chosen.length]?.name };
}

/**
 * @param {string}  question           English question
 * @param {object[]} lands             all of the farmer's land records (preferred)
 * @param {object|null} land           a single record, if that is all there is
 * @param {boolean} landLookupFailed   true if the land lookup itself errored
 * @returns {Promise<{answer: string, source: string|null}>}  English answer; source is a label for the UI chip
 */
export async function answerWeatherQuestion({ question, lands, land, landLookupFailed = false }) {
  if (landLookupFailed) return { answer: LOOKUP_FAILED_MESSAGE, source: null };

  const plots = lands?.length > 0 ? lands : land ? [land] : [];
  const { chosen, omitted, next } = pickDistricts(question, plots);
  if (chosen.length === 0) return { answer: NO_DISTRICT_MESSAGE, source: null };

  const results = await Promise.all(
    chosen.map(async (district) => {
      try {
        const current = await fetchCurrentWeather(district);
        const forecast = await fetchForecast(current.coord.lat, current.coord.lon);
        const summary = summarizeWeather(current, forecast);
        return { district, summary, text: buildWeatherAnswerEnglish(summary, question) };
      } catch (err) {
        console.error(`Weather answer for "${district}" failed (${err.code || "ERR"}): ${err.message}`);
        return { district, err };
      }
    })
  );

  const ok = results.filter((r) => r.text);
  const failed = results.filter((r) => !r.text);

  if (ok.length === 0) {
    return { answer: failed.length === 1 ? failureMessage(failed[0].err, failed[0].district) : failureMessage(failed[0].err, failed.map((f) => f.district).join(", ")), source: null };
  }

  // One district reads exactly as before; several are labelled so it is clear which is which.
  let answer = chosen.length === 1 ? ok[0].text : ok.map((r) => `${r.district}: ${r.text}`).join("\n\n");
  if (failed.length > 0) answer += `\n\nI couldn't get the weather for ${failed.map((f) => f.district).join(", ")} right now.`;
  if (omitted > 0) answer += `\n\nYou also have land in ${omitted} more ${omitted === 1 ? "place" : "places"}. Ask about one by name, for example "Will it rain in ${next}?".`;

  return { answer, source: `Live weather · ${ok.map((r) => r.summary.place).join(", ")}` };
}
