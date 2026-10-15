// Turns the crop-plan recommendation rows into a priced plan for a farmer's land.
//
// What changed from the inline version in server.js:
//  - Land area comes in ACRES (like land records); the data's per-hectare rates are
//    converted at this edge, never the other way round.
//  - Costs are returned in INR. The data holds USD estimates, so one configurable rate
//    converts them (USD_TO_INR), instead of a number hardcoded in a web page.
//  - "50-60 kg" is a range (average used for totals, both ends reported), not 50.
//  - Per-tree and per-plant rates are NOT multiplied by land area (that is meaningless):
//    they are shown as rates and left out of the total.
//  - A crop typed as "paddy" finds the plan stored under "Rice" (shared crop names).

import { parseQuantity } from "../shared/quantity.js";
import { acresToHectares, ACRES_PER_HECTARE } from "../shared/units.js";
import { resolveCrop } from "../shared/crops.js";

// TODO(verify): this is the rate the crop-selection page used to hardcode (83.5). It is not
// a current market rate. Set USD_TO_INR in .env to today's rate; the response states the
// rate used so nobody mistakes the figures for exact.
export const DEFAULT_USD_TO_INR = 83.5;

export function usdToInrRate(env = process.env) {
  const configured = Number(env.USD_TO_INR);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_USD_TO_INR;
}

const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
const fixed = (n) => Number(n).toFixed(2);

/** True if a stored plan row is for the crop the farmer asked about ("Rice" row, "paddy" request). */
export function isSameCrop(storedName, requestedName) {
  const a = resolveCrop(storedName);
  const b = resolveCrop(requestedName);
  if (a && b) return a.key === b.key;
  return String(storedName ?? "").trim().toLowerCase() === String(requestedName ?? "").trim().toLowerCase();
}

/** Prices one recommendation row. Returns { item, costUsd }; costUsd is unrounded so totals do not drift. */
function priceRow(rec, { acres, hectares, rate }) {
  const unit = rec.unit_of_measure;
  const qty = parseQuantity(rec.fertilizer_quantity || rec.application_rate);
  const priceUsd = Number(rec.estimated_unit_price_usd) || 0;

  const item = { unit, includedInTotal: false, totalQuantityNeeded: null, estimatedCost: null, estimatedCostINR: null };

  if (!qty) {
    return { item: { ...item, note: "No quantity is given for this input." }, costUsd: 0 };
  }

  // Every row in the data states what its rate is per; one that does not is read as per hectare, as before.
  const basis = qty.basis ?? "hectare";

  if (basis === "tree" || basis === "plant") {
    const perPlantInr = qty.avg * priceUsd * rate;
    return {
      item: {
        ...item,
        note: `This rate is per ${basis} (about ₹${money(perPlantInr)} each). Multiply by your number of ${basis}s; it is not included in the total.`,
        costPerPlantINR: money(perPlantInr),
      },
      costUsd: 0,
    };
  }

  const area = basis === "acre" ? acres : hectares;
  const total = qty.avg * area;
  const costUsd = total * priceUsd;

  return {
    item: {
      ...item,
      includedInTotal: true,
      totalQuantityNeeded: fixed(total),
      ...(qty.isRange ? { quantityRange: { min: fixed(qty.min * area), max: fixed(qty.max * area) } } : {}),
      // the data is per hectare; the farmer's land is in acres
      quantityPerAcre: basis === "hectare" ? `${fixed(qty.min / ACRES_PER_HECTARE)}${qty.isRange ? `–${fixed(qty.max / ACRES_PER_HECTARE)}` : ""} ${unit}/acre` : null,
      estimatedCost: money(costUsd),
      estimatedCostINR: money(costUsd * rate),
    },
    costUsd,
  };
}

/**
 * @param {object[]} rows  recommendation rows already filtered to the crop, soil and method
 * @param {{acres:number, rate?:number}} options
 */
export function buildCropPlan(rows, { acres, rate = usdToInrRate() }) {
  const hectares = acresToHectares(acres);
  const ctx = { acres, hectares, rate };

  const fertilizer = [];
  const pestsAndDiseases = [];
  let totalUsd = 0;
  let notIncluded = 0;

  for (const rec of rows) {
    if (!rec.fertilizer_type && !rec.pest_name) continue;
    const { item: priced, costUsd } = priceRow(rec, ctx);

    // Sum the unrounded amounts and round once at the end: summing figures already rounded to
    // cents (then converting) drifts by a few paise per line.
    if (priced.includedInTotal) totalUsd += costUsd;
    else notIncluded += 1;

    if (rec.fertilizer_type) {
      fertilizer.push({ stage: rec.growth_stage, type: rec.fertilizer_type, quantityPerHa: rec.fertilizer_quantity, ...priced });
    } else {
      pestsAndDiseases.push({ pest: rec.pest_name, type: rec.management_type, input: rec.input_recommendation, ratePerHa: rec.application_rate, ...priced });
    }
  }

  return {
    fertilizer,
    pestsAndDiseases,
    landAcres: fixed(acres),
    landHectares: fixed(hectares),
    currency: "INR",
    totalCostINR: money(totalUsd * rate),
    // Kept for older clients; INR above is the figure to show.
    totalCostUSD: money(totalUsd),
    itemsNotInTotal: notIncluded,
    exchangeRate: { usdToInr: rate, configuredWith: "USD_TO_INR" },
    pricesAreEstimates: true,
  };
}
