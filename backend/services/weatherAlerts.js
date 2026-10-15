// Decides which weather alerts apply to a place, from the CURRENT conditions and the
// FORECAST for the next 24 hours.
//
// Before: the hourly job looked only at the current reading, so it could never warn about
// rain or frost that was still hours away (the point of an alert), and it re-sent the same
// warning every hour for as long as the condition lasted. Detection and "have we already
// told this person today?" are now separate, and both are pure functions.

export const IST = "Asia/Kolkata";
const DAY_MS = 86400000;
const IST_OFFSET_MS = 5.5 * 3600000;

/** The IST calendar day (an integer) that an instant falls on. Alerts and reminders are per IST day. */
export const istDay = (date) => Math.floor((new Date(date).getTime() + IST_OFFSET_MS) / DAY_MS);

export const ALERT_TYPES = ["heavy_rain", "frost", "strong_wind", "extreme_heat"];

// Carried over unchanged from the previous implementation (current-weather rain was
// "5 mm in the last hour"; the forecast reports 3-hour totals, so that is 15 mm per slot).
// TODO(tune): these are this project's own alert thresholds, not official figures.
export const THRESHOLDS = {
  rainMmPerHour: 5,
  frostBelowC: 3,
  windAboveMs: 15,
  heatAboveC: 40,
  lookAheadHours: 24,
};

const SLOT_HOURS = 3;

const timeOfDayIst = (epochSeconds) =>
  new Date(epochSeconds * 1000).toLocaleString("en-IN", { timeZone: IST, hour: "numeric", hour12: true });

const isSnowy = (weatherEntry) => /snow|sleet/i.test(weatherEntry?.main ?? "") || /snow|sleet/i.test(weatherEntry?.description ?? "");

/**
 * @param {object} current   OpenWeather /weather payload
 * @param {object} forecast  OpenWeather /forecast payload (3-hourly)
 * @param {Date}   now
 * @returns {{type: string, when: "now"|"soon", message: string}[]}  in ALERT_TYPES order; empty if nothing applies
 */
export function detectWeatherAlerts(current, forecast, now = new Date()) {
  const nowSec = now.getTime() / 1000;
  const horizon = nowSec + THRESHOLDS.lookAheadHours * 3600;
  const slots = (forecast?.list ?? []).filter((s) => s.dt > nowSec - SLOT_HOURS * 3600 && s.dt <= horizon);

  const alerts = {};
  const raise = (type, when, message) => {
    // "now" beats "soon" for the same type; otherwise keep the first found
    if (!alerts[type] || (when === "now" && alerts[type].when !== "now")) alerts[type] = { type, when, message };
  };

  // ---- right now
  const rainNow = current?.rain?.["1h"] ?? 0;
  if (rainNow >= THRESHOLDS.rainMmPerHour) raise("heavy_rain", "now", `Heavy rain right now (${rainNow} mm in the last hour). Consider delaying field work. 🌧️`);

  const tempNow = current?.main?.temp;
  if (typeof tempNow === "number" && tempNow < THRESHOLDS.frostBelowC) raise("frost", "now", `Frost risk right now: ${tempNow}°C. Protect tender crops. 🥶`);
  if (current?.weather?.some(isSnowy)) raise("frost", "now", "Snow or sleet right now. Protect tender crops. 🥶");

  if ((current?.wind?.speed ?? 0) > THRESHOLDS.windAboveMs) raise("strong_wind", "now", `Strong wind right now: ${current.wind.speed} m/s. Secure trellises and avoid spraying. 🌬️`);
  if (typeof tempNow === "number" && tempNow > THRESHOLDS.heatAboveC) raise("extreme_heat", "now", `Extreme heat right now: ${tempNow}°C. Irrigate early or late in the day. 🔥`);

  // ---- the next 24 hours
  for (const slot of slots) {
    const at = timeOfDayIst(slot.dt);
    const rain = slot.rain?.["3h"] ?? 0;
    if (rain >= THRESHOLDS.rainMmPerHour * SLOT_HOURS) raise("heavy_rain", "soon", `Heavy rain expected in the next 24 hours (about ${Math.round(rain)} mm around ${at}). Consider delaying spraying and field work. 🌧️`);

    if (typeof slot.main?.temp === "number" && slot.main.temp < THRESHOLDS.frostBelowC) raise("frost", "soon", `Frost risk in the next 24 hours (${slot.main.temp}°C around ${at}). Protect tender crops. 🥶`);
    if (slot.weather?.some(isSnowy)) raise("frost", "soon", `Snow or sleet expected around ${at}. Protect tender crops. 🥶`);

    if ((slot.wind?.speed ?? 0) > THRESHOLDS.windAboveMs) raise("strong_wind", "soon", `Strong wind expected in the next 24 hours (${slot.wind.speed} m/s around ${at}). Secure trellises and avoid spraying. 🌬️`);
    if (typeof slot.main?.temp === "number" && slot.main.temp > THRESHOLDS.heatAboveC) raise("extreme_heat", "soon", `Extreme heat expected in the next 24 hours (${slot.main.temp}°C around ${at}). Irrigate early or late in the day. 🔥`);
  }

  return ALERT_TYPES.filter((t) => alerts[t]).map((t) => alerts[t]);
}

/** True if this type of alert has already gone to the person on the same IST day. */
export function alreadySentToday(lastSentAt, now = new Date()) {
  return Boolean(lastSentAt) && istDay(lastSentAt) === istDay(now);
}

/** Drops alerts that were already sent today. `sent` maps alert type -> last sent date. */
export function newAlertsOnly(alerts, sent = {}, now = new Date()) {
  return alerts.filter((a) => !alreadySentToday(sent?.[a.type], now));
}
