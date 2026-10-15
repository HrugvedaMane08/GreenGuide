// What still has to be checked by a person against official sources.
//
//   npm run corpus:todo            print the checklist
//   npm run corpus:todo -- --check exit with an error while anything is unchecked (for a release gate)
//
// Built from the data files themselves, so it cannot drift out of date: when you fill in a scheme's
// sourceUrl / lastVerified and clear its `todo`, it drops off this list.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { freshnessOf } from "../features/loanAssistant/services/schemeFreshness.js";
import { loadStateSchemes, validateStateSchemes, STATE_SCHEMES_PATH } from "../features/loanAssistant/services/stateSchemes.js";
import { THRESHOLDS } from "../services/weatherAlerts.js";
import { DEFAULT_USD_TO_INR } from "../services/cropPlan.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "features", "loanAssistant", "data");
const schemes = JSON.parse(readFileSync(path.join(dir, "schemes.json"), "utf-8"));
const { schemes: ruleSets } = JSON.parse(readFileSync(path.join(dir, "schemeRules.json"), "utf-8"));

const describeRule = (r) => {
  const strength = r.hard ? "hard" : "soft";
  switch (r.type) {
    case "landHectares": return `land limit: up to ${r.max} hectares (${strength})`;
    case "ageRange": return `age: ${r.min} to ${r.max} (${strength})`;
    case "oneOf": return `land tenure must be ${r.allowed.join(" / ")} (${strength})`;
    case "flagFalse": return `exclusion: "${r.field}" (${strength})`;
    case "cropDuration": return `crop types covered: ${r.allowed.join(" / ")} (${strength})`;
    case "purposeKeywords": return `loan purpose must mention one of: ${r.keywords.slice(0, 8).join(", ")}${r.keywords.length > 8 ? ", ..." : ""} (${strength})`;
    case "positive": return `must hold land (${strength})`;
    default: return `${r.type} (${strength})`;
  }
};

let open = 0;
const line = (s = "") => console.log(s);

line("WHAT STILL NEEDS A HUMAN CHECK AGAINST OFFICIAL SOURCES");
line("=====================================================\n");

line("1. SCHEME DETAILS (data/schemes.json)");
line("   For each scheme: find the official page, then set freshness.sourceUrl and freshness.lastVerified,");
line("   fix anything below that differs, and delete the to-do lines you have dealt with.\n");
for (const s of schemes) {
  const f = freshnessOf(s);
  const todo = s.freshness?.todo ?? ["freshness block missing"];
  open += todo.length;
  line(`   ${s.name}   [${s.id}]`);
  line(`     source URL:     ${f.sourceUrl ?? "NOT SET"}`);
  line(`     last verified:  ${f.lastVerified ?? "NEVER"}`);
  line(`     our figures:    ${s.freshness?.benefitAmount?.summary ?? "(none recorded)"}`);
  for (const t of todo) line(`     [ ] ${t}`);
  line();
}

line("2. ELIGIBILITY RULES (data/schemeRules.json)");
line("   Written from the same notes, so check them against the official guidelines too. Every number below");
line("   decides whether a farmer is told 'eligible' or 'not eligible'.\n");
for (const s of schemes) {
  const rules = ruleSets[s.id]?.rules ?? [];
  open += rules.length;
  line(`   ${s.id}`);
  for (const r of rules) line(`     [ ] ${describeRule(r)}`);
  if (rules.length === 0) line("     (no rules)");
}
line();

line("3. VALUES THAT ARE THIS PROJECT'S OWN, NOT OFFICIAL");
const own = [
  `USD to INR rate for the crop-plan page: ${DEFAULT_USD_TO_INR} is a stale default. Set USD_TO_INR in backend/.env to today's rate.`,
  "The crop-plan input prices are USD estimates written by hand in recommendationData.js; confirm or replace them with real local prices.",
  "Market-price feed (AGMARKNET) commodity names in shared/crops.json 'mandiNames': written from memory, never checked against the live feed.",
  `Weather alert thresholds (services/weatherAlerts.js): rain ${THRESHOLDS.rainMmPerHour} mm/h, frost below ${THRESHOLDS.frostBelowC}°C, wind above ${THRESHOLDS.windAboveMs} m/s, heat above ${THRESHOLDS.heatAboveC}°C. These are tuning choices; confirm they suit your area.`,
  "Crop cycle lengths and irrigation coefficients in shared/crops.json 'irrigation': FAO-56 style approximations, not field-calibrated.",
];
for (const t of own) { line(`   [ ] ${t}`); open += 1; }
line();

line("4. STATE SCHEMES (data/stateSchemes.json)");
const file = JSON.parse(readFileSync(STATE_SCHEMES_PATH, "utf-8"));
const { errors } = validateStateSchemes(file, schemes.map((s) => s.id));
const loaded = loadStateSchemes(STATE_SCHEMES_PATH, schemes.map((s) => s.id));
const states = Object.keys(file).filter((k) => !k.startsWith("_"));
for (const st of states) line(`   ${st}: ${loaded.filter((s) => s.state === st).length} scheme(s) loaded`);
if (loaded.length === 0) { line("   [ ] No state scheme has been added yet. Add them from the state's official pages (see the file's _comment)."); open += 1; }
for (const e of errors) { line(`   [!] SKIPPED, fix: ${e}`); open += 1; }
line();

line(open === 0 ? "Nothing is waiting for a check." : `${open} item(s) waiting for a check.`);
if (process.argv.includes("--check") && open > 0) process.exitCode = 1;
