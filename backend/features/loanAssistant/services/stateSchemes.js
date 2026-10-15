// State government schemes (data/stateSchemes.json), kept apart from the central ones.
//
// The file is empty for every state today, by design: see its _comment. This module is the
// structure that lets them be added later without touching code: it validates them, tags them
// with their state, and decides who may see them.

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isValidCheckDate, isSafeSourceUrl } from "./schemeFreshness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STATE_SCHEMES_PATH = path.join(__dirname, "..", "data", "stateSchemes.json");

const REQUIRED_TEXT = ["id", "name", "category", "description"];
const REQUIRED_LISTS = ["eligibilityCriteria", "requiredDocuments", "tags", "applicability"];

const norm = (s) => String(s ?? "").trim().toLowerCase();

/**
 * Checks one scheme entry. Returns a list of problems (empty if it is fine).
 * Strict on purpose: a state scheme is only worth showing if it can say where it came from.
 */
function problemsWith(scheme) {
  const problems = [];
  for (const f of REQUIRED_TEXT) if (typeof scheme?.[f] !== "string" || !scheme[f].trim()) problems.push(`missing "${f}"`);
  for (const f of REQUIRED_LISTS) if (!Array.isArray(scheme?.[f]) || scheme[f].length === 0) problems.push(`"${f}" must be a non-empty list`);

  const fresh = scheme?.freshness;
  if (!fresh || typeof fresh !== "object") {
    problems.push('missing "freshness"');
  } else {
    if (!isSafeSourceUrl(fresh.sourceUrl)) problems.push("freshness.sourceUrl must be the official https page");
    if (!isValidCheckDate(fresh.lastVerified)) problems.push("freshness.lastVerified must be the date you checked it (YYYY-MM-DD, not in the future)");
    if (!fresh.benefitAmount?.summary) problems.push("freshness.benefitAmount.summary is required");
  }
  return problems;
}

/**
 * @param {object} file         the parsed stateSchemes.json
 * @param {string[]} takenIds   ids already used (the central schemes)
 * @returns {{ schemes: object[], errors: string[] }}  valid schemes tagged { level: "state", state }, and what was wrong with the rest
 */
export function validateStateSchemes(file, takenIds = []) {
  const schemes = [];
  const errors = [];
  const ids = new Set(takenIds);

  for (const [state, block] of Object.entries(file ?? {})) {
    if (state.startsWith("_")) continue; // _comment, _template
    for (const scheme of block?.schemes ?? []) {
      const label = `${state} / ${scheme?.id ?? scheme?.name ?? "(unnamed)"}`;
      const problems = problemsWith(scheme);
      if (scheme?.id && ids.has(scheme.id)) problems.push(`id "${scheme.id}" is already used`);
      if (problems.length > 0) {
        errors.push(`${label}: ${problems.join("; ")}`);
        continue;
      }
      ids.add(scheme.id);
      schemes.push({ ...scheme, level: "state", state });
    }
  }
  return { schemes, errors };
}

/** Loads the state schemes. Invalid entries are skipped and reported loudly; a missing file means none. */
export function loadStateSchemes(filePath = STATE_SCHEMES_PATH, takenIds = []) {
  if (!existsSync(filePath)) return [];
  let file;
  try {
    file = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(`❌ stateSchemes.json could not be read (${err.message}); no state schemes are loaded.`);
    return [];
  }
  const { schemes, errors } = validateStateSchemes(file, takenIds);
  for (const e of errors) console.error(`❌ State scheme skipped: ${e}`);
  return schemes;
}

/**
 * The schemes a farmer may see: every central scheme, plus the state schemes for the states their
 * land is in (compared ignoring case and spaces). With no states given, state schemes are left out.
 */
export function schemesVisibleFor(schemes, states = []) {
  const wanted = new Set((states ?? []).map(norm));
  return schemes.filter((s) => !s.state || wanted.has(norm(s.state)));
}
