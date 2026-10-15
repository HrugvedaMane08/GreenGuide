// Reads a quantity written as text, e.g. "50 kg/hectare", "200 grams/hectare (Prevention)",
// "50-60 kg/hectare", "2 kg/tree", "N/A".
//
// The old parser took the first number it saw, so "50-60 kg" became 50. A range now keeps
// both ends and uses the average for totals.

const NOT_A_QUANTITY = /^(n\/?a|na|none|nil|-|—|–)?$/i;

const BASIS = { hectare: "hectare", hectares: "hectare", ha: "hectare", acre: "acre", acres: "acre", tree: "tree", trees: "tree", plant: "plant", plants: "plant" };

/**
 * @returns {null | { min: number, max: number, avg: number, isRange: boolean, basis: "hectare"|"acre"|"tree"|"plant"|null }}
 *   null when there is no usable number ("N/A", empty, text with no digits).
 *   `basis` is what the rate is per, or null if the text does not say.
 */
export function parseQuantity(text) {
  if (text === null || text === undefined) return null;
  const raw = String(text).trim();
  if (NOT_A_QUANTITY.test(raw)) return null;

  // "1,200" -> "1200" (a comma followed by exactly three digits is a thousands separator)
  const s = raw.toLowerCase().replace(/(\d),(?=\d{3}(?!\d))/g, "$1");

  const range = /(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/.exec(s);
  const single = /(\d+(?:\.\d+)?)/.exec(s);

  let min;
  let max;
  if (range) {
    min = Number(range[1]);
    max = Number(range[2]);
    if (min > max) [min, max] = [max, min];
  } else if (single) {
    min = max = Number(single[1]);
  } else {
    return null;
  }

  const per = /\/\s*([a-z]+)|\bper\s+([a-z]+)/.exec(s);
  const basis = per ? BASIS[per[1] ?? per[2]] ?? null : null;

  return { min, max, avg: (min + max) / 2, isRange: min !== max, basis };
}
