import test from "node:test";
import assert from "node:assert/strict";

import { keywordCategory, isInScope } from "../features/loanAssistant/services/questionScope.js";
import {
  retrieveSchemes,
  retrieveSchemesForQuestion,
  mentionsSchemeByName,
  MIN_QA_TOP_SCORE,
} from "../features/loanAssistant/services/schemeRetrieval.js";

// ---------- scope gate (keyword-decided only; no API call) ----------

test("scheme questions are 'scheme'", () => {
  for (const q of [
    "Am I eligible for PM-KISAN?",
    "What documents do I need for KCC?",
    "How do I get a Kisan Credit Card?",
    "What are the benefits of crop insurance?",
    "How do I apply for a loan?",
    "What is a soil health card?",
    "How do I get my soil tested?",
    "Who is eligible for crop insurance?", // contains 'who is' and 'crop'; topic wins
    "What subsidy is there for drip irrigation?", // agronomy word, but a scheme topic
  ]) {
    assert.equal(keywordCategory(q), "scheme", q);
  }
});

test("weather and mandi questions are recognised", () => {
  assert.equal(keywordCategory("Will it rain tomorrow?"), "weather");
  assert.equal(keywordCategory("What is the temperature today?"), "weather");
  assert.equal(keywordCategory("What is the mandi price of onion?"), "mandi");
  assert.equal(keywordCategory("What is the MSP for wheat?"), "mandi");
  assert.equal(keywordCategory("What is the price of wheat?"), "mandi");
});

test("broad farming words no longer pass automatically", () => {
  for (const q of [
    "Which fertilizer is best for cotton?",
    "How do I control pests in my tomato crop?",
    "How much water does rice need?",
    "Which seed variety is best for wheat?",
    "Tell me about soil types",
    "How to increase crop yield?",
    "What is the best time to sow soybean?",
  ]) {
    assert.equal(keywordCategory(q), "agronomy", q);
  }
});

test("a price question about an input is agronomy, not mandi", () => {
  assert.equal(keywordCategory("What is the price of fertilizer?"), "agronomy");
});

test("clearly off-topic questions are 'out', even if they mention crops", () => {
  assert.equal(keywordCategory("Tell me a joke"), "out");
  assert.equal(keywordCategory("Who is the prime minister?"), "out");
  assert.equal(keywordCategory("Write a poem about my crops"), "out");
  assert.equal(keywordCategory(""), "out");
});

test("isInScope: allowed topics true, agronomy and off-topic false", async () => {
  assert.equal(await isInScope("Will it rain tomorrow?"), true);
  assert.equal(await isInScope("What is the mandi price of onion?"), true);
  assert.equal(await isInScope("Am I eligible for PM-KISAN?"), true);
  assert.equal(await isInScope("Which fertilizer is best for cotton?"), false);
  assert.equal(await isInScope("Tell me a joke"), false);
});

// ---------- retrieval floor ----------

test("real scheme questions still return results", () => {
  for (const q of [
    "Am I eligible for PM-KISAN?",
    "What documents are needed for KCC?", // tops out at ~0.078; kept because it names a scheme
    "What does PMFBY cover?",
    "How do I get crop insurance?",
    "What is a soil health card?",
    "How much pension will I get at 60?",
    "What is the interest subvention scheme?",
  ]) {
    assert.ok(retrieveSchemesForQuestion(q, 3).length > 0, q);
  }
});

test("PM-KISAN is still returned for its own question (it ranks second, below the floor)", () => {
  const ids = retrieveSchemesForQuestion("Am I eligible for PM-KISAN?", 3).map((s) => s.id);
  assert.ok(ids.includes("pm-kisan"), ids.join(","));
});

test("weak matches with no scheme named are dropped", () => {
  for (const q of ["how much water does rice need", "what is the best time to sow soybean", "my plant leaves are turning yellow"]) {
    assert.deepEqual(retrieveSchemesForQuestion(q, 3), [], q);
  }
});

test("the floor applies to the best score only, not to each result", () => {
  const all = retrieveSchemes("Am I eligible for PM-KISAN?", 3);
  assert.ok(all[0].matchScore >= MIN_QA_TOP_SCORE);
  assert.ok(all.some((s) => s.matchScore < MIN_QA_TOP_SCORE), "expected a lower-scoring result to be kept");
  assert.equal(retrieveSchemesForQuestion("Am I eligible for PM-KISAN?", 3).length, all.length);
});

test("loan matching still uses unfiltered retrieval", () => {
  // Profile queries are long and score low by design; retrieveSchemes must not apply the floor.
  const weak = retrieveSchemes("how much water does rice need", 3);
  assert.ok(weak.length > 0);
});

test("scheme names and acronyms are detected, ordinary words are not", () => {
  assert.equal(mentionsSchemeByName("What documents are needed for KCC?"), true);
  assert.equal(mentionsSchemeByName("tell me about pm kisan"), true);
  assert.equal(mentionsSchemeByName("What is the Kisan Credit Card limit?"), true);
  assert.equal(mentionsSchemeByName("how much water does rice need"), false);
});
