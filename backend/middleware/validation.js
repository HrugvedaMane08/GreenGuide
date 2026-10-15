// Shared request-validation helpers (express-validator), used by both the core
// routes in server.js and the loan-assistant feature.
//
// Conventions:
//  - A required field must be present and well formed.
//  - Optional fields: leaving them out (or sending null / "") means "not provided".
//    They are never filled in with a default. Only a value that is present but
//    wrong is an error.
//  - Every problem is reported at once, in plain language, as
//      { error: "Please fix: A; B.", errors: [{ field, message }] }  with HTTP 400.

import { body, param, validationResult } from "express-validator";

export const blankToUndefined = (v) => (v === "" || v === null ? undefined : v);

export const toNumber = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** A required, non-empty piece of text. */
export const requiredText = (field, label, max = 100) =>
  body(field)
    .exists({ values: "falsy" }).withMessage(`${label} is required`).bail()
    .isString().withMessage(`${label} must be text`).bail()
    .trim()
    .notEmpty().withMessage(`${label} is required`).bail()
    .isLength({ max }).withMessage(`${label} must be at most ${max} characters`);

/** Optional text: absent / null / "" are fine; anything else must be text. */
export const optionalText = (field, label, max = 100) =>
  body(field)
    .customSanitizer(blankToUndefined)
    .optional()
    .isString().withMessage(`${label} must be text`).bail()
    .trim()
    .isLength({ max }).withMessage(`${label} must be at most ${max} characters`);

/**
 * A number. `positive` means > 0 (land size, loan amount); otherwise 0 or more
 * (income, existing loans), because 0 is a genuine answer there. Numeric strings
 * such as "150000" are accepted and converted; "abc", "12abc", NaN and negatives
 * are rejected.
 */
export const amount = (field, label, { required = false, positive = false } = {}) => {
  const rule = positive ? "a number greater than 0" : "a number, 0 or more";
  let chain = body(field);
  if (required) {
    chain = chain.customSanitizer((v) => (v === "" ? undefined : v)).exists({ values: "null" }).withMessage(`${label} is required`).bail();
  } else {
    chain = chain.customSanitizer(blankToUndefined).optional();
  }
  return chain
    .custom((v) => {
      const n = toNumber(v);
      return Number.isFinite(n) && (positive ? n > 0 : n >= 0);
    })
    .withMessage(`${label} must be ${rule}`)
    .customSanitizer(toNumber);
};

/** A whole number of at least `min` (durations in days). Numeric strings are converted. */
export const integer = (field, label, { required = true, min = 1 } = {}) => {
  let chain = body(field);
  if (required) {
    chain = chain.customSanitizer((v) => (v === "" ? undefined : v)).exists({ values: "null" }).withMessage(`${label} is required`).bail();
  } else {
    chain = chain.customSanitizer(blankToUndefined).optional();
  }
  return chain
    .custom((v) => Number.isInteger(toNumber(v)) && toNumber(v) >= min)
    .withMessage(`${label} must be a whole number, ${min} or more`)
    .customSanitizer(toNumber);
};

/** A date (ISO string like 2026-10-10 or anything Date can parse). */
export const dateField = (field, label, { required = true } = {}) => {
  let chain = body(field);
  chain = required
    ? chain.exists({ values: "falsy" }).withMessage(`${label} is required`).bail()
    : chain.customSanitizer(blankToUndefined).optional();
  return chain.custom((v) => (typeof v === "string" || v instanceof Date) && !Number.isNaN(Date.parse(v))).withMessage(`${label} must be a valid date`);
};

/** Optional true/false (JSON booleans or the strings "true" / "false"). */
export const optionalBoolean = (field, label) =>
  body(field)
    .customSanitizer(blankToUndefined)
    .optional()
    .custom((v) => typeof v === "boolean" || v === "true" || v === "false")
    .withMessage(`${label} must be true or false`)
    .customSanitizer((v) => v === true || v === "true");

/** Required true/false. */
export const requiredBoolean = (field, label) =>
  body(field)
    .exists({ values: "null" }).withMessage(`${label} is required`).bail()
    .custom((v) => typeof v === "boolean" || v === "true" || v === "false")
    .withMessage(`${label} must be true or false`)
    .customSanitizer((v) => v === true || v === "true");

/** A required email address. */
export const requiredEmail = (field = "email", label = "Email") =>
  body(field)
    .exists({ values: "falsy" }).withMessage(`${label} is required`).bail()
    .isString().withMessage(`${label} must be text`).bail()
    .trim()
    .isEmail().withMessage(`Enter a valid ${label.toLowerCase()} address`);

/** An optional email address. */
export const optionalEmail = (field = "email", label = "Email") =>
  body(field)
    .customSanitizer(blankToUndefined)
    .optional()
    .isString().withMessage(`${label} must be text`).bail()
    .trim()
    .isEmail().withMessage(`Enter a valid ${label.toLowerCase()} address`);

/** A required password: text of at least `min` characters (not trimmed - spaces count). */
export const requiredPassword = (field = "password", label = "Password", { min = 1 } = {}) =>
  body(field)
    .exists({ values: "falsy" }).withMessage(`${label} is required`).bail()
    .isString().withMessage(`${label} must be text`).bail()
    .isLength({ min }).withMessage(`${label} must be at least ${min} characters`);

/** A MongoDB id in the URL, e.g. /lands/:id. Stops "abc" becoming a 500 CastError. */
export const objectIdParam = (name, label) =>
  param(name).custom((v) => typeof v === "string" && OBJECT_ID.test(v)).withMessage(`${label} is not valid`);

/** A MongoDB id in the body. */
export const objectIdBody = (field, label) =>
  body(field)
    .exists({ values: "falsy" }).withMessage(`${label} is required`).bail()
    .custom((v) => typeof v === "string" && OBJECT_ID.test(v)).withMessage(`${label} is not valid`);

/** Runs after the rules: replies 400 with every problem, or continues. */
export function handleValidation(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const errors = result.array({ onlyFirstError: true }).map((e) => ({ field: e.path, message: e.msg }));
  return res.status(400).json({
    error: `Please fix: ${errors.map((e) => e.message).join("; ")}.`,
    errors,
  });
}

/** Wraps a list of rules with the handler, ready to drop into a route. */
export const validate = (...rules) => [...rules.flat(), handleValidation];

/** Validates a single id in the URL. */
export const validateIdParam = (name, label) => validate(objectIdParam(name, label));
