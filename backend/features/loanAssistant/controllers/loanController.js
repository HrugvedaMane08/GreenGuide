import LoanApplication from "../models/LoanApplication.js";
import Land from "../models/Land.js";
import { scoreLoanEligibility } from "../services/eligibilityScorer.js";
import { rescoreLoan } from "../services/loanRefresh.js";

export async function createLoanApplication(req, res) {
  try {
    const {
      farmerId, landId, requestedAmount, purpose,
      annualIncome, existingLoans, creditHistoryOk
    } = req.body;

    if (!farmerId || !landId || !requestedAmount || !purpose) {
      return res.status(400).json({ error: "farmerId, landId, requestedAmount, and purpose are required" });
    }

    const land = await Land.findOne({ _id: landId, farmerId, archivedAt: null });
    if (!land) {
      return res.status(404).json({ error: "Land record not found for this farmer" });
    }

    // Anything the farmer skipped stays undefined. The scorer then reports
    // "needs_more_info" and names what is missing, rather than scoring a default.
    const { score, status, missing } = scoreLoanEligibility({
      areaAcres: land.areaAcres,
      annualIncome,
      requestedAmount,
      existingLoans,
      creditHistoryOk
    });

    const loanApp = await LoanApplication.create({
      farmerId, landId, requestedAmount, purpose,
      annualIncome, existingLoans, creditHistoryOk,
      eligibilityScore: score ?? undefined,
      eligibilityStatus: status,
      missingFields: missing.map((m) => m.label)
    });

    res.status(201).json(loanApp);
  } catch (err) {
    console.error("Error creating loan application:", err.message);
    res.status(500).json({ error: "Failed to create loan application" });
  }
}

const ANSWER_FIELDS = ["requestedAmount", "purpose", "annualIncome", "existingLoans", "creditHistoryOk"];

/**
 * Applies answer changes from `body` to `loan` and re-scores it. A field left out is
 * unchanged; null clears it (back to "not provided"). If the purpose changes, the
 * matched schemes are dropped as stale.
 */
function applyAnswerChanges(loan, land, body) {
  let purposeChanged = false;
  for (const field of ANSWER_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (field === "purpose" && value !== loan.purpose) purposeChanged = true;
    loan.set(field, value === null ? undefined : value);
  }
  rescoreLoan(loan, land);
  if (purposeChanged) {
    loan.matchedSchemes = [];
    loan.matchedSchemesStale = false;
  }
}

/**
 * PATCH /api/loans/:loanId
 * Body: farmerId (must own the application) plus any of requestedAmount, purpose,
 * annualIncome, existingLoans, creditHistoryOk.
 *
 * Lets a farmer whose application said "needs more info" add the missing answers
 * without filing a second one; it is re-scored on every change. 
 */
export async function updateLoanApplication(req, res) {
  try {
    const { loanId } = req.params;
    const { farmerId } = req.body;

    const loan = await LoanApplication.findOne({ _id: loanId, farmerId });
    if (!loan) {
      return res.status(404).json({ error: "Loan application not found for this farmer" });
    }
    const land = await Land.findById(loan.landId);
    if (!land) {
      return res.status(404).json({ error: "The land record for this application no longer exists" });
    }

    applyAnswerChanges(loan, land, req.body);
    await loan.save();
    res.json(loan);
  } catch (err) {
    console.error("Error updating loan application:", err.message);
    res.status(500).json({ error: "Failed to update loan application" });
  }
}

export async function listLoanApplicationsForFarmer(req, res) {
  try {
    const { farmerId } = req.params;
    const apps = await LoanApplication.find({ farmerId }).sort({ createdAt: -1 });
    res.json(apps);
  } catch (err) {
    console.error("Error fetching loan applications:", err.message);
    res.status(500).json({ error: "Failed to fetch loan applications" });
  }
}
