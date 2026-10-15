// Matches schemes to a loan application. Shared by the on-demand endpoint
// (POST /api/loans/:loanId/schemes) and by the background refresh that runs when a
// farmer's land changes, so both always compute it the same way.

import Land from "../models/Land.js";
import { retrieveSchemes, buildProfileQueryText } from "./schemeRetrieval.js";
import { generateSchemeExplanations } from "./groqGeneration.js";
import { loadFarmerContext, summarizeLands } from "./farmerContext.js";

export class MissingLandError extends Error {
  constructor() {
    super("Associated land record not found");
    this.name = "MissingLandError";
  }
}

/**
 * Retrieves and explains the schemes for a loan application, using ALL of the
 * farmer's land records (the loan's own land is always included) and their saved
 * facts. `farmer` adds or overrides facts for this call only.
 * Returns [] when nothing in the corpus matches.
 */
export async function computeMatchedSchemes(loanApplication, { farmer } = {}) {
  const context = await loadFarmerContext(loanApplication.farmerId);
  const sameId = (a, b) => String(a) === String(b);

  const land =
    context.lands.find((l) => sameId(l._id, loanApplication.landId)) ?? (await Land.findById(loanApplication.landId).lean());
  if (!land) throw new MissingLandError();

  const lands = context.lands.some((l) => sameId(l._id, land._id)) ? context.lands : [land, ...context.lands];

  const profileQueryText = buildProfileQueryText({ land, lands, loanApplication });
  const retrievedSchemes = retrieveSchemes(profileQueryText, 3, { states: summarizeLands(lands).states });
  if (retrievedSchemes.length === 0) return [];

  // A fact supplied in this request that differs from the saved one is no longer what an
  // admin verified, so it loses its verification for this call.
  const overridden = Object.keys(farmer ?? {}).filter((f) => farmer[f] !== context.facts[f]);
  const verifiedFields = context.verifiedFields.filter((f) => !overridden.includes(f));

  return generateSchemeExplanations(
    { land, lands, loanApplication, farmer: { ...context.facts, ...farmer }, verifiedFields },
    retrievedSchemes
  );
}
