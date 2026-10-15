import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { resolveCrop, cropMarketNames } from "../../../shared/crops.js";
import { ACRES_PER_HECTARE } from "../../../shared/units.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEME_RULES_PATH = path.join(__dirname, "..", "data", "schemeRules.json");
const SCHEME_RULES = JSON.parse(readFileSync(SCHEME_RULES_PATH, "utf-8"));

// Crop names are resolved by the shared crop module (shared/crops.js), the same one the
// irrigation advisory, mandi prices, crop plan and calendar use, so every feature agrees
// on what a farmer's "paddy" or "Brinjal (Eggplant)" is.
const lookupCrop = resolveCrop;

// ---------------------------------------------------------------------------
// Farmer profile
// ---------------------------------------------------------------------------

// Facts the farmer supplies about themselves. They are stored per farmer (see
// models/FarmerProfile.js); a rule whose input is missing reports "needs more
// info" instead of guessing.
const FARMER_FIELDS = [
  "age", "landTenure", "incomeTaxPayer", "governmentEmployee",
  "institutionalLandholder", "registeredProfessional", "coveredBySocialSecurity",
];
const BOOLEAN_FARMER_FIELDS = new Set([
  "incomeTaxPayer", "governmentEmployee", "institutionalLandholder",
  "registeredProfessional", "coveredBySocialSecurity",
]);
const LAND_TENURES = ["owner", "tenant", "sharecropper", "none"];

/**
 * Validates farmer-supplied facts. Returns { facts, rejected }: `facts` holds the
 * valid values (normalised), `rejected` the names of fields that were present but
 * invalid. Empty values (undefined, null, "") are simply absent, not rejected.
 */
export function sanitizeFarmerFacts(input) {
  const facts = {};
  const rejected = [];

  for (const field of FARMER_FIELDS) {
    const value = input?.[field];
    if (value === undefined || value === null || value === "") continue;

    if (BOOLEAN_FARMER_FIELDS.has(field)) {
      if (typeof value === "boolean") facts[field] = value;
      else rejected.push(field);
    } else if (field === "age") {
      const age = Number(value);
      if (Number.isFinite(age) && age > 0 && age < 130) facts.age = age;
      else rejected.push(field);
    } else {
      const tenure = String(value).trim().toLowerCase();
      if (LAND_TENURES.includes(tenure)) facts[field] = tenure;
      else rejected.push(field);
    }
  }
  return { facts, rejected };
}

export const FARMER_FACT_FIELDS = FARMER_FIELDS;

const hasSize = (plot) => Number.isFinite(Number(plot?.areaAcres)) && Number(plot.areaAcres) > 0;

/**
 * Flattens the farmer's land, any loan application and any farmer-supplied facts
 * into the flat object the rules read.
 *
 * Pass `lands` (ALL of the farmer's land records) wherever you have them: scheme
 * limits such as PM-KISAN's 2 hectares are on the family's total holding, not on
 * one plot, so `areaAcres` is the sum across plots. `land` alone (a single record)
 * is still accepted. The largest plot supplies state and primary crop, and
 * `crops` lists every distinct crop grown.
 *
 * Deliberately takes NOTHING from the loan's credit score or eligibility status:
 * whether a farmer qualifies for a scheme must not depend on how the lender's
 * model rated their creditworthiness.
 */
export function buildEligibilityProfile({ land, lands, loanApplication, farmer, verifiedFields } = {}) {
  const plots = Array.isArray(lands) && lands.length > 0 ? lands : land ? [land] : [];
  const sized = plots.filter(hasSize);
  const largest = [...(sized.length > 0 ? sized : plots)].sort((a, b) => Number(b?.areaAcres || 0) - Number(a?.areaAcres || 0))[0];

  const seen = new Set();
  const crops = [];
  for (const plot of plots) {
    const crop = String(plot?.primaryCrop ?? "").trim();
    if (crop && !seen.has(crop.toLowerCase())) {
      seen.add(crop.toLowerCase());
      crops.push(crop);
    }
  }

  return {
    areaAcres: sized.length > 0 ? Math.round(sized.reduce((sum, p) => sum + Number(p.areaAcres), 0) * 100) / 100 : undefined,
    plotCount: plots.length,
    state: largest?.state,
    primaryCrop: largest?.primaryCrop,
    crops,
    purpose: loanApplication?.purpose,
    requestedAmount: loanApplication?.requestedAmount,
    ...sanitizeFarmerFacts(farmer).facts,
    // Which of the facts above an admin has checked against documents. Everything else
    // the farmer told us is self-declared.
    verifiedFields: Array.isArray(verifiedFields) ? verifiedFields : [],
  };
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

const fieldLabel = (field) => SCHEME_RULES.fields[field] || field;

const fill = (template, vars) =>
  String(template ?? "").replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined || vars[key] === null ? "" : String(vars[key])));

const isMissing = (v) => v === undefined || v === null || v === "";

// Each evaluator returns { status: "pass" | "fail" | "unknown", vars, missing? }.
// `missing` names the input a farmer would need to supply.
const EVALUATORS = {
  landHectares(rule, p) {
    const acres = Number(p.areaAcres);
    if (!Number.isFinite(acres) || acres <= 0) return { status: "unknown", vars: { max: rule.max }, missing: fieldLabel("areaAcres") };
    const hectares = acres / ACRES_PER_HECTARE;
    // "6 acres across 2 plots" when the total is made of several records.
    const holding = p.plotCount > 1 ? `${acres} acres across ${p.plotCount} plots` : `${acres} acres`;
    return {
      status: hectares <= rule.max ? "pass" : "fail",
      vars: { acres, hectares: hectares.toFixed(2), max: rule.max, holding },
    };
  },

  // With several crops the scheme applies if ANY of them is covered: it insures per
  // crop, so one covered crop is enough to make the scheme relevant.
  cropDuration(rule, p) {
    const names = p.crops?.length > 0 ? p.crops : p.primaryCrop ? [p.primaryCrop] : [];
    const vars = { crop: names.join(", ") || "not recorded", allowed: rule.allowed.join("/") };

    const known = names.map((name) => ({ name, crop: lookupCrop(name) })).filter((x) => x.crop);
    if (known.length === 0) return { status: "unknown", vars, missing: fieldLabel("primaryCrop") };

    const covered = known.filter((x) => rule.allowed.includes(x.crop.duration));
    const shown = covered.length > 0 ? covered : known;
    const uniq = (values) => [...new Set(values)].join("/");
    Object.assign(vars, {
      crop: shown.map((x) => x.name).join(", "),
      duration: uniq(shown.map((x) => x.crop.duration)),
      category: uniq(shown.map((x) => x.crop.category)),
    });
    return { status: covered.length > 0 ? "pass" : "fail", vars };
  },

  ageRange(rule, p) {
    if (isMissing(p.age)) return { status: "unknown", vars: { min: rule.min, max: rule.max }, missing: fieldLabel("age") };
    return {
      status: p.age >= rule.min && p.age <= rule.max ? "pass" : "fail",
      vars: { age: p.age, min: rule.min, max: rule.max },
    };
  },

  oneOf(rule, p) {
    const value = p[rule.field];
    if (isMissing(value)) return { status: "unknown", vars: {}, missing: fieldLabel(rule.field) };
    return { status: rule.allowed.includes(value) ? "pass" : "fail", vars: { value } };
  },

  flagFalse(rule, p) {
    const value = p[rule.field];
    if (typeof value !== "boolean") return { status: "unknown", vars: {}, missing: fieldLabel(rule.field) };
    return { status: value ? "fail" : "pass", vars: {} };
  },

  purposeKeywords(rule, p) {
    const purpose = String(p.purpose ?? "").trim();
    if (!purpose) return { status: "unknown", vars: {}, missing: fieldLabel("purpose") };
    const text = purpose.toLowerCase();
    return { status: rule.keywords.some((k) => text.includes(k)) ? "pass" : "fail", vars: { value: purpose } };
  },

  positive(rule, p) {
    const n = Number(p[rule.field]);
    if (isMissing(p[rule.field])) return { status: "unknown", vars: {}, missing: fieldLabel(rule.field) };
    return { status: Number.isFinite(n) && n > 0 ? "pass" : "fail", vars: { acres: n } };
  },
};

// The farmer-declared facts a rule reads. Land size and crop come from land records,
// not from "About you", so those rules list none.
const FACTS_USED = {
  ageRange: () => ["age"],
  oneOf: (rule) => [rule.field],
  flagFalse: (rule) => [rule.field],
};

/** Evaluates one rule. Returns { id, type, status, hard, message, missing, facts }. */
function evaluateRule(rule, profile) {
  const evaluator = EVALUATORS[rule.type];
  if (!evaluator) throw new Error(`Unknown rule type "${rule.type}" (rule "${rule.id}")`);

  const { status, vars, missing } = evaluator(rule, profile);
  const template =
    status === "pass" ? rule.pass : status === "fail" ? rule.fail : rule.unknown ?? `Need to confirm ${missing}.`;

  return {
    id: rule.id,
    type: rule.type,
    status,
    hard: Boolean(rule.hard),
    message: fill(template, vars),
    missing,
    facts: FACTS_USED[rule.type]?.(rule) ?? [],
  };
}

/**
 * How firm is a verdict? "verified" if every declared fact it rests on has been checked
 * by an admin, "self_declared" if any of them is only the farmer's word, and
 * "land_records" if it rests on no declared fact at all (e.g. a hard land-size limit).
 * Only checks that actually decided something count; an unanswered rule relies on nothing.
 */
function describeBasis(decidingChecks, profile) {
  const used = [...new Set(decidingChecks.flatMap((c) => c.facts))];
  const selfDeclared = used.filter((f) => !(profile?.verifiedFields || []).includes(f));
  const basis = used.length === 0 ? "land_records" : selfDeclared.length > 0 ? "self_declared" : "verified";
  return { basis, selfDeclared };
}

const rulesFor = (schemeId) => SCHEME_RULES.schemes[schemeId]?.rules || [];

/**
 * Decides eligibility for one scheme from the rules in data/schemeRules.json.
 *
 * Returns { schemeId, verdict, reason, checks } where verdict is:
 *   "eligible"        every rule passed
 *   "not_eligible"    a hard rule failed (an exclusion applies, or a hard limit is exceeded)
 *   "needs_more_info" nothing hard failed, but a rule's input is missing, or a
 *                     soft limit (one that varies by state/season) was exceeded
 * `reason` is one line; `checks` holds the individual rule results.
 */
export function evaluateSchemeEligibility(scheme, profile) {
  const config = SCHEME_RULES.schemes[scheme?.id];
  if (!config) {
    return {
      schemeId: scheme?.id,
      verdict: "needs_more_info",
      reason: "No eligibility rules are defined for this scheme yet; please check with your local agriculture office.",
      checks: [],
      basis: "land_records",
      selfDeclared: [],
    };
  }

  const checks = config.rules.map((rule) => evaluateRule(rule, profile));

  // A hard failure decides it, even if other inputs are still missing.
  const hardFail = checks.find((c) => c.status === "fail" && c.hard);
  if (hardFail) return { schemeId: scheme.id, verdict: "not_eligible", reason: hardFail.message, checks, ...describeBasis([hardFail], profile) };

  const softFail = checks.find((c) => c.status === "fail");
  const unknowns = checks.filter((c) => c.status === "unknown");
  if (softFail || unknowns.length > 0) {
    let reason;
    if (softFail) {
      reason = softFail.message;
    } else {
      const needed = [...new Set(unknowns.map((c) => c.missing).filter(Boolean))];
      reason = needed.length
        ? `Need to confirm: ${needed.slice(0, 3).join("; ")}${needed.length > 3 ? ` (and ${needed.length - 3} more)` : ""}.`
        : unknowns[0].message;
    }
    return { schemeId: scheme.id, verdict: "needs_more_info", reason, checks, ...describeBasis(checks.filter((c) => c.status !== "unknown"), profile) };
  }

  return { schemeId: scheme.id, verdict: "eligible", reason: config.eligibleReason, checks, ...describeBasis(checks, profile) };
}

/** evaluateSchemeEligibility for a list of schemes. */
export function evaluateAllSchemes(schemes, profile) {
  return schemes.map((scheme) => evaluateSchemeEligibility(scheme, profile));
}

// ---------------------------------------------------------------------------
// Land / crop findings used in the generation prompts
// ---------------------------------------------------------------------------

// Only checks derived from the land record are fed to the answer prompts. The
// others depend on facts (age, tax status) we do not hold, and listing them as
// "unclear" in every prompt would just add noise to the answer.
const LAND_CROP_TYPES = new Set(["landHectares", "cropDuration"]);

/**
 * Evaluates a scheme's land-size and crop-type rules against a land record.
 *
 * Returns an array of findings, each { type, verdict, message }, where verdict is:
 *   "fits"    — the profile clearly satisfies the rule
 *   "unclear" — cannot be determined from available data, or genuinely varies
 *               by state/season (say so rather than guessing either way)
 *   "fails"   — the profile clearly falls outside a hard rule
 *
 * This runs BEFORE the LLM so crop-type and land-size conclusions are computed
 * deterministically instead of depending on the model reading the eligibility
 * prose correctly, which it only did about half the time.
 */
export function checkSchemeRestrictions(scheme, land) {
  const profile = buildEligibilityProfile({ land });
  return rulesFor(scheme?.id)
    .filter((rule) => LAND_CROP_TYPES.has(rule.type))
    .map((rule) => {
      const check = evaluateRule(rule, profile);
      const verdict = check.status === "pass" ? "fits" : check.status === "fail" && check.hard ? "fails" : "unclear";
      return { type: check.type, verdict, message: check.message };
    });
}

const VERDICT_LABELS = { eligible: "ELIGIBLE", not_eligible: "NOT ELIGIBLE", needs_more_info: "NEEDS MORE INFO" };

/**
 * Renders each retrieved scheme's deterministic verdict into a prompt block the
 * LLM is told to treat as authoritative. The verdicts come from the same rules
 * (data/schemeRules.json) that produce `eligibility` in the API response, so what
 * the farmer reads and what the screen shows cannot disagree.
 */
export function buildEligibilityFactsBlock(retrievedSchemes, profile) {
  if (!retrievedSchemes?.length) return "";

  const lines = retrievedSchemes.map((scheme) => {
    const e = evaluateSchemeEligibility(scheme, profile);
    const caveat = e.basis === "self_declared" ? " [based on details the farmer entered themselves, not yet verified]" : "";
    return `- ${scheme.name} (id: ${scheme.id}): ${VERDICT_LABELS[e.verdict]} - ${e.reason}${caveat}`;
  });

  return `VERIFIED ELIGIBILITY (computed from the farmer's record - treat as authoritative and do NOT contradict):
${lines.join("\n")}`;
}

export { lookupCrop };
