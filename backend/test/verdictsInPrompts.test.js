import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeFarmerFacts,
  buildEligibilityProfile,
  buildEligibilityFactsBlock,
} from "../features/loanAssistant/services/schemeEligibilityChecks.js";
import { buildPrompt as buildSchemeMatchPrompt, generateSchemeExplanations } from "../features/loanAssistant/services/groqGeneration.js";
import { buildPrompt as buildQaPrompt } from "../features/loanAssistant/services/farmerAnswerGeneration.js";
import schemes from "../features/loanAssistant/data/schemes.json" with { type: "json" };

const scheme = (id) => schemes.find((s) => s.id === id);
const land = { areaAcres: 1.5, primaryCrop: "cotton", state: "Maharashtra", district: "Pune" };
const loanApplication = { purpose: "Crop loan", eligibilityStatus: "eligible" };

const ALL_CLEAR = {
  landTenure: "owner",
  incomeTaxPayer: false,
  governmentEmployee: false,
  institutionalLandholder: false,
  registeredProfessional: false,
  coveredBySocialSecurity: false,
};

// ---------- fact validation ----------

test("valid facts are normalised; invalid ones are reported, not stored", () => {
  const { facts, rejected } = sanitizeFarmerFacts({
    age: "35", landTenure: " Tenant ", incomeTaxPayer: false, governmentEmployee: "yes", registeredProfessional: "",
  });
  assert.deepEqual(facts, { age: 35, landTenure: "tenant", incomeTaxPayer: false });
  assert.deepEqual(rejected, ["governmentEmployee"]); // "" is just absent
});

test("out-of-range age and unknown tenure are rejected", () => {
  assert.deepEqual(sanitizeFarmerFacts({ age: 0 }).rejected, ["age"]);
  assert.deepEqual(sanitizeFarmerFacts({ age: 200 }).rejected, ["age"]);
  assert.deepEqual(sanitizeFarmerFacts({ landTenure: "landlord" }).rejected, ["landTenure"]);
  assert.deepEqual(sanitizeFarmerFacts(undefined), { facts: {}, rejected: [] });
});

// ---------- the verdict block ----------

test("the block lists each scheme with its verdict and reason", () => {
  const profile = buildEligibilityProfile({ land: { areaAcres: 10 }, farmer: { age: 45, ...ALL_CLEAR } });
  const block = buildEligibilityFactsBlock([scheme("pm-kisan-maandhan"), scheme("kcc")], profile);
  assert.match(block, /^VERIFIED ELIGIBILITY/);
  assert.match(block, /Pradhan Mantri Kisan Maandhan Yojana \(PM-KMY\) \(id: pm-kisan-maandhan\): NOT ELIGIBLE - /);
  assert.match(block, /Kisan Credit Card \(KCC\) \(id: kcc\): ELIGIBLE - /);
});

test("the block is empty when there are no schemes", () => {
  assert.equal(buildEligibilityFactsBlock([], {}), "");
});

// ---------- the prompts carry the verdicts ----------

test("scheme-match prompt includes the verdict for every retrieved scheme and the new instruction", () => {
  const prompt = buildSchemeMatchPrompt(
    { land, loanApplication, farmer: { age: 45, ...ALL_CLEAR } },
    [scheme("pm-kisan-maandhan"), scheme("pm-kisan")]
  );
  assert.match(prompt, /\(id: pm-kisan-maandhan\): NOT ELIGIBLE - Age 45 is outside the 18-40/);
  assert.match(prompt, /\(id: pm-kisan\): ELIGIBLE - /);
  assert.match(prompt, /NOT ELIGIBLE: say plainly that the farmer does not qualify/);
  assert.ok(!/VERIFIED ELIGIBILITY FACTS/.test(prompt), "old block name should be gone");
});

test("Q&A prompt includes the verdicts when the farmer's land is known", () => {
  const prompt = buildQaPrompt({
    question: "Can I join the Maandhan pension scheme?",
    retrievedSchemes: [scheme("pm-kisan-maandhan")],
    land,
    farmer: { age: 45, ...ALL_CLEAR },
  });
  assert.match(prompt, /VERIFIED ELIGIBILITY/);
  assert.match(prompt, /NOT ELIGIBLE - Age 45 is outside the 18-40/);
});

test("Q&A prompt has no verdict block when there is no land record", () => {
  const prompt = buildQaPrompt({ question: "What documents does KCC need?", retrievedSchemes: [scheme("kcc")], land: null });
  assert.ok(!/VERIFIED ELIGIBILITY \(/.test(prompt));
});

test("Q&A prompt uses saved facts: a farmer who is a government employee is excluded from PM-KISAN", () => {
  const prompt = buildQaPrompt({
    question: "Am I eligible for PM-KISAN?",
    retrievedSchemes: [scheme("pm-kisan")],
    land,
    farmer: { ...ALL_CLEAR, governmentEmployee: true },
  });
  assert.match(prompt, /\(id: pm-kisan\): NOT ELIGIBLE - Serving or retired government employees/);
});

// ---------- not-eligible text is deterministic ----------

test("a not-eligible scheme is explained by the rule, not by model wording", async () => {
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY; // deterministic fallback path, no network
  try {
    const [out] = await generateSchemeExplanations(
      { land, loanApplication, farmer: { age: 45, ...ALL_CLEAR } },
      [{ ...scheme("pm-kisan-maandhan"), matchScore: 0.5 }]
    );
    assert.equal(out.eligibility.verdict, "not_eligible");
    assert.match(out.explanation, /^You do not qualify for this scheme: Age 45/);
  } finally {
    if (saved !== undefined) process.env.GROQ_API_KEY = saved;
  }
});

test("needs-more-info keeps the description and adds what to confirm", async () => {
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const [out] = await generateSchemeExplanations({ land, loanApplication, farmer: {} }, [{ ...scheme("kcc"), matchScore: 0.5 }]);
    assert.equal(out.eligibility.verdict, "needs_more_info");
    assert.ok(out.explanation.startsWith(scheme("kcc").description));
    assert.match(out.explanation, /Note: Need to confirm: /);
  } finally {
    if (saved !== undefined) process.env.GROQ_API_KEY = saved;
  }
});
