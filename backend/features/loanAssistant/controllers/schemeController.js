import LoanApplication from "../models/LoanApplication.js";
import { computeMatchedSchemes, MissingLandError } from "../services/schemeMatching.js";

/**
 * POST /api/loans/:loanId/schemes
 * Retrieves and generates matched government schemes for an existing loan
 * application, and persists them onto LoanApplication.matchedSchemes.
 *
 * Matching uses ALL of the farmer's land records and saved facts (see
 * services/schemeMatching.js). The body may carry { farmerProfile: {...} } to add or
 * override facts for this call only.
 */
export async function matchSchemesForLoan(req, res) {
  try {
    const { loanId } = req.params;

    // owner only: "not found" for anyone else, so an id reveals nothing
    const loanApplication = await LoanApplication.findOne({ _id: loanId, farmerId: req.body.farmerId });
    if (!loanApplication) {
      return res.status(404).json({ error: "Loan application not found" });
    }

    let matchedSchemes;
    try {
      matchedSchemes = await computeMatchedSchemes(loanApplication, { farmer: req.body?.farmerProfile });
    } catch (err) {
      if (err instanceof MissingLandError) {
        return res.status(404).json({ error: "Associated land record not found" });
      }
      throw err;
    }

    loanApplication.matchedSchemes = matchedSchemes;
    loanApplication.matchedSchemesStale = false;
    await loanApplication.save();

    res.json({ matchedSchemes });
  } catch (err) {
    console.error("Error matching schemes:", err.message);
    res.status(500).json({ error: "Failed to match schemes for this loan application" });
  }
}
