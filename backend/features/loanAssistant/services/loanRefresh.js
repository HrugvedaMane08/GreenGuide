// Keeps loan applications in step with the farmer's land.
//
// A loan's score depends on its land's size, and its matched schemes depend on the
// farmer's WHOLE holding (total acres, crops, states). So when land is added or
// edited, applications are brought up to date:
//
//   1. Scores are recomputed immediately (cheap, no network).
//   2. Matched schemes are flagged stale at once, then recomputed in the
//      background, one application at a time. Recomputing calls the language model,
//      so it must not block the request or run in parallel against a free-tier
//      token limit.
//

import LoanApplication from "../models/LoanApplication.js";
import { scoreLoanEligibility } from "./eligibilityScorer.js";
import { computeMatchedSchemes } from "./schemeMatching.js";

/** Recomputes score, status and missing answers for a loan from its land and answers. */
export function rescoreLoan(loan, land) {
  const { score, status, missing } = scoreLoanEligibility({
    areaAcres: land.areaAcres,
    annualIncome: loan.annualIncome,
    requestedAmount: loan.requestedAmount,
    existingLoans: loan.existingLoans,
    creditHistoryOk: loan.creditHistoryOk,
  });
  loan.eligibilityScore = score ?? undefined;
  loan.eligibilityStatus = status;
  loan.missingFields = missing.map((m) => m.label);
}

/** Re-scores every application filed against this land. Returns how many. */
export async function rescoreLoansForLand(land) {
  const loans = await LoanApplication.find({ landId: land._id });
  for (const loan of loans) {
    rescoreLoan(loan, land);
    await loan.save();
  }
  return loans.length;
}

// One refresh at a time per farmer: a second land change that arrives mid-refresh
// queues behind the first, and its run sees the newest data.
const queues = new Map();

async function refreshStaleLoans(farmerId) {
  const stale = await LoanApplication.find({ farmerId, matchedSchemesStale: true });
  for (const loan of stale) {
    try {
      const matchedSchemes = await computeMatchedSchemes(loan);
      // $set only these two fields so a concurrent edit to the application is not overwritten.
      await LoanApplication.updateOne({ _id: loan._id }, { $set: { matchedSchemes, matchedSchemesStale: false } });
    } catch (err) {
      // Left flagged stale, so it is visible that the stored matches are out of date.
      console.error(`Could not refresh matched schemes for loan ${loan._id}: ${err.message}`);
    }
  }
}

/**
 * Flags the farmer's applications that have matched schemes as stale and
 * refreshes them in the background. Returns how many were flagged (the refresh
 * itself is not awaited).
 */
export async function scheduleSchemeRefresh(farmerId) {
  const flagged = await LoanApplication.updateMany(
    { farmerId, "matchedSchemes.0": { $exists: true } },
    { $set: { matchedSchemesStale: true } }
  );
  if (flagged.modifiedCount === 0 && flagged.matchedCount === 0) return 0;

  const run = (queues.get(farmerId) ?? Promise.resolve())
    .then(() => refreshStaleLoans(farmerId))
    .catch((err) => console.error(`Scheme refresh for ${farmerId} failed: ${err.message}`));
  queues.set(farmerId, run);
  run.finally(() => { if (queues.get(farmerId) === run) queues.delete(farmerId); });

  return flagged.matchedCount;
}

/** Resolves when any scheme refresh queued for this farmer has finished (used by tests). */
export function schemeRefreshIdle(farmerId) {
  return queues.get(farmerId) ?? Promise.resolve();
}
