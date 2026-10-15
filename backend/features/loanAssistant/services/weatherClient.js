// OpenWeatherMap access for the Q&A pipeline.
//
// server.js exposes /api/weather/* as an HTTP proxy for the browser. The Q&A
// controller runs inside that same server, so calling its own HTTP route would
// be a pointless round trip; this is the same upstream call, made directly.
//
// Query values go through axios `params`, which URL-encodes them, so a place
// like "Navi Mumbai" or "Chhatrapati Sambhajinagar" is sent correctly.

import axios from "axios";

const BASE_URL = "https://api.openweathermap.org/data/2.5";

export class WeatherError extends Error {
  // code: NO_KEY | NOT_FOUND | NETWORK | UPSTREAM
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function get(endpoint, params) {
  const appid = process.env.OPENWEATHER_API_KEY;
  if (!appid) throw new WeatherError("NO_KEY", "OPENWEATHER_API_KEY is not set");

  let res;
  try {
    res = await axios.get(`${BASE_URL}/${endpoint}`, {
      params: { ...params, appid, units: "metric" },
      timeout: 10000,
      validateStatus: () => true,
    });
  } catch (err) {
    throw new WeatherError("NETWORK", err.message);
  }

  if (res.status === 404) throw new WeatherError("NOT_FOUND", `No weather location matches ${JSON.stringify(params)}`);
  if (res.status !== 200) throw new WeatherError("UPSTREAM", `OpenWeather ${res.status}: ${res.data?.message || "unknown error"}`);
  return res.data;
}

/** Current conditions for a place name in India, e.g. "Pune". */
export function fetchCurrentWeather(place) {
  return get("weather", { q: `${place},IN` });
}

/** 5-day / 3-hourly forecast for coordinates (taken from the current-weather result). */
export function fetchForecast(lat, lon) {
  return get("forecast", { lat, lon });
}
