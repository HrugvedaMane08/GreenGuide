// Run with: npm test   (Node's built-in runner; no extra dependencies)
//
// Covers the deterministic parts of the Q&A and loan pipeline. Nothing here
// calls Groq or MongoDB: scope checks use only questions the keyword gate
// decides on its own, so the suite is fast and works offline.

import test from "node:test";
import assert from "node:assert/strict";

import { retrieveSchemes, buildProfileQueryText } from "../features/loanAssistant/services/schemeRetrieval.js";
import { isInScope } from "../features/loanAssistant/services/questionScope.js";
import { scoreLoanEligibility } from "../features/loanAssistant/services/eligibilityScorer.js";
import { checkSchemeRestrictions, lookupCrop } from "../features/loanAssistant/services/schemeEligibilityChecks.js";
import { summarizeMandiRecords } from "../features/loanAssistant/services/mandiPriceService.js";
import { isSupportedAudioType } from "../features/loanAssistant/services/groqTranscription.js";
import schemes from "../features/loanAssistant/data/schemes.json" with { type: "json" };

const scheme = (id) => schemes.find((s) => s.id === id);

// ---------- retrieval ----------

test("profile query drops the word 'soil' so Soil Health Card doesn't dominate", () => {
  const q = buildProfileQueryText({ land: { soilType: "black soil", primaryCrop: "cotton" } });
  assert.ok(!/\bsoil\b/i.test(q), q);
  assert.ok(q.includes("black"));
});

test("profile query maps acreage to the small/medium holding words schemes use", () => {
  assert.match(buildProfileQueryText({ land: { areaAcres: 1.5 } }), /small marginal holding/);
  assert.match(buildProfileQueryText({ land: { areaAcres: 6 } }), /medium larger holding/);
});

test("profile query leaves out districts and rupee amounts", () => {
  const q = buildProfileQueryText({
    land: { district: "Nashik" },
    loanApplication: { requestedAmount: 250000 },
  });
  assert.ok(!q.includes("Nashik"));
  assert.ok(!q.includes("250000"));
});

test("retrieval ranks the crop-insurance scheme first for an insurance question", () => {
  const top = retrieveSchemes("crop insurance premium for crop loss", 3);
  assert.equal(top[0].id, "pmfby");
  assert.ok(top.length > 0 && top.length <= 3);
  assert.ok(top[0].matchScore > 0);
});

test("retrieval returns nothing for a query with no corpus vocabulary", () => {
  assert.deepEqual(retrieveSchemes("zzzz qqqq", 3), []);
});

test("retrieval folds British/American spellings together", () => {
  const a = retrieveSchemes("fertiliser", 3).map((s) => s.id);
  const b = retrieveSchemes("fertilizer", 3).map((s) => s.id);
  assert.deepEqual(a, b);
});

// ---------- scope gate (keyword-decided cases only; no API call) ----------

test("scheme, loan and weather questions are in scope", async () => {
  for (const q of [
    "Am I eligible for PM-KISAN?",
    "How do I apply for a Kisan Credit Card loan?",
    "Will it rain this week?",
    "Who is eligible for crop insurance?", // contains 'who is' but the topic wins
  ]) {
    assert.equal(await isInScope(q), true, q);
  }
});

test("clearly off-topic questions are declined", async () => {
  for (const q of ["Tell me a joke", "Who is the prime minister?", "What is 5 multiplied by 6?", ""]) {
    assert.equal(await isInScope(q), false, q);
  }
});

// ---------- eligibility scoring ----------

test("scoring is deterministic and bounded", () => {
  const input = { areaAcres: 3, annualIncome: 200000, requestedAmount: 100000, existingLoans: 20000, creditHistoryOk: true };
  const a = scoreLoanEligibility(input);
  assert.deepEqual(a, scoreLoanEligibility(input));
  assert.ok(a.score >= 0 && a.score <= 1);
});

test("good credit history scores higher than bad, all else equal", () => {
  const base = { areaAcres: 3, annualIncome: 200000, requestedAmount: 100000, existingLoans: 20000 };
  const good = scoreLoanEligibility({ ...base, creditHistoryOk: true });
  const bad = scoreLoanEligibility({ ...base, creditHistoryOk: false });
  assert.ok(good.score > bad.score);
});

test("heavier debt lowers the score", () => {
  const base = { areaAcres: 3, annualIncome: 200000, creditHistoryOk: true, existingLoans: 0 };
  assert.ok(
    scoreLoanEligibility({ ...base, requestedAmount: 50000 }).score >
      scoreLoanEligibility({ ...base, requestedAmount: 900000 }).score
  );
});

test("status bands follow the score thresholds", () => {
  const { score, status } = scoreLoanEligibility({
    areaAcres: 2, annualIncome: 0, requestedAmount: 900000, existingLoans: 400000, creditHistoryOk: false,
  });
  assert.ok(score < 0.4);
  assert.equal(status, "not_eligible");
});

// ---------- scheme restriction checks ----------

test("crop lookup handles parentheticals, case and compound names", () => {
  assert.equal(lookupCrop("SUGARCANE")?.key, "sugarcane");
  assert.equal(lookupCrop("green gram (moong)")?.key, "green gram");
  assert.equal(lookupCrop("hybrid maize")?.key, "maize");
  assert.equal(lookupCrop("dragonfruit-xyz"), null);
  assert.equal(lookupCrop(undefined), null);
});

test("land limit: 4 acres is 1.62 ha, inside the 2 ha limit of both land-limited schemes", () => {
  for (const id of ["pm-kisan", "pm-kisan-maandhan"]) {
    const f = checkSchemeRestrictions(scheme(id), { areaAcres: 4 }).find((x) => x.type === "landHectares");
    assert.equal(f.verdict, "fits", id);
  }
});

test("10 acres (4.05 ha): PM-KISAN is UNCLEAR (soft limit), Maandhan FAILS (hard limit)", () => {
  const land = { areaAcres: 10 };
  const soft = checkSchemeRestrictions(scheme("pm-kisan"), land).find((x) => x.type === "landHectares");
  const hard = checkSchemeRestrictions(scheme("pm-kisan-maandhan"), land).find((x) => x.type === "landHectares");
  assert.equal(soft.verdict, "unclear");
  assert.equal(hard.verdict, "fails");
});

test("missing land area is UNCLEAR, never a guess", () => {
  const f = checkSchemeRestrictions(scheme("pm-kisan-maandhan"), {}).find((x) => x.type === "landHectares");
  assert.equal(f.verdict, "unclear");
});

test("crop duration: wheat fits PMFBY; sugarcane is UNCLEAR; unknown crop is UNCLEAR", () => {
  const verdict = (crop) =>
    checkSchemeRestrictions(scheme("pmfby"), { primaryCrop: crop }).find((x) => x.type === "cropDuration").verdict;
  assert.equal(verdict("wheat"), "fits");
  assert.equal(verdict("sugarcane"), "unclear");
  assert.equal(verdict("dragonfruit-xyz"), "unclear");
});

test("a scheme with no land or crop rule yields no findings", () => {
  assert.deepEqual(checkSchemeRestrictions(scheme("soil-health-card"), { areaAcres: 3 }), []);
});

// ---------- small helpers ----------

test("mandi summary averages modal prices and ignores missing ones", () => {
  assert.deepEqual(
    summarizeMandiRecords([{ modalPrice: 2000 }, { modalPrice: 3000 }, { modalPrice: null }]),
    { averageModalPrice: 2500, marketsReporting: 2 }
  );
  assert.deepEqual(summarizeMandiRecords([]), { averageModalPrice: null, marketsReporting: 0 });
});

test("audio type check accepts browser formats with codec params, rejects others", () => {
  assert.equal(isSupportedAudioType("audio/webm;codecs=opus"), true);
  assert.equal(isSupportedAudioType("audio/mp4"), true);
  assert.equal(isSupportedAudioType("application/json"), false);
  assert.equal(isSupportedAudioType(undefined), false);
});
