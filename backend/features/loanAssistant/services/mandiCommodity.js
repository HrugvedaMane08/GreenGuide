// Turns whatever a farmer typed as their crop into the commodity names to ask the
// market-price feed for, best guess first.
//
// The feed filters on an exact commodity string, and farmers type "Brinjal (Eggplant)",
// "cotton ", "COTTON" or "baingan". Sending those as typed found nothing; it matched
// only a name that happened to be spelled exactly as the feed spells it.

import { resolveCrop, cropMarketNames } from "../../../shared/crops.js";

const titleCase = (text) =>
  text.replace(/\w[\w']*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());

const tidy = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * Candidate commodity names, most likely first, without duplicates (ignoring case):
 *   1. the feed's own name for the crop, when we know it (e.g. rice -> "Paddy(Dhan)(Common)")
 *   2. the canonical crop name, Title-Cased
 *   3. what the farmer typed with any brackets removed, and the bracketed alias
 * so a crop that is not in our list at all is still looked up under the name it was given.
 * Returns [] when nothing usable was typed.
 */
export function commodityCandidates(primaryCrop) {
  const typed = tidy(primaryCrop);
  if (!typed) return [];

  const names = [];
  const crop = resolveCrop(typed);
  if (crop) names.push(...cropMarketNames(crop.key), titleCase(crop.key));

  const withoutBrackets = tidy(typed.replace(/\([^)]*\)/g, " "));
  const bracketed = tidy(typed.match(/\(([^)]+)\)/)?.[1]);
  if (withoutBrackets) names.push(titleCase(withoutBrackets));
  if (bracketed) names.push(titleCase(bracketed));

  const seen = new Set();
  return names.filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}
