import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { loadStateSchemes, schemesVisibleFor } from "./stateSchemes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMES_PATH = path.join(__dirname, "..", "data", "schemes.json");

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "for", "on", "with",
  "is", "are", "as", "at", "by", "from", "this", "that", "it", "be",
  "up", "per", "farmer", "farmers"
]);

// British/American spellings that appear in both the corpus and farmer queries.
// Without folding these, "fertilizer" and "fertiliser" are unrelated terms and
// a query silently misses the documents that used the other spelling.
const SPELLING_VARIANTS = {
  fertiliser: "fertilizer",
  fertilisers: "fertilizer",
  fertilizers: "fertilizer",
  subsidised: "subsidized",
  organised: "organized",
  labour: "labor"
};

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => SPELLING_VARIANTS[t] || t);
}

function schemeToText(scheme) {
  return [
    scheme.name,
    scheme.description,
    ...(scheme.eligibilityCriteria || []),
    ...(scheme.tags || []),
    // Retrieval-only vocabulary describing which farm situations a scheme
    // suits. The prose fields never mention crops, irrigation types or holding
    // sizes, so without this a profile query has almost nothing to match on.
    // Not shown to farmers and not part of the generation prompts.
    ...(scheme.applicability || [])
  ].join(" ");
}

function termFrequency(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const len = tokens.length || 1;
  for (const t in tf) tf[t] = tf[t] / len;
  return tf;
}

function buildIndex() {
  const central = JSON.parse(readFileSync(SCHEMES_PATH, "utf-8"));
  // State schemes (data/stateSchemes.json) are indexed with the central ones and filtered by the
  // farmer's state at query time; with the file empty this is exactly the central corpus.
  return buildIndexFrom([...central, ...loadStateSchemes(undefined, central.map((s) => s.id))]);
}

/** Builds the TF-IDF index over a list of schemes (exported so tests can index their own). */
export function buildIndexFrom(schemes) {
  const docsTokens = schemes.map((s) => tokenize(schemeToText(s)));

  // document frequency per term
  const df = {};
  for (const tokens of docsTokens) {
    const seen = new Set(tokens);
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }

  const N = schemes.length;
  const idf = {};
  for (const t in df) {
    idf[t] = Math.log((N + 1) / (df[t] + 1)) + 1; // smoothed idf
  }

  const docVectors = docsTokens.map((tokens) => {
    const tf = termFrequency(tokens);
    const vec = {};
    for (const t in tf) vec[t] = tf[t] * (idf[t] || 0);
    return vec;
  });

  return { schemes, docVectors, idf };
}

// Build once and cache in memory (corpus is small/static; restart process to pick up data changes)
let cachedIndex = null;
function getIndex() {
  if (!cachedIndex) cachedIndex = buildIndex();
  return cachedIndex;
}

function vectorize(text, idf) {
  const tokens = tokenize(text);
  const tf = termFrequency(tokens);
  const vec = {};
  for (const t in tf) {
    if (idf[t]) vec[t] = tf[t] * idf[t];
  }
  return vec;
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const t in vecA) {
    normA += vecA[t] * vecA[t];
    if (vecB[t]) dot += vecA[t] * vecB[t];
  }
  for (const t in vecB) normB += vecB[t] * vecB[t];
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Build a plain-text profile query from a farmer's land + loan application data.
 *
 * Only emits terms that can actually match scheme vocabulary. Raw identifiers
 * (district names, rupee amounts) are left out: they appear in no scheme, so
 * they contribute nothing to the score while inflating the query vector and
 * diluting the terms that do matter.
 *
 * Holding size is turned into the words schemes actually use ("small marginal
 * holding") rather than passed through as a number of acres.
 */
export function buildProfileQueryText({ land, lands, loanApplication }) {
  const parts = [];

  // All of the farmer's plots when given (a farmer's schemes depend on their whole
  // holding), otherwise the single record. Distinct values only, so a crop grown on
  // three plots doesn't triple its weight in the query.
  const plots = Array.isArray(lands) && lands.length > 0 ? lands : land ? [land] : [];
  const distinct = (values) => [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];

  parts.push(...distinct(plots.map((p) => p.primaryCrop)));
  parts.push(...distinct(plots.map((p) => p.state)));

  // "<type> soil" put the word "soil" in every single query, which handed the
  // Soil Health Card scheme (the only doc where "soil" is frequent) the top
  // rank for practically every farmer. Keep the soil type, drop the noun --
  // including when the farmer typed it themselves ("black soil"), which real
  // records in the database do.
  for (const soilType of distinct(plots.map((p) => p.soilType))) {
    const soil = soilType.replace(/\bsoils?\b/gi, " ").replace(/\s+/g, " ").trim();
    if (soil) parts.push(soil);
  }

  for (const irrigationType of distinct(plots.map((p) => p.irrigationType))) {
    parts.push(irrigationType);
    parts.push(/rain/i.test(irrigationType) ? "rainfed" : "irrigated");
  }

  // Scheme eligibility is written in terms of the small/marginal categories,
  // not acreage, so map the number onto those words. 2 acres is the threshold
  // PM-KISAN Maandhan and similar schemes use.
  // Total holding across plots: the small/marginal categories are about the family's
  // whole holding, not one plot.
  const acres = plots.reduce((sum, p) => sum + (Number(p?.areaAcres) > 0 ? Number(p.areaAcres) : 0), 0);
  if (Number.isFinite(acres) && acres > 0) {
    parts.push(acres <= 2 ? "small marginal holding" : "medium larger holding");
  }

  // The loan's credit score / eligibilityStatus is deliberately NOT used here.
  // It used to add "income support" for not_eligible loans, which pushed PM-KISAN
  // up for people the lender had rated poorly. Which schemes suit a farmer
  // depends on their land, crop and purpose, not on their creditworthiness.
  if (loanApplication?.purpose) parts.push(`purpose ${loanApplication.purpose}`);

  return parts.filter(Boolean).join(" ");
}

/**
 * The schemes to evaluate: every central scheme plus the state schemes for the given states
 * (the farmer's land states). { all: true } returns every scheme including all states' (for
 * looking a scheme up by id).
 */
export function getAllSchemes({ states, all = false } = {}) {
  return all ? getIndex().schemes : schemesVisibleFor(getIndex().schemes, states);
}

/**
 * Retrieve the top-K matching schemes for a given free-text profile query.
 * Returns schemes with a similarity score, sorted descending.
 */
export function retrieveSchemes(profileQueryText, topK = 3, { states } = {}) {
  return retrieveWith(getIndex(), profileQueryText, topK, states);
}

/** Retrieval against a given index; state schemes count only for the listed states. */
export function retrieveWith({ schemes, docVectors, idf }, profileQueryText, topK, states) {
  const queryVec = vectorize(profileQueryText, idf);

  const scored = schemes
    .map((scheme, i) => ({ scheme, score: cosineSimilarity(queryVec, docVectors[i]) }))
    .filter(({ scheme }) => schemesVisibleFor([scheme], states).length > 0);

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter((s) => s.score > 0)
    .slice(0, topK)
    .map(({ scheme, score }) => ({ ...scheme, matchScore: Number(score.toFixed(4)) }));
}

// ---- Question-answering retrieval -------------------------------------------
//
// retrieveSchemes() above also serves loan matching, whose profile queries are
// long and score low on purpose, so it keeps returning anything above zero.
// Free-text questions need a floor, or a stray shared word ("need", "much")
// produces a confident-looking answer from an unrelated scheme.
//
// An absolute per-result threshold does not work here, which is why the floor is
// applied to the BEST score only, and why a named scheme bypasses it. Measured on
// real questions: "Am I eligible for PM-KISAN?" ranks KCC first (0.199) and
// PM-KISAN second (0.095), and "What documents are needed for KCC?" tops out at
// 0.078 because an acronym is one rare term against long documents. Noise
// matches ("how much water does rice need") top out at 0.067. A per-result
// floor would delete PM-KISAN from its own question.
export const MIN_QA_TOP_SCORE = 0.1;

const normalizeForMatch = (t) => ` ${String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

let cachedAliases = null;
function getSchemeAliases() {
  if (cachedAliases) return cachedAliases;
  const aliases = new Set();
  for (const s of getIndex().schemes) {
    aliases.add(normalizeForMatch(s.id));
    const withoutParens = s.name.replace(/\s*\([^)]*\)\s*/g, " ");
    aliases.add(normalizeForMatch(withoutParens));
    for (const m of s.name.matchAll(/\(([^)]+)\)/g)) aliases.add(normalizeForMatch(m[1]));
  }
  aliases.delete("  ");
  cachedAliases = [...aliases];
  return cachedAliases;
}

/** True if the question names a scheme or its acronym (e.g. "KCC", "PM-KISAN"). */
export function mentionsSchemeByName(question) {
  const q = normalizeForMatch(question);
  return getSchemeAliases().some((a) => q.includes(a));
}

/**
 * Top-K schemes for a farmer's question, or [] when nothing matches well enough
 * to answer from. See the note above for why the floor is on the best score.
 */
export function retrieveSchemesForQuestion(question, topK = 3, { states } = {}) {
  const results = retrieveSchemes(question, topK, { states });
  if (results.length === 0) return [];
  if (results[0].matchScore >= MIN_QA_TOP_SCORE || mentionsSchemeByName(question)) return results;
  return [];
}
