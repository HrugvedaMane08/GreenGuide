import test from "node:test";
import assert from "node:assert/strict";

import { pickDistricts, answerWeatherQuestion, NO_DISTRICT_MESSAGE, MAX_DISTRICTS } from "../features/loanAssistant/services/weatherQuestion.js";
import { buildEligibilityProfile, evaluateSchemeEligibility, buildEligibilityFactsBlock } from "../features/loanAssistant/services/schemeEligibilityChecks.js";
import { validateLandDelete, validateVerification } from "../features/loanAssistant/middleware/validators.js";
import { handleValidation } from "../middleware/validation.js";
import schemes from "../features/loanAssistant/data/schemes.json" with { type: "json" };

const scheme = (id) => schemes.find((s) => s.id === id);
const plot = (district, areaAcres, extra = {}) => ({ district, areaAcres, state: "Maharashtra", primaryCrop: "Wheat", ...extra });

// ---------- which districts does a weather question cover? ----------

test("one district: just that one, nothing omitted", () => {
  assert.deepEqual(pickDistricts("Will it rain?", [plot("Pune", 3)]), { chosen: ["Pune"], omitted: 0, next: undefined });
});

test("several districts: each distinct one, biggest holding first", () => {
  const r = pickDistricts("Will it rain?", [plot("Nashik", 1), plot("Pune", 4), plot("pune", 2), plot("Satara", 3)]);
  assert.deepEqual(r.chosen, ["Pune", "Satara", "Nashik"]); // Pune 6 acres (two plots, any case), Satara 3, Nashik 1
  assert.equal(r.omitted, 0);
});

test("a question that names one of the farmer's districts is answered for that one only", () => {
  const lands = [plot("Pune", 4), plot("Nashik", 1)];
  assert.deepEqual(pickDistricts("Will it rain in Nashik tomorrow?", lands).chosen, ["Nashik"]);
  assert.deepEqual(pickDistricts("is it going to rain in nashik", lands).chosen, ["Nashik"]);
  assert.equal(pickDistricts("rain in Nashik and Pune?", lands).chosen.length, 2);
  // a name that is not one of their districts changes nothing
  assert.equal(pickDistricts("rain in Mumbai?", lands).chosen.length, 2);
});

test("more than the cap: the largest are reported and the rest are counted", () => {
  const lands = ["A", "B", "C", "D", "E"].map((d, i) => plot(d, 10 - i));
  const r = pickDistricts("Will it rain?", lands);
  assert.equal(r.chosen.length, MAX_DISTRICTS);
  assert.deepEqual(r.chosen, ["A", "B", "C"]);
  assert.equal(r.omitted, 2);
  assert.equal(r.next, "D");
});

test("a district name with regex characters is matched literally", () => {
  assert.deepEqual(pickDistricts("rain in St. John (East)?", [plot("St. John (East)", 2), plot("Pune", 1)]).chosen, ["St. John (East)"]);
});

test("blank districts are skipped; none at all asks for one", async () => {
  assert.deepEqual(pickDistricts("rain?", [plot("", 2), plot(undefined, 1)]).chosen, []);
  assert.equal((await answerWeatherQuestion({ question: "rain?", lands: [plot("  ", 2)] })).answer, NO_DISTRICT_MESSAGE);
  assert.equal((await answerWeatherQuestion({ question: "rain?", lands: [] })).answer, NO_DISTRICT_MESSAGE);
});

// ---------- how firm is a verdict? ----------

const CLEAR = { age: 30, landTenure: "owner", incomeTaxPayer: false, governmentEmployee: false, institutionalLandholder: false, registeredProfessional: false, coveredBySocialSecurity: false };
const verdict = (id, lands, verifiedFields, farmer = CLEAR) => evaluateSchemeEligibility(scheme(id), buildEligibilityProfile({ lands, farmer, verifiedFields }));

test("a verdict resting on the farmer's own word is 'self_declared' and names the facts", () => {
  const r = verdict("pm-kisan", [plot("Pune", 3)], []);
  assert.equal(r.verdict, "eligible");
  assert.equal(r.basis, "self_declared");
  assert.deepEqual([...r.selfDeclared].sort(), ["governmentEmployee", "incomeTaxPayer", "institutionalLandholder", "landTenure", "registeredProfessional"]);
});

test("once every fact it rests on is verified, the verdict is 'verified'", () => {
  const all = ["landTenure", "governmentEmployee", "incomeTaxPayer", "registeredProfessional", "institutionalLandholder"];
  const r = verdict("pm-kisan", [plot("Pune", 3)], all);
  assert.equal(r.basis, "verified");
  assert.deepEqual(r.selfDeclared, []);
});

test("partly verified is still self_declared, listing only what is left", () => {
  const r = verdict("pm-kisan", [plot("Pune", 3)], ["landTenure", "incomeTaxPayer"]);
  assert.equal(r.basis, "self_declared");
  assert.ok(!r.selfDeclared.includes("landTenure") && !r.selfDeclared.includes("incomeTaxPayer"));
  assert.ok(r.selfDeclared.includes("governmentEmployee"));
});

test("a refusal that rests on land alone is 'land_records', whatever else the farmer said", () => {
  const r = verdict("pm-kisan-maandhan", [plot("Pune", 6), plot("Nashik", 6)], []); // 12 acres, hard 2 ha limit
  assert.equal(r.verdict, "not_eligible");
  assert.equal(r.basis, "land_records");
  assert.deepEqual(r.selfDeclared, []);
});

test("a refusal that rests on a declared fact is self_declared until verified", () => {
  const farmer = { ...CLEAR, governmentEmployee: true };
  assert.equal(verdict("pm-kisan", [plot("Pune", 3)], [], farmer).basis, "self_declared");
  assert.equal(verdict("pm-kisan", [plot("Pune", 3)], ["governmentEmployee"], farmer).basis, "verified");
});

test("schemes that need no declared fact never need verifying", () => {
  const r = verdict("soil-health-card", [plot("Pune", 3)], [], {});
  assert.equal(r.verdict, "eligible");
  assert.equal(r.basis, "land_records");
});

test("unanswered rules rely on nothing, so they do not make a verdict self-declared", () => {
  const r = verdict("pm-kisan", [plot("Pune", 3)], [], {}); // nothing declared
  assert.equal(r.verdict, "needs_more_info");
  assert.equal(r.basis, "land_records");
});

test("the prompt block flags unverified verdicts so the answer hedges, and leaves verified ones alone", () => {
  const lands = [plot("Pune", 3)];
  const unverified = buildEligibilityFactsBlock([scheme("pm-kisan")], buildEligibilityProfile({ lands, farmer: CLEAR }));
  assert.match(unverified, /not yet verified/);
  const all = ["landTenure", "governmentEmployee", "incomeTaxPayer", "registeredProfessional", "institutionalLandholder"];
  const verified = buildEligibilityFactsBlock([scheme("pm-kisan")], buildEligibilityProfile({ lands, farmer: CLEAR, verifiedFields: all }));
  assert.ok(!/not yet verified/.test(verified));
});

// ---------- validators ----------

async function run(validators, { body = {}, params = {}, query = {} } = {}) {
  const req = { body: { ...body }, params: { ...params }, query: { ...query }, headers: {}, cookies: {} };
  let status = null, json = null, passed = false;
  const res = { status(c) { status = c; return this; }, json(p) { json = p; return this; } };
  for (const v of validators) {
    if (v === handleValidation) handleValidation(req, res, () => { passed = true; });
    else if (typeof v.run === "function") await v.run(req);
  }
  return { passed, status, json };
}
const ID = "64b7f0c2a1b2c3d4e5f60718";

test("delete land needs a valid id and the owner's farmerId in the query", async () => {
  assert.ok((await run(validateLandDelete, { params: { id: ID }, query: { farmerId: "f1" } })).passed);
  const bad = await run(validateLandDelete, { params: { id: "x" }, query: {} });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Land record is not valid/);
  assert.match(bad.json.error, /Farmer ID is required/);
});

test("verifying needs a non-empty list of known fields", async () => {
  assert.ok((await run(validateVerification, { params: { farmerId: "f1" }, body: { fields: ["age", "incomeTaxPayer"], note: "Checked ITR" } })).passed);
  assert.match((await run(validateVerification, { params: { farmerId: "f1" }, body: {} })).json.error, /Fields must be a list/);
  assert.match((await run(validateVerification, { params: { farmerId: "f1" }, body: { fields: [] } })).json.error, /at least one field/);
  assert.match((await run(validateVerification, { params: { farmerId: "f1" }, body: { fields: ["age", "shoeSize"] } })).json.error, /Unknown field\(s\): shoeSize/);
});
