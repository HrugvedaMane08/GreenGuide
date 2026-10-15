// Request validation for the loan-assistant routes (express-validator).
// The helpers and conventions live in backend/middleware/validation.js.
//
// Before this, a non-numeric amount reached the scorer and came back as a null
// score labelled "not_eligible", a negative income scored as "eligible" (0.94),
// and a malformed id surfaced as a 500.

import { body, param, query } from "express-validator";
import {
  amount,
  optionalBoolean,
  optionalText,
  requiredText,
  objectIdParam,
  objectIdBody,
  toNumber,
  validate,
  handleValidation,
} from "../../../middleware/validation.js";
import { sanitizeFarmerFacts, FARMER_FACT_FIELDS } from "../services/schemeEligibilityChecks.js";
import { SUPPORTED_LANGUAGES } from "../services/supportedLanguages.js";

export { handleValidation };

// ---------------------------------------------------------------- land + loan (create)

export const landRules = [
  requiredText("farmerId", "Farmer ID"),
  requiredText("state", "State"),
  requiredText("district", "District"),
  amount("areaAcres", "Land area (acres)", { required: true, positive: true }),
  optionalText("village", "Village"),
  optionalText("soilType", "Soil type"),
  optionalText("irrigationType", "Irrigation type"),
  optionalText("primaryCrop", "Primary crop"),
];

export const loanRules = [
  requiredText("farmerId", "Farmer ID"),
  body("landId")
    .exists({ values: "falsy" }).withMessage("Land record is required - add and select your land first").bail()
    .custom((v) => typeof v === "string" && /^[a-f\d]{24}$/i.test(v)).withMessage("Land record is not valid - select your land again"),
  amount("requestedAmount", "Requested amount", { required: true, positive: true }),
  requiredText("purpose", "Purpose", 200),
  amount("annualIncome", "Annual income"),
  amount("existingLoans", "Existing loans"),
  optionalBoolean("creditHistoryOk", "Credit history"),
];

export const validateLand = validate(landRules);
export const validateLoan = validate(loanRules);

// ---------------------------------------------------------------- loan update (PATCH)
//
// A field left out is unchanged. A field sent as null (or "") is cleared, i.e. goes
// back to "not provided" - which is why these differ from the create rules, where
// null and absent mean the same thing.

const patchAmount = (field, label, { positive = false, nullable = true } = {}) =>
  body(field)
    .optional({ values: "undefined" })
    .custom((v) => {
      if (v === null || v === "") return nullable;
      const n = toNumber(v);
      return Number.isFinite(n) && (positive ? n > 0 : n >= 0);
    })
    .withMessage(nullable ? `${label} must be a number, 0 or more (or empty to clear it)` : `${label} must be a number greater than 0`)
    .customSanitizer((v) => (v === null || v === "" ? null : toNumber(v)));

const patchBoolean = (field, label) =>
  body(field)
    .optional({ values: "undefined" })
    .custom((v) => v === null || v === "" || typeof v === "boolean" || v === "true" || v === "false")
    .withMessage(`${label} must be true or false (or empty to clear it)`)
    .customSanitizer((v) => (v === null || v === "" ? null : v === true || v === "true"));

const loanAnswerRules = [
  patchAmount("requestedAmount", "Requested amount", { positive: true, nullable: false }),
  body("purpose")
    .optional({ values: "undefined" })
    .isString().withMessage("Purpose must be text").bail()
    .trim()
    .notEmpty().withMessage("Purpose cannot be empty").bail()
    .isLength({ max: 200 }).withMessage("Purpose must be at most 200 characters"),
  patchAmount("annualIncome", "Annual income"),
  patchAmount("existingLoans", "Existing loans"),
  patchBoolean("creditHistoryOk", "Credit history"),
];

export const loanUpdateRules = [
  objectIdParam("loanId", "Loan application"),
  requiredText("farmerId", "Farmer ID"),
  ...loanAnswerRules,
];

export const validateLoanUpdate = validate(loanUpdateRules);

// ---------------------------------------------------------------- land update (PATCH)

const patchRequiredText = (field, label) =>
  body(field)
    .optional({ values: "undefined" })
    .isString().withMessage(`${label} must be text`).bail()
    .trim()
    .notEmpty().withMessage(`${label} cannot be empty`).bail()
    .isLength({ max: 100 }).withMessage(`${label} must be at most 100 characters`);

const patchOptionalText = (field, label) =>
  body(field)
    .optional({ values: "undefined" })
    .custom((v) => v === null || typeof v === "string").withMessage(`${label} must be text (or empty to clear it)`).bail()
    .customSanitizer((v) => (v === null || String(v).trim() === "" ? null : String(v).trim()))
    .custom((v) => v === null || v.length <= 100).withMessage(`${label} must be at most 100 characters`);

export const landUpdateRules = [
  objectIdParam("id", "Land record"),
  requiredText("farmerId", "Farmer ID"),
  patchRequiredText("state", "State"),
  patchRequiredText("district", "District"),
  patchAmount("areaAcres", "Land area (acres)", { positive: true, nullable: false }),
  patchOptionalText("village", "Village"),
  patchOptionalText("soilType", "Soil type"),
  patchOptionalText("irrigationType", "Irrigation type"),
  patchOptionalText("primaryCrop", "Primary crop"),
];

export const validateLandUpdate = validate(landUpdateRules);

export const validateLandDelete = validate(
  objectIdParam("id", "Land record"),
  query("farmerId")
    .exists({ values: "falsy" }).withMessage("Farmer ID is required").bail()
    .isString().withMessage("Farmer ID must be text").bail()
    .trim()
    .isLength({ max: 100 }).withMessage("Farmer ID must be at most 100 characters")
);

// ---------------------------------------------------------------- admin: verify a farmer's details

export const validateVerification = validate(
  param("farmerId").trim().notEmpty().withMessage("Farmer ID is required"),
  body("fields")
    .isArray({ min: 1 }).withMessage("Fields must be a list with at least one field")
    .bail()
    .custom((list) => {
      const unknown = list.filter((f) => !FARMER_FACT_FIELDS.includes(f));
      if (unknown.length > 0) throw new Error(`Unknown field(s): ${unknown.join(", ")}. Choose from: ${FARMER_FACT_FIELDS.join(", ")}`);
      return true;
    }),
  optionalText("note", "Note", 300)
);

// ---------------------------------------------------------------- eligibility without a loan

export const validateEligibilityQuery = validate(
  query("farmerId")
    .exists({ values: "falsy" }).withMessage("Farmer ID is required").bail()
    .isString().withMessage("Farmer ID must be text").bail()
    .trim()
    .isLength({ max: 100 }).withMessage("Farmer ID must be at most 100 characters"),
  query("purpose")
    .optional({ values: "falsy" })
    .isString().withMessage("Purpose must be text").bail()
    .trim()
    .isLength({ max: 200 }).withMessage("Purpose must be at most 200 characters")
);

// ---------------------------------------------------------------- scheme matching

export const validateSchemeMatch = validate(
  objectIdParam("loanId", "Loan application"),
  body("farmerProfile")
    .optional({ values: "null" })
    .custom((v) => {
      if (typeof v !== "object" || Array.isArray(v)) throw new Error("Your details must be an object");
      const { rejected } = sanitizeFarmerFacts(v);
      if (rejected.length > 0) throw new Error(`Your details are not valid: ${rejected.join(", ")}`);
      return true;
    })
);

// ---------------------------------------------------------------- single-record reads

export const validateLandIdParam = validate(objectIdParam("id", "Land record"));
export const validateLandIdForMandi = validate(objectIdParam("landId", "Land record"));

// ---------------------------------------------------------------- questions

const LANGUAGE_CODES = ["auto", ...Object.keys(SUPPORTED_LANGUAGES)];

export const validateFarmerQuery = validate(
  param("farmerId").trim().notEmpty().withMessage("Farmer ID is required").bail().isLength({ max: 100 }).withMessage("Farmer ID must be at most 100 characters"),
  body("question")
    .exists({ values: "falsy" }).withMessage("Question is required").bail()
    .isString().withMessage("Question must be text").bail()
    .trim()
    .notEmpty().withMessage("Question is required").bail()
    .isLength({ max: 1000 }).withMessage("Question must be at most 1000 characters"),
  body("language")
    .optional({ values: "null" })
    .custom((v) => LANGUAGE_CODES.includes(v))
    .withMessage(`Language must be one of: ${LANGUAGE_CODES.join(", ")}`),
  body("sessionId")
    .optional({ values: "null" })
    .custom((v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v))
    .withMessage("Session is not valid")
);

export const validateConversationClear = validate(
  param("farmerId").trim().notEmpty().withMessage("Farmer ID is required"),
  query("sessionId").optional().custom((v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v)).withMessage("Session is not valid")
);

// ---------------------------------------------------------------- admin: question statistics

export const validateQuestionStats = validate(
  query("days").optional().isInt({ min: 1, max: 365 }).withMessage("Days must be a whole number from 1 to 365"),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("Limit must be a whole number from 1 to 100")
);
