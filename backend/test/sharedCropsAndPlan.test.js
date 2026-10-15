import test from "node:test";
import assert from "node:assert/strict";

import { parseQuantity } from "../shared/quantity.js";
import { toAcres, acresToHectares, hectaresToAcres, ACRES_PER_HECTARE } from "../shared/units.js";
import { resolveCrop, listCrops, getCrop, irrigationProfile } from "../shared/crops.js";
import { lookupCrop as irrigationLookup } from "../features/loanAssistant/services/irrigationService.js";
import { lookupCrop as eligibilityLookup } from "../features/loanAssistant/services/schemeEligibilityChecks.js";
import { commodityCandidates } from "../features/loanAssistant/services/mandiCommodity.js";
import { buildCropPlan, isSameCrop, usdToInrRate, DEFAULT_USD_TO_INR } from "../services/cropPlan.js";
import { cropPlanRules } from "../recommendationData.js";

// ---------- quantity parsing ----------

test("a single number keeps working", () => {
  assert.deepEqual(parseQuantity("50 kg/hectare"), { min: 50, max: 50, avg: 50, isRange: false, basis: "hectare" });
  assert.equal(parseQuantity("200 grams/hectare (Prevention)").avg, 200);
  assert.equal(parseQuantity("1.5 liters/hectare").avg, 1.5);
});

test("a range is a range: '50-60 kg' is 55 on average, not 50", () => {
  for (const text of ["50-60 kg/hectare", "50 - 60 kg/ha", "50 to 60 kg/hectare", "50–60 kg/hectare", "50—60 kg/hectare"]) {
    const q = parseQuantity(text);
    assert.deepEqual([q.min, q.max, q.avg, q.isRange], [50, 60, 55, true], text);
  }
  assert.deepEqual([parseQuantity("60-50 kg").min, parseQuantity("60-50 kg").max], [50, 60]); // written backwards
});

test("what the rate is per is read, including per tree and per plant", () => {
  assert.equal(parseQuantity("2 kg/tree").basis, "tree");
  assert.equal(parseQuantity("250 grams/plant").basis, "plant");
  assert.equal(parseQuantity("40 kg per acre").basis, "acre");
  assert.equal(parseQuantity("40 kg/ha").basis, "hectare");
  assert.equal(parseQuantity("40 kg").basis, null);
});

test("thousands separators, and text with no number", () => {
  assert.equal(parseQuantity("1,200 kg/hectare").avg, 1200);
  for (const nothing of ["N/A", "n/a", "NA", "", "  ", null, undefined, "apply gently", "-"]) assert.equal(parseQuantity(nothing), null, String(nothing));
});

test("every quantity string in the crop-plan data parses, with a stated basis", () => {
  for (const rec of cropPlanRules) {
    const text = rec.fertilizer_quantity || rec.application_rate;
    if (!text || /^n\/?a$/i.test(text)) continue;
    const q = parseQuantity(text);
    assert.ok(q && q.avg > 0 && q.basis, `${rec.crop_name}: ${text}`);
  }
});

// ---------- units ----------

test("acres are the unit; hectares only at the edge", () => {
  assert.ok(Math.abs(hectaresToAcres(1) - 2.47105) < 1e-9);
  assert.ok(Math.abs(acresToHectares(2.47105) - 1) < 1e-9);
  assert.equal(toAcres(3), 3);
  assert.equal(toAcres(3, "acres"), 3);
  assert.ok(Math.abs(toAcres(1, "hectares") - ACRES_PER_HECTARE) < 1e-9);
  assert.ok(Number.isNaN(toAcres("abc")));
});

// ---------- the shared crop list ----------

test("every feature resolves a crop name the same way", () => {
  for (const typed of ["Brinjal (Eggplant)", "paddy", "Bt cotton", "green gram (moong)", "baingan", "SUGARCANE"]) {
    const key = resolveCrop(typed)?.key;
    assert.ok(key, typed);
    assert.equal(eligibilityLookup(typed)?.key, key, `eligibility: ${typed}`);
    assert.equal(commodityCandidates(typed).includes(key.replace(/\b\w/g, (c) => c.toUpperCase())), true, `mandi: ${typed}`);
  }
});

test("whole words only: licorice is not rice, 'hybrid green gram' is not chickpea", () => {
  assert.equal(resolveCrop("licorice"), null);
  assert.equal(resolveCrop("hybrid green gram").key, "green gram");
  assert.equal(resolveCrop("gram").key, "chickpea");
  assert.equal(resolveCrop("pigeon pea").key, "pigeon pea");
});

test("the crop list is complete and self-consistent", () => {
  const crops = listCrops();
  assert.ok(crops.length >= 50);
  for (const c of crops) {
    assert.ok(["annual", "long-duration", "perennial"].includes(c.duration), c.key);
    assert.equal(getCrop(c.key).key, c.key);
    for (const alias of c.aliases) assert.equal(resolveCrop(alias).key, c.key, `${alias} -> ${c.key}`);
  }
  assert.equal(new Set(crops.map((c) => c.key)).size, crops.length);
  assert.equal(crops.find((c) => c.key === "wheat").typicalGrowDays, 130);
  assert.equal(crops.find((c) => c.key === "brinjal").typicalGrowDays, null);
});

// ---------- irrigation uses it: no more name.includes(key) ----------

test("irrigation: aliases find the crop, substrings do not", () => {
  assert.equal(irrigationLookup("paddy").key, "rice");
  assert.equal(irrigationLookup("Rice").kc[1], 1.2);
  assert.equal(irrigationLookup("SUGARCANE").totalDays, 300);
  assert.equal(irrigationLookup("licorice").key, "unknown"); // used to match "rice" via includes()
  assert.equal(irrigationLookup("Brinjal").key, "unknown"); // no irrigation data: generic default, as before
  assert.equal(irrigationLookup(undefined).key, "unknown");
  assert.deepEqual(irrigationLookup("brinjal").kc, [0.5, 1.05, 0.7]);
});

test("irrigation numbers moved over unchanged", () => {
  assert.deepEqual(irrigationProfile("cotton"), { kc: [0.35, 1.18, 0.6], totalDays: 160, rootDepthM: 1.2 });
  assert.deepEqual(irrigationProfile("potato"), { kc: [0.5, 1.15, 0.75], totalDays: 100, rootDepthM: 0.4 });
  assert.equal(irrigationLookup("gram").key, "chickpea"); // the old separate "gram" entry was a duplicate of chickpea
});

// ---------- the crop plan ----------

const row = (extra) => ({ crop_name: "Tomato", soil_type: "Loamy", cultivation_method: "Conventional", ...extra });
const fert = (qty, price, unit = "kg") => row({ growth_stage: "Basal", fertilizer_type: "DAP", fertilizer_quantity: qty, unit_of_measure: unit, estimated_unit_price_usd: price });
const pest = (rate, price, unit = "gram") => row({ pest_name: "Blight", management_type: "Chemical", input_recommendation: "Mancozeb", application_rate: rate, unit_of_measure: unit, estimated_unit_price_usd: price });

test("acres in, per-hectare data converted: 2.47105 acres is exactly one hectare of input", () => {
  const plan = buildCropPlan([fert("50 kg/hectare", 1)], { acres: 2.47105, rate: 80 });
  const item = plan.fertilizer[0];
  assert.equal(item.totalQuantityNeeded, "50.00");
  assert.equal(plan.landAcres, "2.47");
  assert.equal(plan.landHectares, "1.00");
  assert.equal(item.estimatedCost, "50.00"); // USD
  assert.equal(item.estimatedCostINR, "4000.00"); // x 80
  assert.equal(plan.totalCostINR, "4000.00");
  assert.equal(plan.currency, "INR");
  assert.equal(plan.exchangeRate.usdToInr, 80);
});

test("the rate is also given per acre, since that is the farmer's unit", () => {
  const item = buildCropPlan([fert("50 kg/hectare", 1)], { acres: 1, rate: 80 }).fertilizer[0];
  assert.equal(item.quantityPerAcre, "20.23 kg/acre");
  assert.equal(item.totalQuantityNeeded, "20.23");
});

test("a range is priced on its average and both ends are reported", () => {
  const plan = buildCropPlan([fert("50-60 kg/hectare", 2)], { acres: 2.47105, rate: 80 });
  const item = plan.fertilizer[0];
  assert.equal(item.totalQuantityNeeded, "55.00"); // not 50
  assert.deepEqual(item.quantityRange, { min: "50.00", max: "60.00" });
  assert.equal(item.estimatedCost, "110.00");
  assert.equal(item.quantityPerAcre, "20.23–24.28 kg/acre");
});

test("per-tree and per-plant rates are NOT multiplied by land area and stay out of the total", () => {
  const rows = [fert("50 kg/hectare", 1), fert("2 kg/tree", 3), pest("250 grams/plant", 0.02)];
  const plan = buildCropPlan(rows, { acres: 10, rate: 80 });
  const [perHectare, perTree] = plan.fertilizer;
  assert.equal(perTree.totalQuantityNeeded, null);
  assert.equal(perTree.estimatedCostINR, null);
  assert.equal(perTree.includedInTotal, false);
  assert.equal(perTree.costPerPlantINR, "480.00"); // 2 kg x $3 x 80
  assert.match(perTree.note, /per tree/);
  assert.equal(plan.pestsAndDiseases[0].costPerPlantINR, "400.00");
  assert.equal(plan.itemsNotInTotal, 2);
  assert.equal(plan.totalCostINR, ((10 / 2.47105) * 50 * 80).toFixed(2)); // only the per-hectare item
  assert.equal(perHectare.includedInTotal, true);
});

test("a row with no quantity is reported, not priced as zero or NaN", () => {
  const item = buildCropPlan([fert("N/A", 1)], { acres: 1, rate: 80 }).fertilizer[0];
  assert.equal(item.totalQuantityNeeded, null);
  assert.match(item.note, /No quantity/);
});

test("the exchange rate is configurable and defaults to the old hardcoded one", () => {
  assert.equal(usdToInrRate({}), DEFAULT_USD_TO_INR);
  assert.equal(usdToInrRate({ USD_TO_INR: "88.25" }), 88.25);
  assert.equal(usdToInrRate({ USD_TO_INR: "abc" }), DEFAULT_USD_TO_INR);
  assert.equal(usdToInrRate({ USD_TO_INR: "-3" }), DEFAULT_USD_TO_INR);
});

test("a plan stored under 'Brinjal (Eggplant)' is found for 'baingan'; different crops are not confused", () => {
  assert.equal(isSameCrop("Brinjal (Eggplant)", "baingan"), true);
  assert.equal(isSameCrop("Rice", "paddy"), true);
  assert.equal(isSameCrop("Maize (Corn)", "Maize"), true);
  assert.equal(isSameCrop("Rice", "Wheat"), false);
  assert.equal(isSameCrop("Rice", "licorice"), false);
  assert.equal(isSameCrop("Mystery Crop", "mystery crop"), true); // unknown to us: falls back to plain comparison
  assert.equal(isSameCrop("Mystery Crop", "Other"), false);
});

test("the real data builds a plan with no NaN anywhere", () => {
  for (const crop of new Set(cropPlanRules.map((r) => r.crop_name))) {
    const rows = cropPlanRules.filter((r) => r.crop_name === crop);
    const plan = buildCropPlan(rows, { acres: 3 });
    const text = JSON.stringify(plan);
    assert.ok(!/NaN|undefined|Infinity/.test(text), crop);
    assert.ok(Number(plan.totalCostINR) >= 0, crop);
  }
});
