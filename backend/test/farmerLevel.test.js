import test from "node:test";
import assert from "node:assert/strict";

import { buildEligibilityProfile, evaluateSchemeEligibility } from "../features/loanAssistant/services/schemeEligibilityChecks.js";
import { buildProfileQueryText } from "../features/loanAssistant/services/schemeRetrieval.js";
import { summarizeLands } from "../features/loanAssistant/services/farmerContext.js";
import { buildPrompt as buildQaPrompt } from "../features/loanAssistant/services/farmerAnswerGeneration.js";
import { buildPrompt as buildMatchPrompt } from "../features/loanAssistant/services/groqGeneration.js";
import { landUpdateRules, validateEligibilityQuery } from "../features/loanAssistant/middleware/validators.js";
import { handleValidation } from "../middleware/validation.js";
import schemes from "../features/loanAssistant/data/schemes.json" with { type: "json" };

const scheme = (id) => schemes.find((s) => s.id === id);
const ID = "64b7f0c2a1b2c3d4e5f60718";

const plot = (areaAcres, primaryCrop, extra = {}) => ({ _id: Math.random().toString(16).slice(2), state: "Maharashtra", district: "Pune", areaAcres, primaryCrop, ...extra });
const CLEAR = { landTenure: "owner", incomeTaxPayer: false, governmentEmployee: false, institutionalLandholder: false, registeredProfessional: false, coveredBySocialSecurity: false };
const verdict = (id, lands, farmer = {}) => evaluateSchemeEligibility(scheme(id), buildEligibilityProfile({ lands, farmer }));

// ---------- the whole holding, not one plot ----------

test("profile totals the area across plots and records distinct crops", () => {
  const p = buildEligibilityProfile({ lands: [plot(3, "Wheat"), plot(2.5, "wheat"), plot(1, "Cotton")] });
  assert.equal(p.areaAcres, 6.5);
  assert.equal(p.plotCount, 3);
  assert.deepEqual(p.crops, ["Wheat", "Cotton"]); // case-insensitive de-dupe
  assert.equal(p.primaryCrop, "Wheat"); // largest plot
});

test("a single land record behaves exactly as before", () => {
  const p = buildEligibilityProfile({ land: plot(3, "Wheat") });
  assert.equal(p.areaAcres, 3);
  assert.equal(p.plotCount, 1);
});

test("PM-KISAN's 2 ha limit is judged on the total: two 3-acre plots are 2.43 ha, not 1.21", () => {
  const one = verdict("pm-kisan", [plot(3, "Wheat")], CLEAR);
  assert.equal(one.verdict, "eligible");
  const two = verdict("pm-kisan", [plot(3, "Wheat"), plot(3, "Wheat")], CLEAR);
  assert.equal(two.verdict, "needs_more_info"); // soft limit
  assert.match(two.reason, /2\.43 ha/);
});

test("Maandhan's hard limit also uses the total, and the reason says so", () => {
  const ok = verdict("pm-kisan-maandhan", [plot(2, "Rice"), plot(2, "Rice")], { ...CLEAR, age: 30 });
  assert.equal(ok.verdict, "eligible");
  assert.match(ok.checks.find((c) => c.id === "landSize").message, /4 acres across 2 plots \(1\.62 ha\)/);
  const over = verdict("pm-kisan-maandhan", [plot(3, "Rice"), plot(3, "Rice")], { ...CLEAR, age: 30 });
  assert.equal(over.verdict, "not_eligible");
});

test("a plot with no usable size is ignored, not counted as zero or crashed on", () => {
  const p = buildEligibilityProfile({ lands: [plot(3, "Wheat"), plot(undefined, "Rice"), plot(-2, "Rice")] });
  assert.equal(p.areaAcres, 3);
  assert.equal(buildEligibilityProfile({ lands: [plot(undefined, "Rice")] }).areaAcres, undefined);
});

test("no land at all: every land rule is unknown, nothing throws", () => {
  const r = verdict("pm-kisan", [], CLEAR);
  assert.equal(r.verdict, "needs_more_info");
  assert.match(r.reason, /your land size/);
  assert.equal(verdict("soil-health-card", []).verdict, "needs_more_info");
});

// ---------- crops: any covered crop is enough ----------

test("PMFBY: one covered crop among several is enough; none covered is a soft failure", () => {
  assert.equal(verdict("pmfby", [plot(2, "Sugarcane"), plot(1, "Wheat")], CLEAR).verdict, "eligible");
  const none = verdict("pmfby", [plot(2, "Sugarcane"), plot(1, "Banana")], CLEAR);
  assert.equal(none.verdict, "needs_more_info");
  assert.match(none.reason, /Sugarcane, Banana/);
  assert.equal(verdict("pmfby", [plot(2, "dragonfruit-xyz")], CLEAR).verdict, "needs_more_info");
});

// ---------- retrieval query ----------

test("profile query covers every plot, once, and sizes the holding by the total", () => {
  const lands = [plot(1.5, "Cotton", { irrigationType: "Drip" }), plot(1.5, "Cotton", { irrigationType: "Drip" }), plot(1, "Wheat", { irrigationType: "Rainfed" })];
  const q = buildProfileQueryText({ lands, loanApplication: { purpose: "Crop loan" } });
  assert.equal((q.match(/Cotton/g) || []).length, 1);
  assert.match(q, /Wheat/);
  assert.match(q, /rainfed/);
  assert.match(q, /irrigated/);
  assert.match(q, /medium larger holding/); // 4 acres in total, though no plot is over 2
  assert.equal(buildProfileQueryText({ lands: [plot(1.5, "Cotton")] }).includes("small marginal holding"), true);
});

test("summarizeLands totals acres and lists distinct values", () => {
  const s = summarizeLands([plot(3, "Wheat", { district: "Pune" }), plot(2, "Cotton", { district: "Nashik", soilType: "Black" })]);
  assert.equal(s.plots, 2);
  assert.equal(s.totalAcres, 5);
  assert.equal(s.totalHectares, 2.02);
  assert.deepEqual(s.districts, ["Pune", "Nashik"]);
  assert.deepEqual(s.crops, ["Wheat", "Cotton"]);
  assert.deepEqual(summarizeLands([]), { plots: 0, totalAcres: 0, totalHectares: 0, states: [], districts: [], crops: [], soilTypes: [], irrigationTypes: [] });
});

// ---------- prompts see the whole holding ----------

test("Q&A prompt describes several plots together and uses the total for the verdicts", () => {
  const prompt = buildQaPrompt({
    question: "Am I eligible for PM-KISAN?",
    retrievedSchemes: [scheme("pm-kisan")],
    lands: [plot(3, "Wheat"), plot(3, "Cotton")],
    farmer: CLEAR,
  });
  assert.match(prompt, /2 land plots totalling 6 acres/);
  assert.match(prompt, /2\.43 ha/);
});

test("Q&A prompt with a single record is unchanged", () => {
  const prompt = buildQaPrompt({ question: "q", retrievedSchemes: [scheme("kcc")], land: plot(3, "Wheat", { soilType: "Black" }) });
  assert.match(prompt, /location Pune, Maharashtra; primary crop Wheat; soil Black/);
});

test("scheme-match prompt mentions the whole holding only when there are several plots", () => {
  const ctx = { loanApplication: { purpose: "Crop loan" }, farmer: CLEAR };
  const multi = buildMatchPrompt({ ...ctx, land: plot(3, "Wheat"), lands: [plot(3, "Wheat"), plot(2, "Cotton")] }, [scheme("pm-kisan")]);
  assert.match(multi, /Whole holding: 5 acres across 2 plots; crops: Wheat, Cotton/);
  const single = buildMatchPrompt({ ...ctx, land: plot(3, "Wheat"), lands: [plot(3, "Wheat")] }, [scheme("pm-kisan")]);
  assert.ok(!/Whole holding/.test(single));
});

// ---------- validators for the new routes ----------

async function run(validators, { body = {}, params = {}, query = {} } = {}) {
  const req = { body: { ...body }, params: { ...params }, query: { ...query }, headers: {}, cookies: {} };
  let status = null, json = null, passed = false;
  const res = { status(c) { status = c; return this; }, json(p) { json = p; return this; } };
  for (const v of validators) {
    if (v === handleValidation) handleValidation(req, res, () => { passed = true; });
    else if (typeof v.run === "function") await v.run(req);
  }
  return { passed, status, json, body: req.body };
}
const rejects = (r, ...parts) => { assert.equal(r.status, 400, JSON.stringify(r.json)); for (const p of parts) assert.ok(r.json.error.includes(p), `"${p}" in: ${r.json.error}`); };

test("land update: needs the owner; required fields can change but not be blanked", async () => {
  const rules = (b) => run([...landUpdateRules, handleValidation], { body: b, params: { id: ID } });
  rejects(await rules({}), "Farmer ID is required");
  assert.ok((await rules({ farmerId: "f", areaAcres: "4.5", primaryCrop: null, village: "" })).passed);
  rejects(await rules({ farmerId: "f", areaAcres: 0 }), "Land area (acres) must be a number greater than 0");
  rejects(await rules({ farmerId: "f", areaAcres: null }), "Land area (acres) must be a number greater than 0");
  rejects(await rules({ farmerId: "f", state: "  " }), "State cannot be empty");
  rejects(await rules({ farmerId: "f", district: null }), "District must be text");
  rejects(await rules({ farmerId: "f", soilType: 5 }), "Soil type must be text");
  const r = await rules({ farmerId: "f", primaryCrop: null, village: "", soilType: " Black " });
  assert.strictEqual(r.body.primaryCrop, null);
  assert.strictEqual(r.body.village, null);
  assert.strictEqual(r.body.soilType, "Black");
});

test("eligibility query needs a farmerId; purpose is optional text", async () => {
  rejects(await run(validateEligibilityQuery, { query: {} }), "Farmer ID is required");
  rejects(await run(validateEligibilityQuery, { query: { farmerId: ["a", "b"] } }), "Farmer ID must be text");
  assert.ok((await run(validateEligibilityQuery, { query: { farmerId: "f1" } })).passed);
  assert.ok((await run(validateEligibilityQuery, { query: { farmerId: "f1", purpose: "cold storage" } })).passed);
  rejects(await run(validateEligibilityQuery, { query: { farmerId: "f1", purpose: "x".repeat(201) } }), "Purpose must be at most 200");
});
