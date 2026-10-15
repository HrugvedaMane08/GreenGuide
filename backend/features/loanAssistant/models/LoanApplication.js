import mongoose from "mongoose";

const loanApplicationSchema = new mongoose.Schema(
  {
    farmerId: { type: String, required: true },
    landId: { type: mongoose.Schema.Types.ObjectId, ref: "Land", required: true },

    requestedAmount: { type: Number, required: true },
    purpose: { type: String, required: true },
    annualIncome: { type: Number },
    // No defaults on these: a skipped answer must stay "unknown", not become 0 / true.
    existingLoans: { type: Number },
    creditHistoryOk: { type: Boolean },

    eligibilityScore: { type: Number }, // absent when status is "needs_more_info"
    eligibilityStatus: { type: String }, // eligible | review | not_eligible | needs_more_info
    missingFields: { type: [String], default: [] }, // what to add when status is "needs_more_info"
    // True while the farmer's land has changed and these matches have not been recomputed yet.
    matchedSchemesStale: { type: Boolean, default: false },
    matchedSchemes: { type: [Object], default: [] }
  },
  { timestamps: true }
);

export default mongoose.model("LoanApplication", loanApplicationSchema);
