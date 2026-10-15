import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const weightsPath = path.join(__dirname, "..", "data", "eligibility_weights.json");

const model = JSON.parse(readFileSync(weightsPath, "utf-8"));

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// Everything the model needs. A farmer who skips one of these has not told us
// "zero" or "fine" - we simply do not know - so the application is not scored
// (status "needs_more_info") instead of being filled in with a default. The
// labels are what the farmer is shown.
//
// To let a field be optional again, remove it from this list; the scorer will
// then need its own, explicit assumption for it.
export const REQUIRED_SCORE_INPUTS = [
  { field: "annualIncome", label: "your annual income", kind: "amount" },
  { field: "existingLoans", label: "your existing loans (enter 0 if none)", kind: "amount" },
  { field: "creditHistoryOk", label: "your credit history", kind: "boolean" },
  { field: "requestedAmount", label: "the loan amount", kind: "amount" },
  { field: "areaAcres", label: "your land size", kind: "amount" },
];

// A usable amount is a finite number that is not negative. Zero is a real
// answer (no income, no existing loans) and is accepted.
const isUsableAmount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Which required inputs are absent or unusable. Empty array means we can score.
 */
export function findMissingScoreInputs(input = {}) {
  return REQUIRED_SCORE_INPUTS.filter(({ field, kind }) =>
    kind === "boolean" ? typeof input[field] !== "boolean" : !isUsableAmount(input[field])
  ).map(({ field, label }) => ({ field, label }));
}

/**
 * Scores a loan application using the logistic regression model trained
 * in ml_training/train_eligibility_model.py.
 *
 * Returns { score, status, missing }. When any required input is absent the
 * result is { score: null, status: "needs_more_info", missing: [{ field, label }] }
 * and the model is not run: a guessed value would make the verdict meaningless
 * (a skipped income used to score as income 0, i.e. "not eligible").
 *
 * NOTE: areaAcres is NOT scored directly (v2) — it is only used to derive
 * incomePerAcre. Scoring land size on its own caused a redundant/illogical
 * negative weight, since incomePerAcre already encodes land size.
 */
export function scoreLoanEligibility(input = {}) {
  const missing = findMissingScoreInputs(input);
  if (missing.length > 0) {
    return { score: null, status: "needs_more_info", missing };
  }

  const { areaAcres, annualIncome, requestedAmount, existingLoans } = input;
  const creditHistoryOk = input.creditHistoryOk ? 1 : 0;

  const debtToIncomeRatio = (existingLoans + requestedAmount) / (annualIncome + 1);
  const incomePerAcre = annualIncome / (areaAcres + 0.1);

  const features = {
    annualIncome,
    requestedAmount,
    existingLoans,
    creditHistoryOk,
    debtToIncomeRatio,
    incomePerAcre
  };

  let logit = model.intercept;
  for (const name of model.featureOrder) {
    logit += model.weights[name] * features[name];
  }

  const probability = sigmoid(logit);
  const score = Math.round(probability * 1000) / 1000;

  let status;
  if (score >= 0.65) status = "eligible";
  else if (score >= 0.4) status = "review";
  else status = "not_eligible";

  return { score, status, missing: [] };
}

export function getModelMetrics() {
  return model.metrics;
}