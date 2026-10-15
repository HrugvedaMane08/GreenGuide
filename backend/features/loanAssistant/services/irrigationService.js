import axios from "axios";
import { resolveCrop, irrigationProfile } from "../../../shared/crops.js";
import { SQUARE_METRES_PER_ACRE } from "../../../shared/units.js";

/**
 * Irrigation / Sowing Advisory Service
 * ------------------------------------
 * Method: FAO-56 single crop coefficient water balance
 *   ET0 (reference evapotranspiration) via the Hargreaves-Samani equation
 *     ET0 = 0.0023 * Ra_mm * (Tmean + 17.8) * sqrt(Tmax - Tmin)
 *   ETc (crop water use) = Kc * ET0
 *   Net irrigation requirement = ETc (over N days) - effective rainfall
 *   Irrigation interval = Readily Available Water (RAW) / ETc
 *
 * Reference: Allen, R.G., Pereira, L.S., Raes, D., Smith, M. (1998).
 * "Crop evapotranspiration - FAO Irrigation and Drainage Paper 56."
 *
 * IMPORTANT — documented assumptions/limitations (mention these in viva):
 *  - Uses temperature-only Hargreaves ET0 (not full Penman-Monteith), because
 *    OpenWeather's free tier does not provide solar radiation/wind/humidity
 *    at the accuracy FAO-56 PM needs. FAO explicitly endorses Hargreaves as
 *    the recommended fallback when that data isn't available.
 *  - Kc (crop coefficient) values are standard FAO-56 Table 12 approximations
 *    for common Indian crops — not field-calibrated for a specific variety/region.
 *  - Growth stage (and therefore Kc) is estimated from a matching UserCrop
 *    entry's plant date, if one exists; otherwise mid-season Kc is assumed
 *    (the safest overestimate, since mid-season water demand is highest).
 *  - Soil available water capacity (AWC) is a typical value per soil-type
 *    keyword, not a lab-tested figure for the farmer's actual plot.
 *  - Effective rainfall is approximated as 75% of forecast rainfall (a
 *    common simplification; real effective rainfall depends on rainfall
 *    intensity, soil infiltration rate, and slope/runoff).
 *  - IMPORTANT LIMITATION: this service does not track when the farmer last
 *    irrigated (no lastIrrigationDate field exists yet), so it cannot know
 *    the plot's actual current soil moisture. The "days between irrigations"
 *    figure assumes the soil starts completely full (at Readily Available
 *    Water) — it is a generic buffer estimate, not a live depletion status.
 *    The recommendation text below is worded to make this limitation clear
 *    rather than implying the two figures represent one unified verdict.
 */

// ---- Crop coefficient (Kc) + crop duration + root depth ----
// The per-crop numbers (Kc [initial, mid-season, end], typical cycle in days, root depth) now
// live in shared/crops.json beside everything else known about a crop. A crop without an
// entry there gets this generic default.
const DEFAULT_CROP = { kc: [0.50, 1.05, 0.70], totalDays: 110, rootDepthM: 0.6 };

// ---- Soil available water capacity (mm per metre of root depth) ----
// Typical ranges from FAO-56 Table 19 / standard soil-texture references
const SOIL_AWC = [
  { keywords: ["black", "regur"], mmPerM: 200 },
  { keywords: ["clay loam"], mmPerM: 180 },
  { keywords: ["clay", "clayey"], mmPerM: 190 },
  { keywords: ["silt"], mmPerM: 190 },
  { keywords: ["alluvial"], mmPerM: 150 },
  { keywords: ["loam", "loamy"], mmPerM: 165 },
  { keywords: ["red"], mmPerM: 110 },
  { keywords: ["laterite"], mmPerM: 90 },
  { keywords: ["sandy loam"], mmPerM: 125 },
  { keywords: ["sandy", "sand"], mmPerM: 75 },
];
const DEFAULT_AWC_MM_PER_M = 150; // generic loam-like fallback

/**
 * Resolves the typed crop through the shared module (exact name or alias, whole words only),
 * so "paddy" gets rice's coefficients and "licorice" no longer matches "rice" the way
 * name.includes(key) did. Crops we have no irrigation data for get the generic default.
 */
export function lookupCrop(primaryCrop) {
  const crop = resolveCrop(primaryCrop);
  const data = crop && irrigationProfile(crop.key);
  return data ? { key: crop.key, ...data } : { key: "unknown", ...DEFAULT_CROP };
}

function lookupSoilAwc(soilType) {
  if (!soilType) return DEFAULT_AWC_MM_PER_M;
  const name = soilType.trim().toLowerCase();
  for (const entry of SOIL_AWC) {
    if (entry.keywords.some((k) => name.includes(k))) return entry.mmPerM;
  }
  return DEFAULT_AWC_MM_PER_M;
}

/**
 * Interpolates Kc based on days-since-planting using a simplified 4-stage
 * FAO-56 curve (initial 15% / development 25% / mid-season 35% / late 25%).
 * If plant date is unknown, returns mid-season Kc (safest overestimate).
 */
function estimateKc(cropInfo, daysSincePlanting) {
  const [kcIni, kcMid, kcEnd] = cropInfo.kc;
  if (daysSincePlanting == null) return { kc: kcMid, stage: "unknown (assumed mid-season)" };

  const total = cropInfo.totalDays;
  const iniEnd = total * 0.15;
  const devEnd = total * 0.40;
  const midEnd = total * 0.75;

  if (daysSincePlanting <= iniEnd) return { kc: kcIni, stage: "initial" };
  if (daysSincePlanting <= devEnd) {
    const frac = (daysSincePlanting - iniEnd) / (devEnd - iniEnd);
    return { kc: kcIni + frac * (kcMid - kcIni), stage: "development" };
  }
  if (daysSincePlanting <= midEnd) return { kc: kcMid, stage: "mid-season" };
  if (daysSincePlanting <= total) {
    const frac = (daysSincePlanting - midEnd) / (total - midEnd);
    return { kc: kcMid + frac * (kcEnd - kcMid), stage: "late season" };
  }
  return { kc: kcEnd, stage: "past typical harvest window" };
}

// ---- FAO-56 Hargreaves ET0 ----
function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / 86400000);
}

function extraterrestrialRadiation(latDeg, doy) {
  const phi = (Math.PI / 180) * latDeg;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
  const delta = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta))));
  const Gsc = 0.0820; // MJ m-2 min-1
  // Ra in MJ/m2/day (FAO-56 Eq. 21)
  return ((24 * 60) / Math.PI) * Gsc * dr *
    (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}

function hargreavesET0({ tmin, tmax, tmean, latDeg, doy }) {
  const Ra = extraterrestrialRadiation(latDeg, doy);
  const RaMm = Ra * 0.408; // equivalent evaporation, mm/day
  const spread = Math.max(tmax - tmin, 0.1); // guard against tiny/negative spread
  return 0.0023 * RaMm * (tmean + 17.8) * Math.sqrt(spread);
}

// ---- Weather forecast fetch + aggregation (OpenWeather 5-day/3-hour) ----
async function fetchForecast(district, state) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) throw new Error("OPENWEATHER_API_KEY is missing in .env");

  const city = `${district},IN`;
  const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;
  const res = await axios.get(url);
  const data = res.data;

  const lat = data.city?.coord?.lat;
  if (lat == null) throw new Error("Could not resolve latitude for this location");

  // Group the 3-hourly entries by calendar date, keep the next 3 full days
  const byDate = {};
  for (const entry of data.list) {
    const date = entry.dt_txt.split(" ")[0];
    if (!byDate[date]) byDate[date] = { temps: [], rain: 0 };
    byDate[date].temps.push(entry.main.temp);
    byDate[date].rain += entry.rain?.["3h"] || 0;
  }

  const dates = Object.keys(byDate).sort().slice(0, 3);
  const days = dates.map((date) => {
    const { temps, rain } = byDate[date];
    return {
      date,
      tmin: Math.min(...temps),
      tmax: Math.max(...temps),
      tmean: temps.reduce((a, b) => a + b, 0) / temps.length,
      rainMm: rain,
    };
  });

  return { lat, days, city: data.city?.name };
}

/**
 * Main entry point: builds an irrigation + sowing advisory for a land record.
 * @param {object} land - Mongoose Land document (needs state, district, soilType, primaryCrop)
 * @param {Date|null} plantDate - optional, from a matching UserCrop record
 */
export async function buildIrrigationAdvisory(land, plantDate = null) {
  const { lat, days, city } = await fetchForecast(land.district, land.state);
  if (days.length === 0) throw new Error("No forecast data available for this location");

  const today = new Date();
  const doy = dayOfYear(today);

  // Average conditions across the next 3 forecast days
  const tmin = days.reduce((a, d) => a + d.tmin, 0) / days.length;
  const tmax = days.reduce((a, d) => a + d.tmax, 0) / days.length;
  const tmean = days.reduce((a, d) => a + d.tmean, 0) / days.length;
  const totalForecastRainMm = days.reduce((a, d) => a + d.rainMm, 0);

  const et0 = hargreavesET0({ tmin, tmax, tmean, latDeg: lat, doy });

  const cropInfo = lookupCrop(land.primaryCrop);
  let daysSincePlanting = null;
  if (plantDate) {
    daysSincePlanting = Math.floor((today - new Date(plantDate)) / 86400000);
  }
  const { kc, stage } = estimateKc(cropInfo, daysSincePlanting);
  const etcPerDay = kc * et0; // mm/day

  const awcMmPerM = lookupSoilAwc(land.soilType);
  const tawMm = awcMmPerM * cropInfo.rootDepthM; // Total Available Water in root zone
  const depletionFraction = 0.5; // FAO-56 typical default (varies 0.3-0.7 by crop)
  const rawMm = depletionFraction * tawMm; // Readily Available Water

  const effectiveRainfallMm = totalForecastRainMm * 0.75; // simplified approximation
  const etcNext3DaysMm = etcPerDay * days.length;
  const netRequirementMm = Math.max(0, etcNext3DaysMm - effectiveRainfallMm);

  const intervalDays = etcPerDay > 0 ? Math.round((rawMm / etcPerDay) * 10) / 10 : null;

  // ---- Irrigation recommendation text ----
  let irrigationRecommendation;
  if (cropInfo.key === "rice") {
    irrigationRecommendation =
      "Rice is typically grown with standing water (2–5 cm) rather than periodic irrigation. " +
      "Maintain standing water levels; the water-balance figures below are informational only.";
  } else if (netRequirementMm <= 1) {
    irrigationRecommendation = `Hold off irrigating — forecast rainfall (~${totalForecastRainMm.toFixed(1)} mm over the next ${days.length} days) is expected to meet crop water demand.`;
  } else {
    const litersPerAcre = Math.round(netRequirementMm * SQUARE_METRES_PER_ACRE); // 1mm over 1 acre ≈ 4046.86 L
    irrigationRecommendation = `Your ${land.primaryCrop || "crop"} is expected to use about ${netRequirementMm.toFixed(1)} mm (~${litersPerAcre.toLocaleString("en-IN")} litres/acre) of water over the next ${days.length} days under forecast conditions. Based on your soil's water-holding capacity, the root zone can typically go about ${intervalDays} day(s) between irrigations before dropping below readily available water. We don't currently track when you last irrigated — if it's been close to ${intervalDays} day(s) since then, irrigate now; if it's been less, you likely still have buffer left.`;
  }

  // ---- Sowing recommendation text (only meaningful pre-planting) ----
  let sowingRecommendation;
  const heavyRainSoon = days[0]?.rainMm > 15;
  if (heavyRainSoon) {
    sowingRecommendation = "Heavy rain is forecast soon — consider delaying sowing by a few days to avoid seed wash-out or waterlogging.";
  } else if (tmean < 10 || tmean > 42) {
    sowingRecommendation = `Average forecast temperature (~${tmean.toFixed(1)}°C) is outside a typical safe germination range for most crops — consider waiting for milder conditions.`;
  } else {
    sowingRecommendation = "Forecast temperature and rainfall conditions look reasonable for sowing, assuming irrigation is available if rainfall falls short.";
  }

  return {
    crop: land.primaryCrop || "not specified",
    cropMatched: cropInfo.key,
    growthStage: stage,
    soilType: land.soilType || "not specified",
    location: { district: land.district, state: land.state, resolvedCity: city, latitude: lat },
    weather: {
      forecastDays: days,
      avgTminC: round1(tmin),
      avgTmaxC: round1(tmax),
      avgTmeanC: round1(tmean),
      totalForecastRainMm: round1(totalForecastRainMm),
      source: "OpenWeather 5-day/3-hour forecast",
    },
    waterBalance: {
      et0MmPerDay: round2(et0),
      kc: round2(kc),
      etcMmPerDay: round2(etcPerDay),
      soilAwcMmPerM: awcMmPerM,
      rootDepthM: cropInfo.rootDepthM,
      totalAvailableWaterMm: round1(tawMm),
      readilyAvailableWaterMm: round1(rawMm),
      effectiveRainfallMm: round1(effectiveRainfallMm),
      netIrrigationRequirementMm: round1(netRequirementMm),
    },
    irrigation: {
      recommendation: irrigationRecommendation,
      suggestedIntervalDays: intervalDays,
    },
    sowing: {
      recommendation: sowingRecommendation,
    },
    method: "FAO-56 Hargreaves ET0 + single crop coefficient (Kc) soil water balance",
    assumptions: [
      "ET0 estimated via the Hargreaves equation (temperature-only) since full weather-station data (solar radiation, wind, humidity) isn't available from the free OpenWeather tier.",
      "Crop coefficient (Kc) values are standard FAO-56 approximations, not calibrated for the specific variety, region, or planting density.",
      `Growth stage is ${plantDate ? "estimated from the matching Crop Calendar entry's plant date" : "assumed as mid-season (no matching Crop Calendar plant date found) — this is the most water-demanding stage, so it's a safe overestimate"}.`,
      "Soil water-holding capacity is a typical value per soil-type keyword, not lab-tested for this specific plot.",
      "Effective rainfall is approximated as 75% of forecast rainfall; actual infiltration depends on rainfall intensity, slope, and soil surface condition.",
      "Last-irrigation date is not currently tracked, so the 'days between irrigations' figure assumes the soil starts at full readily-available water rather than reflecting this plot's actual current moisture.",
    ],
  };
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }