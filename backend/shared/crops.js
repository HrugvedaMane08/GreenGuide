// The one place that knows what a crop is called and what is known about it.
//
// Irrigation, scheme eligibility, mandi prices, the crop plan and the calendar used to
// each keep their own idea of a crop: a 71-entry duration table, a 17-entry irrigation
// table matched with name.includes(key) (so "licorice" matched "rice"), and exact
// strings for prices. They now all resolve a typed name here, against shared/crops.json.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const { crops: CROPS } = JSON.parse(readFileSync(path.join(dir, "crops.json"), "utf-8"));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tidy = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// name or alias -> canonical key
const NAME_TO_KEY = new Map();
for (const [key, crop] of Object.entries(CROPS)) {
  NAME_TO_KEY.set(key, key);
  for (const alias of crop.aliases ?? []) NAME_TO_KEY.set(alias, key);
}

// Longest names first, so "green gram" is tried before "gram" and "pearl millet" before "millet".
const NAMES_LONGEST_FIRST = [...NAME_TO_KEY.keys()].sort((a, b) => b.length - a.length);
const NAME_PATTERNS = NAMES_LONGEST_FIRST.map((name) => [name, new RegExp(`(?<![a-z])${escapeRegex(name)}(?![a-z])`)]);

const view = (key, matchedAs) => ({ key, matchedAs, ...CROPS[key] });

/**
 * Resolves what a farmer typed ("Brinjal (Eggplant)", "SUGARCANE", "cotton ", "baingan",
 * "hybrid maize") to a crop, or null.
 *
 * 1. the whole text, the text before any brackets, and the bracketed alias are each tried
 *    as an exact name or alias;
 * 2. failing that, a known name appearing as a whole word ("bt cotton"), longest name
 *    first. Never a substring, so "licorice" is not "rice".
 *
 * Returns { key, matchedAs, duration, category, aliases?, irrigation?, mandiNames? }.
 */
export function resolveCrop(input) {
  const text = tidy(input);
  if (!text) return null;

  const withoutBrackets = tidy(text.replace(/\([^)]*\)/g, " "));
  const bracketed = tidy(text.match(/\(([^)]+)\)/)?.[1]);

  for (const candidate of [text, withoutBrackets, bracketed]) {
    if (candidate && NAME_TO_KEY.has(candidate)) return view(NAME_TO_KEY.get(candidate), candidate);
  }
  for (const [name, pattern] of NAME_PATTERNS) {
    if (pattern.test(text)) return view(NAME_TO_KEY.get(name), name);
  }
  return null;
}

/** A crop by its canonical key. */
export const getCrop = (key) => (CROPS[key] ? view(key, key) : null);

/** The market-price feed's names for a crop (before the plain name). */
export const cropMarketNames = (key) => CROPS[key]?.mandiNames ?? [];

/** Irrigation data for a crop, or null if we have none (callers use a generic default). */
export const irrigationProfile = (key) => CROPS[key]?.irrigation ?? null;

const titleCase = (s) => s.replace(/[a-z][a-z']*/g, (w) => w[0].toUpperCase() + w.slice(1));

/**
 * Every crop, for pickers: { key, name, aliases, duration, category, typicalGrowDays }.
 * `typicalGrowDays` is the irrigation model's crop-cycle estimate (null where we have none);
 * it is an approximation to pre-fill a form, which the farmer should correct.
 */
export function listCrops() {
  return Object.entries(CROPS)
    .map(([key, crop]) => ({
      key,
      name: titleCase(key),
      aliases: crop.aliases ?? [],
      duration: crop.duration,
      category: crop.category,
      typicalGrowDays: crop.irrigation?.totalDays ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
