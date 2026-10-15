import test from "node:test";
import assert from "node:assert/strict";

import { loanUpdateRules, validateSchemeMatch, validateFarmerQuery } from "../features/loanAssistant/middleware/validators.js";
import {
  validateSignup, validateLogin, validateForgotPassword, validateResetPassword,
  validateProfileUpdate, validateNotificationsUpdate, validateActivity,
  validateCropPlan, validateUserCropCreate, validateUserCropUpdate, validateUserIdParam,
} from "../middleware/coreValidators.js";
import { handleValidation, validateIdParam } from "../middleware/validation.js";

const ID = "64b7f0c2a1b2c3d4e5f60718";

// Runs a route's whole validator list (rules + handler), as Express would.
async function run(validators, { body = {}, params = {} } = {}) {
  const req = { body: { ...body }, params: { ...params }, query: {}, headers: {}, cookies: {} };
  let status = null, json = null, passed = false;
  const res = { status(c) { status = c; return this; }, json(p) { json = p; return this; } };
  for (const v of validators) {
    if (v === handleValidation) { handleValidation(req, res, () => { passed = true; }); }
    else if (typeof v.run === "function") await v.run(req);
  }
  return { passed, status, json, body: req.body };
}
const rejects = (r, ...parts) => { assert.equal(r.status, 400, JSON.stringify(r.json)); for (const p of parts) assert.ok(r.json.error.includes(p), `"${p}" in: ${r.json.error}`); };

// ---------- loan update (PATCH) ----------

const patchRun = (body, params = { loanId: ID }) => run([...loanUpdateRules, handleValidation], { body, params });

test("PATCH: needs the owner's farmerId and a valid loan id", async () => {
  rejects(await patchRun({}), "Farmer ID is required");
  rejects(await patchRun({ farmerId: "f" }, { loanId: "nope" }), "Loan application is not valid");
});

test("PATCH: a field left out is untouched (stays undefined), null clears (stays null)", async () => {
  const r = await patchRun({ farmerId: "f", annualIncome: 250000, existingLoans: null, creditHistoryOk: "" });
  assert.ok(r.passed);
  assert.strictEqual(r.body.annualIncome, 250000);
  assert.strictEqual(r.body.existingLoans, null);
  assert.strictEqual(r.body.creditHistoryOk, null);
  assert.strictEqual(r.body.purpose, undefined);
  assert.strictEqual(r.body.requestedAmount, undefined);
});

test("PATCH: zero and false are real values, not 'clear'", async () => {
  const r = await patchRun({ farmerId: "f", annualIncome: 0, existingLoans: "0", creditHistoryOk: false });
  assert.ok(r.passed);
  assert.strictEqual(r.body.annualIncome, 0);
  assert.strictEqual(r.body.existingLoans, 0);
  assert.strictEqual(r.body.creditHistoryOk, false);
});

test("PATCH: bad values are rejected with readable messages", async () => {
  rejects(await patchRun({ farmerId: "f", annualIncome: -1, existingLoans: "x" }), "Annual income must be a number", "Existing loans must be a number");
  rejects(await patchRun({ farmerId: "f", creditHistoryOk: "maybe" }), "Credit history must be true or false");
  rejects(await patchRun({ farmerId: "f", purpose: "   " }), "Purpose cannot be empty");
});

test("PATCH: the loan amount and purpose can be changed but never cleared", async () => {
  assert.ok((await patchRun({ farmerId: "f", requestedAmount: "90000", purpose: " Tractor " })).passed);
  rejects(await patchRun({ farmerId: "f", requestedAmount: null }), "Requested amount must be a number greater than 0");
  rejects(await patchRun({ farmerId: "f", requestedAmount: 0 }), "Requested amount must be a number greater than 0");
});

// ---------- scheme matching + questions ----------

test("scheme match: bad loan id and bad farmerProfile are rejected, valid or absent profile passes", async () => {
  rejects(await run(validateSchemeMatch, { params: { loanId: "abc" } }), "Loan application is not valid");
  rejects(await run(validateSchemeMatch, { params: { loanId: ID }, body: { farmerProfile: { age: "abc" } } }), "Your details are not valid: age");
  rejects(await run(validateSchemeMatch, { params: { loanId: ID }, body: { farmerProfile: "text" } }), "Your details must be an object");
  assert.ok((await run(validateSchemeMatch, { params: { loanId: ID }, body: { farmerProfile: { age: 30, landTenure: "owner" } } })).passed);
  assert.ok((await run(validateSchemeMatch, { params: { loanId: ID }, body: {} })).passed);
  assert.ok((await run(validateSchemeMatch, { params: { loanId: ID }, body: { farmerProfile: null } })).passed);
});

test("question: must be text, non-empty, reasonable length; language must be supported", async () => {
  const ok = (body) => run(validateFarmerQuery, { params: { farmerId: "f1" }, body });
  assert.ok((await ok({ question: "  Am I eligible?  ", language: "mr" })).passed);
  assert.ok((await ok({ question: "hello" })).passed);
  assert.ok((await ok({ question: "hello", language: "auto" })).passed);
  rejects(await ok({}), "Question is required");
  rejects(await ok({ question: 5 }), "Question must be text");
  rejects(await ok({ question: { a: 1 } }), "Question must be text");
  rejects(await ok({ question: "   " }), "Question is required");
  rejects(await ok({ question: "x".repeat(1001) }), "at most 1000");
  rejects(await ok({ question: "hi", language: "xx" }), "Language must be one of: auto, en, hi, mr");
});

// ---------- accounts ----------

test("signup: name, a real email and an 8+ character password are required; location is optional", async () => {
  assert.ok((await run(validateSignup, { body: { name: "Asha", email: "asha@example.com", password: "Passw0rd!", location: "" } })).passed);
  rejects(await run(validateSignup, { body: {} }), "Name is required", "Email is required", "Password is required");
  rejects(await run(validateSignup, { body: { name: "A", email: "nope", password: "Passw0rd!" } }), "Enter a valid email address");
  rejects(await run(validateSignup, { body: { name: "A", email: "a@b.co", password: "short" } }), "Password must be at least 8 characters");
  rejects(await run(validateSignup, { body: { name: "A", email: "a@b.co", password: 12345678 } }), "Password must be text");
});

test("login: needs an email and a password, both text; does not impose a format", async () => {
  assert.ok((await run(validateLogin, { body: { email: "anything", password: "x" } })).passed);
  rejects(await run(validateLogin, { body: {} }), "Email is required", "Password is required");
  rejects(await run(validateLogin, { body: { email: "a@b.co", password: 5 } }), "Password must be text");
});

test("forgot / reset password", async () => {
  rejects(await run(validateForgotPassword, { body: {} }), "Email is required");
  rejects(await run(validateForgotPassword, { body: { email: "bad" } }), "Enter a valid email address");
  rejects(await run(validateResetPassword, { body: {} }), "Reset token is required", "New password is required");
  rejects(await run(validateResetPassword, { body: { token: "t", password: "short" } }), "at least 8 characters");
  assert.ok((await run(validateResetPassword, { body: { token: "abc123", password: "Passw0rd!" } })).passed);
});

test("profile update and notifications: ids and booleans are checked", async () => {
  rejects(await run(validateProfileUpdate, { params: { id: "abc" }, body: {} }), "User is not valid");
  rejects(await run(validateProfileUpdate, { params: { id: ID }, body: { email: "nope" } }), "Enter a valid email address");
  assert.ok((await run(validateProfileUpdate, { params: { id: ID }, body: { name: "New", email: "n@e.co" } })).passed);
  rejects(await run(validateNotificationsUpdate, { params: { id: ID }, body: { emailNotifications: "yes" } }), "Email notifications must be true or false", "Deadline reminders is required");
  const ok = await run(validateNotificationsUpdate, { params: { id: ID }, body: { emailNotifications: "false", deadlineReminders: true } });
  assert.ok(ok.passed);
  assert.strictEqual(ok.body.emailNotifications, false);
  rejects(await run(validateUserIdParam, { params: { id: "x" } }), "User is not valid");
  rejects(await run(validateIdParam("id", "Thing"), { params: { id: "x" } }), "Thing is not valid");
});

test("activity needs a valid user id and text", async () => {
  rejects(await run(validateActivity, { body: {} }), "User is required", "Activity is required");
  assert.ok((await run(validateActivity, { body: { userId: ID, activity: "Added a crop" } })).passed);
});

// ---------- crops ----------

test("crop plan: crop, soil, method and a positive area", async () => {
  const good = { crop_name: "Rice", soil_type: "Loam", cultivation_method: "Organic", land_area: 2 };
  assert.ok((await run(validateCropPlan, { body: good })).passed);
  assert.ok((await run(validateCropPlan, { body: { ...good, land_area: "2.5" } })).passed);
  rejects(await run(validateCropPlan, { body: {} }), "Crop is required", "Soil type is required", "Cultivation method is required", "Land area is required");
  rejects(await run(validateCropPlan, { body: { ...good, land_area: -5 } }), "Land area must be a number greater than 0");
});

test("calendar crop: create needs everything valid; the page's real payload passes", async () => {
  const fromPage = { userId: ID, name: "Wheat", type: "Cereal", plantDate: "2026-11-01", growDuration: 120, harvestDuration: 10 };
  assert.ok((await run(validateUserCropCreate, { body: fromPage })).passed);
  rejects(await run(validateUserCropCreate, { body: {} }), "User is required", "Crop name is required", "Plant date is required", "Growth duration (days) is required");
  rejects(await run(validateUserCropCreate, { body: { ...fromPage, plantDate: "not-a-date", growDuration: "abc", harvestDuration: -1 } }),
    "Plant date must be a valid date", "Growth duration (days) must be a whole number", "Harvest duration (days) must be a whole number");
  rejects(await run(validateUserCropCreate, { body: { ...fromPage, growDuration: 1.5 } }), "must be a whole number");
});

test("calendar crop: update checks only the fields it is given", async () => {
  assert.ok((await run(validateUserCropUpdate, { params: { id: ID }, body: { growDuration: 100 } })).passed);
  assert.ok((await run(validateUserCropUpdate, { params: { id: ID }, body: {} })).passed);
  rejects(await run(validateUserCropUpdate, { params: { id: "x" }, body: { growDuration: 0 } }), "Crop is not valid", "Growth duration (days) must be a whole number, 1 or more");
});
