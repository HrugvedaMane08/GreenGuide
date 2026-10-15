import test from "node:test";
import assert from "node:assert/strict";

import { scoreLoanEligibility, findMissingScoreInputs, REQUIRED_SCORE_INPUTS } from "../features/loanAssistant/services/eligibilityScorer.js";
import { landRules, loanRules, handleValidation } from "../features/loanAssistant/middleware/validators.js";

// Runs the real express-validator chains + handler against a fake request.
async function validate(rules, bodyData) {
  const req = { body: { ...bodyData } };
  for (const rule of rules) await rule.run(req);
  let status = null;
  let json = null;
  let passed = false;
  const res = { status(code) { status = code; return this; }, json(payload) { json = payload; return this; } };
  handleValidation(req, res, () => { passed = true; });
  return { passed, status, json, body: req.body };
}

const FULL_SCORE_INPUT = { areaAcres: 3, annualIncome: 200000, requestedAmount: 100000, existingLoans: 20000, creditHistoryOk: true };
const GOOD_LOAN = { farmerId: "f1", landId: "64b7f0c2a1b2c3d4e5f60718", requestedAmount: 50000, purpose: "Crop loan" };
const GOOD_LAND = { farmerId: "f1", state: "Maharashtra", district: "Pune", areaAcres: 2.5 };

// ---------- scorer: skipped fields are unknown, not bad ----------

test("a complete application is scored", () => {
  const r = scoreLoanEligibility(FULL_SCORE_INPUT);
  assert.equal(typeof r.score, "number");
  assert.ok(["eligible", "review", "not_eligible"].includes(r.status));
  assert.deepEqual(r.missing, []);
});

test("skipping income no longer scores as income 0 / not_eligible", () => {
  const { annualIncome, ...rest } = FULL_SCORE_INPUT;
  const r = scoreLoanEligibility(rest);
  assert.equal(r.status, "needs_more_info");
  assert.equal(r.score, null);
  assert.deepEqual(r.missing.map((m) => m.field), ["annualIncome"]);
});

test("skipping credit history is unknown, not 'OK' and not 'bad'", () => {
  const { creditHistoryOk, ...rest } = FULL_SCORE_INPUT;
  const r = scoreLoanEligibility(rest);
  assert.equal(r.status, "needs_more_info");
  assert.deepEqual(r.missing.map((m) => m.field), ["creditHistoryOk"]);
});

test("an empty application lists everything that is missing, in plain words", () => {
  const r = scoreLoanEligibility({});
  assert.equal(r.status, "needs_more_info");
  assert.equal(r.missing.length, REQUIRED_SCORE_INPUTS.length);
  assert.ok(r.missing.every((m) => m.label.length > 0));
  assert.equal(scoreLoanEligibility().status, "needs_more_info"); // no argument at all
});

test("explicit zeros and explicit 'false' are real answers and ARE scored", () => {
  const r = scoreLoanEligibility({ ...FULL_SCORE_INPUT, annualIncome: 0, existingLoans: 0, creditHistoryOk: false });
  assert.equal(typeof r.score, "number");
  assert.ok(["eligible", "review", "not_eligible"].includes(r.status));
});

test("unusable values (NaN, negative, text) count as missing, never as a score", () => {
  for (const bad of [NaN, -1, "abc", null, Infinity]) {
    assert.equal(scoreLoanEligibility({ ...FULL_SCORE_INPUT, annualIncome: bad }).status, "needs_more_info", String(bad));
  }
  assert.equal(scoreLoanEligibility({ ...FULL_SCORE_INPUT, creditHistoryOk: "yes" }).status, "needs_more_info");
});

test("a negative income can no longer score as eligible", () => {
  assert.notEqual(scoreLoanEligibility({ ...FULL_SCORE_INPUT, annualIncome: -5000 }).status, "eligible");
});

test("complete-input scores are unchanged by this work", () => {
  // Pinned from before the change: same model, same numbers.
  assert.deepEqual(scoreLoanEligibility({ areaAcres: 2, annualIncome: 300000, requestedAmount: 50000, existingLoans: 0, creditHistoryOk: true }).status, "eligible");
  assert.equal(findMissingScoreInputs(FULL_SCORE_INPUT).length, 0);
});

// ---------- land validation ----------

test("a valid land record passes and the area becomes a number", async () => {
  const r = await validate(landRules, { ...GOOD_LAND, areaAcres: "2.5", village: "  Wagholi " });
  assert.ok(r.passed);
  assert.equal(r.body.areaAcres, 2.5);
  assert.equal(r.body.village, "Wagholi");
});

test("land: required fields are all listed in one readable message", async () => {
  const r = await validate(landRules, {});
  assert.equal(r.status, 400);
  assert.match(r.json.error, /^Please fix: /);
  for (const label of ["Farmer ID is required", "State is required", "District is required", "Land area (acres) is required"]) {
    assert.ok(r.json.error.includes(label), `${label} in: ${r.json.error}`);
  }
  assert.deepEqual(r.json.errors.map((e) => e.field).sort(), ["areaAcres", "district", "farmerId", "state"]);
});

test("land: area must be a number greater than 0", async () => {
  for (const areaAcres of [0, -2, "abc", "12abc", NaN, true]) {
    const r = await validate(landRules, { ...GOOD_LAND, areaAcres });
    assert.equal(r.status, 400, String(areaAcres));
    assert.match(r.json.error, /Land area \(acres\) must be a number greater than 0/);
  }
});

test("land: blank optional fields are fine, wrong-typed ones are not", async () => {
  assert.ok((await validate(landRules, { ...GOOD_LAND, village: "", soilType: null, primaryCrop: undefined })).passed);
  const r = await validate(landRules, { ...GOOD_LAND, soilType: 5 });
  assert.match(r.json.error, /Soil type must be text/);
});

// ---------- loan validation ----------

test("a minimal valid loan passes, and skipped optional fields stay undefined (no defaults)", async () => {
  const r = await validate(loanRules, GOOD_LOAN);
  assert.ok(r.passed);
  assert.equal(r.body.annualIncome, undefined);
  assert.equal(r.body.existingLoans, undefined);
  assert.equal(r.body.creditHistoryOk, undefined);
});

test("loan: blank and null optional fields are treated as not provided", async () => {
  const r = await validate(loanRules, { ...GOOD_LOAN, annualIncome: "", existingLoans: null, creditHistoryOk: "" });
  assert.ok(r.passed);
  assert.equal(r.body.annualIncome, undefined);
  assert.equal(r.body.existingLoans, undefined);
  assert.equal(r.body.creditHistoryOk, undefined);
});

test("loan: zero is a valid income and existing-loans value and is kept", async () => {
  const r = await validate(loanRules, { ...GOOD_LOAN, annualIncome: 0, existingLoans: "0" });
  assert.ok(r.passed);
  assert.strictEqual(r.body.annualIncome, 0);
  assert.strictEqual(r.body.existingLoans, 0);
});

test("loan: numeric strings are converted; false stays false", async () => {
  const r = await validate(loanRules, { ...GOOD_LOAN, requestedAmount: "150000", annualIncome: "300000", creditHistoryOk: "false" });
  assert.ok(r.passed);
  assert.strictEqual(r.body.requestedAmount, 150000);
  assert.strictEqual(r.body.annualIncome, 300000);
  assert.strictEqual(r.body.creditHistoryOk, false);
});

test("loan: negative or non-numeric money is rejected with a clear message", async () => {
  const r = await validate(loanRules, { ...GOOD_LOAN, annualIncome: -5000, existingLoans: "lots", requestedAmount: 0 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Annual income must be a number, 0 or more/);
  assert.match(r.json.error, /Existing loans must be a number, 0 or more/);
  assert.match(r.json.error, /Requested amount must be a number greater than 0/);
});

test("loan: missing required fields and a bad land id are all reported together", async () => {
  const r = await validate(loanRules, { landId: "not-an-id" });
  assert.equal(r.status, 400);
  for (const part of ["Farmer ID is required", "Land record is not valid", "Requested amount is required", "Purpose is required"]) {
    assert.ok(r.json.error.includes(part), `${part} in: ${r.json.error}`);
  }
});

test("loan: credit history must be true or false", async () => {
  const r = await validate(loanRules, { ...GOOD_LOAN, creditHistoryOk: "maybe" });
  assert.match(r.json.error, /Credit history must be true or false/);
});
