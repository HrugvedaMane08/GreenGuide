import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  evaluateSchemeEligibility,
  evaluateAllSchemes,
  buildEligibilityProfile,
} from "../features/loanAssistant/services/schemeEligibilityChecks.js";
import { buildProfileQueryText, retrieveSchemes } from "../features/loanAssistant/services/schemeRetrieval.js";
import { generateSchemeExplanations } from "../features/loanAssistant/services/groqGeneration.js";
import schemes from "../features/loanAssistant/data/schemes.json" with { type: "json" };
import rules from "../features/loanAssistant/data/schemeRules.json" with { type: "json" };

const scheme = (id) => schemes.find((s) => s.id === id);
const verdict = (id, land = {}, farmer = {}, loanApplication = {}) =>
  evaluateSchemeEligibility(scheme(id), buildEligibilityProfile({ land, farmer, loanApplication }));

// Everything that rules out the PM-KISAN / Maandhan exclusions.
const NOT_EXCLUDED = {
  incomeTaxPayer: false,
  governmentEmployee: false,
  institutionalLandholder: false,
  registeredProfessional: false,
  coveredBySocialSecurity: false,
};

// ---------- the credit score must not change which schemes are shown ----------

test("profile query and retrieved schemes are identical whatever the loan's eligibility status", () => {
  const land = { primaryCrop: "cotton", state: "Maharashtra", soilType: "black", irrigationType: "drip", areaAcres: 1.5 };
  const queries = ["eligible", "review", "not_eligible", undefined].map((eligibilityStatus) =>
    buildProfileQueryText({ land, loanApplication: { purpose: "crop loan", eligibilityStatus } })
  );
  assert.equal(new Set(queries).size, 1);
  assert.ok(!/income support/i.test(queries[0]));
  const ids = queries.map((q) => retrieveSchemes(q, 3).map((s) => s.id).join(","));
  assert.equal(new Set(ids).size, 1);
});

test("scheme eligibility ignores the loan's credit fields", () => {
  const base = { land: { areaAcres: 1, primaryCrop: "wheat" }, farmer: { landTenure: "owner", ...NOT_EXCLUDED } };
  const good = evaluateSchemeEligibility(scheme("pm-kisan"), buildEligibilityProfile({
    ...base, loanApplication: { eligibilityStatus: "eligible", eligibilityScore: 0.95, creditHistoryOk: true },
  }));
  const bad = evaluateSchemeEligibility(scheme("pm-kisan"), buildEligibilityProfile({
    ...base, loanApplication: { eligibilityStatus: "not_eligible", eligibilityScore: 0.05, creditHistoryOk: false },
  }));
  assert.deepEqual(good, bad);
  assert.equal(good.verdict, "eligible");
});

// ---------- config sanity ----------

test("every scheme has rules, and no rule set is orphaned", () => {
  assert.deepEqual(Object.keys(rules.schemes).sort(), schemes.map((s) => s.id).sort());
});

test("every rule is well formed", () => {
  const types = ["landHectares", "cropDuration", "ageRange", "oneOf", "flagFalse", "purposeKeywords", "positive"];
  for (const [id, cfg] of Object.entries(rules.schemes)) {
    assert.ok(cfg.eligibleReason, `${id} needs eligibleReason`);
    assert.ok(cfg.rules.length > 0, id);
    const seen = new Set();
    for (const r of cfg.rules) {
      assert.ok(types.includes(r.type), `${id}/${r.id}: unknown type ${r.type}`);
      assert.ok(r.id && !seen.has(r.id), `${id}: missing or duplicate rule id ${r.id}`);
      seen.add(r.id);
      assert.equal(typeof r.hard, "boolean", `${id}/${r.id} needs hard`);
      assert.ok(r.pass && r.fail, `${id}/${r.id} needs pass and fail messages`);
      if (["oneOf", "flagFalse", "positive"].includes(r.type)) {
        assert.ok(rules.fields[r.field], `${id}/${r.id}: field ${r.field} has no label`);
      }
    }
  }
});

test("each of the 7 schemes returns a verdict and a one-line reason", () => {
  const results = evaluateAllSchemes(schemes, buildEligibilityProfile({ land: { areaAcres: 2, primaryCrop: "wheat" } }));
  assert.equal(results.length, 7);
  for (const r of results) {
    assert.ok(["eligible", "not_eligible", "needs_more_info"].includes(r.verdict), r.schemeId);
    assert.ok(r.reason && !r.reason.includes("\n"), r.schemeId);
  }
});

// ---------- PM-KISAN ----------

test("PM-KISAN: owner under 2 ha with no exclusions is eligible", () => {
  assert.equal(verdict("pm-kisan", { areaAcres: 3 }, { landTenure: "owner", ...NOT_EXCLUDED }).verdict, "eligible");
});

test("PM-KISAN: each exclusion disqualifies", () => {
  for (const flag of ["governmentEmployee", "incomeTaxPayer", "registeredProfessional", "institutionalLandholder"]) {
    const r = verdict("pm-kisan", { areaAcres: 3 }, { landTenure: "owner", ...NOT_EXCLUDED, [flag]: true });
    assert.equal(r.verdict, "not_eligible", flag);
  }
});

test("PM-KISAN: a tenant is not eligible", () => {
  assert.equal(verdict("pm-kisan", { areaAcres: 3 }, { landTenure: "tenant", ...NOT_EXCLUDED }).verdict, "not_eligible");
});

test("PM-KISAN: above 2 ha is only 'needs more info' (soft limit), not a refusal", () => {
  const r = verdict("pm-kisan", { areaAcres: 10 }, { landTenure: "owner", ...NOT_EXCLUDED });
  assert.equal(r.verdict, "needs_more_info");
  assert.match(r.reason, /2-hectare/);
});

test("PM-KISAN: missing exclusion answers say what to confirm", () => {
  const r = verdict("pm-kisan", { areaAcres: 3 });
  assert.equal(r.verdict, "needs_more_info");
  assert.match(r.reason, /^Need to confirm: /);
  assert.ok(r.reason.length < 400);
});

// ---------- Maandhan ----------

test("Maandhan: age 30, 1 acre, no tax and no other cover is eligible", () => {
  assert.equal(verdict("pm-kisan-maandhan", { areaAcres: 1 }, { age: 30, ...NOT_EXCLUDED }).verdict, "eligible");
});

test("Maandhan: age outside 18-40 is not eligible; boundaries are inclusive", () => {
  assert.equal(verdict("pm-kisan-maandhan", { areaAcres: 1 }, { age: 45, ...NOT_EXCLUDED }).verdict, "not_eligible");
  assert.equal(verdict("pm-kisan-maandhan", { areaAcres: 1 }, { age: 17, ...NOT_EXCLUDED }).verdict, "not_eligible");
  assert.equal(verdict("pm-kisan-maandhan", { areaAcres: 1 }, { age: 18, ...NOT_EXCLUDED }).verdict, "eligible");
  assert.equal(verdict("pm-kisan-maandhan", { areaAcres: 1 }, { age: 40, ...NOT_EXCLUDED }).verdict, "eligible");
});

test("Maandhan: age unknown needs more info and names the age", () => {
  const r = verdict("pm-kisan-maandhan", { areaAcres: 1 }, NOT_EXCLUDED);
  assert.equal(r.verdict, "needs_more_info");
  assert.match(r.reason, /your age/);
});

test("Maandhan: a hard failure decides it even while other inputs are missing", () => {
  const r = verdict("pm-kisan-maandhan", { areaAcres: 10 }); // 4.05 ha, no age, no flags
  assert.equal(r.verdict, "not_eligible");
  assert.match(r.reason, /2-hectare limit/);
});

test("Maandhan: tax payer or other social security cover disqualifies", () => {
  assert.equal(verdict("pm-kisan-maandhan", { areaAcres: 1 }, { age: 30, ...NOT_EXCLUDED, incomeTaxPayer: true }).verdict, "not_eligible");
  assert.equal(verdict("pm-kisan-maandhan", { areaAcres: 1 }, { age: 30, ...NOT_EXCLUDED, coveredBySocialSecurity: true }).verdict, "not_eligible");
});

// ---------- KCC ----------

test("KCC: owner, tenant and sharecropper qualify; no land does not; unknown needs info", () => {
  for (const landTenure of ["owner", "tenant", "sharecropper"]) {
    assert.equal(verdict("kcc", { areaAcres: 2 }, { landTenure }).verdict, "eligible", landTenure);
  }
  assert.equal(verdict("kcc", { areaAcres: 2 }, { landTenure: "none" }).verdict, "not_eligible");
  assert.equal(verdict("kcc", { areaAcres: 2 }).verdict, "needs_more_info");
});

// ---------- PMFBY ----------

test("PMFBY: an annual crop grown by an owner is eligible", () => {
  assert.equal(verdict("pmfby", { primaryCrop: "wheat" }, { landTenure: "owner" }).verdict, "eligible");
});

test("PMFBY: a long-duration crop needs more info (coverage varies by state), not a refusal", () => {
  const r = verdict("pmfby", { primaryCrop: "sugarcane" }, { landTenure: "owner" });
  assert.equal(r.verdict, "needs_more_info");
  assert.match(r.reason, /state notification/);
});

test("PMFBY: an unrecognised crop needs more info", () => {
  assert.equal(verdict("pmfby", { primaryCrop: "dragonfruit-xyz" }, { landTenure: "owner" }).verdict, "needs_more_info");
});

// ---------- AIF and MISS (purpose-driven) ----------

test("AIF: a post-harvest purpose is eligible; a crop loan is not a fit; no purpose needs info", () => {
  assert.equal(verdict("aif", {}, {}, { purpose: "Build a cold storage unit" }).verdict, "eligible");
  const crop = verdict("aif", {}, {}, { purpose: "Crop loan" });
  assert.equal(crop.verdict, "needs_more_info");
  assert.match(crop.reason, /post-harvest/);
  assert.equal(verdict("aif", {}, {}, {}).verdict, "needs_more_info");
});

test("MISS: a short-term crop loan is eligible; a tractor loan is not a fit", () => {
  assert.equal(verdict("interest-subvention", {}, {}, { purpose: "Crop loan" }).verdict, "eligible");
  assert.equal(verdict("interest-subvention", {}, {}, { purpose: "Buy a tractor" }).verdict, "needs_more_info");
});

// ---------- Soil Health Card ----------

test("Soil Health Card: any recorded land makes a farmer eligible, regardless of size or income", () => {
  assert.equal(verdict("soil-health-card", { areaAcres: 0.3 }).verdict, "eligible");
  assert.equal(verdict("soil-health-card", { areaAcres: 400 }).verdict, "eligible");
  assert.equal(verdict("soil-health-card", {}).verdict, "needs_more_info");
});

// ---------- farmer-supplied input handling ----------

test("farmer input is sanitised: junk age and non-boolean flags are ignored (so they stay unknown)", () => {
  const p = buildEligibilityProfile({ farmer: { age: "abc", incomeTaxPayer: "no", landTenure: " Owner ", governmentEmployee: false } });
  assert.equal(p.age, undefined);
  assert.equal(p.incomeTaxPayer, undefined);
  assert.equal(p.landTenure, "owner");
  assert.equal(p.governmentEmployee, false);
  assert.equal(buildEligibilityProfile({ farmer: { age: "35" } }).age, 35);
});

// ---------- wired into scheme matching ----------

test("scheme matching returns an eligibility verdict for every scheme", async () => {
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY; // forces the deterministic fallback path, no network
  try {
    const retrieved = retrieveSchemes("cotton small marginal holding crop loan", 3);
    const out = await generateSchemeExplanations(
      {
        land: { areaAcres: 1.5, primaryCrop: "cotton", state: "Maharashtra" },
        loanApplication: { purpose: "Crop loan", eligibilityStatus: "not_eligible" },
        farmer: { age: 30, landTenure: "owner", ...NOT_EXCLUDED },
      },
      retrieved
    );
    assert.equal(out.length, retrieved.length);
    for (const s of out) {
      assert.ok(s.eligibility, s.schemeId);
      assert.ok(["eligible", "not_eligible", "needs_more_info"].includes(s.eligibility.verdict));
      assert.ok(s.eligibility.reason);
    }
    const kisan = out.find((s) => s.schemeId === "pm-kisan");
    if (kisan) assert.equal(kisan.eligibility.verdict, "eligible");
  } finally {
    if (saved !== undefined) process.env.GROQ_API_KEY = saved;
  }
});

test("schemeRules.json is valid JSON on disk", () => {
  JSON.parse(readFileSync(new URL("../features/loanAssistant/data/schemeRules.json", import.meta.url), "utf8"));
});
