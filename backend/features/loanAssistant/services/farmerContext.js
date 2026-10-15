// The farmer as a whole: every land record they have registered, plus the facts
// they saved in "About you". Q&A, scheme matching and the eligibility endpoint all
// start from this, instead of each picking one land record on its own (which made
// a farmer with two plots look like they owned only the newest one).
//
// Best-effort by design: if the database is down or the lookup fails, callers get
// an empty context and carry on, so a lookup problem never fails a question.

import Land from "../models/Land.js";
import { findFarmerFactsDetailed } from "../controllers/farmerProfileController.js";

const distinct = (values) => {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (value && !seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      out.push(value);
    }
  }
  return out;
};

const ACRES_PER_HECTARE = 2.47105;

/** Totals and distinct values across a farmer's land records. */
export function summarizeLands(lands = []) {
  const totalAcres = Math.round(lands.reduce((sum, l) => sum + (Number(l?.areaAcres) > 0 ? Number(l.areaAcres) : 0), 0) * 100) / 100;
  return {
    plots: lands.length,
    totalAcres,
    totalHectares: Math.round((totalAcres / ACRES_PER_HECTARE) * 100) / 100,
    states: distinct(lands.map((l) => l.state)),
    districts: distinct(lands.map((l) => l.district)),
    crops: distinct(lands.map((l) => l.primaryCrop)),
    soilTypes: distinct(lands.map((l) => l.soilType)),
    irrigationTypes: distinct(lands.map((l) => l.irrigationType)),
  };
}

/**
 * All of a farmer's current land records, newest first (archived ones are excluded).
 * [] if there are none or the lookup fails; pass { throwOnError: true } to be told
 * about a failure instead, for callers that must not mistake "database down" for
 * "no land".
 */
export async function findFarmerLands(farmerId, { throwOnError = false } = {}) {
  if (!farmerId) return [];
  if (Land.db.readyState !== 1) {
    if (throwOnError) throw new Error("Database is not connected");
    return [];
  }
  try {
    return await Land.find({ farmerId, archivedAt: null }).sort({ createdAt: -1 }).lean();
  } catch (err) {
    if (throwOnError) throw err;
    console.warn(`Could not load land records for ${farmerId}: ${err.message}`);
    return [];
  }
}

/** { lands, facts, verifiedFields, summary } for a farmer. */
export async function loadFarmerContext(farmerId) {
  const [lands, { facts, verifiedFields }] = await Promise.all([findFarmerLands(farmerId), findFarmerFactsDetailed(farmerId)]);
  return { lands, facts, verifiedFields, summary: summarizeLands(lands) };
}
