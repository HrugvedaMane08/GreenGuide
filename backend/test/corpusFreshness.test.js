import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { freshnessOf, freshnessFooter, isValidCheckDate, isSafeSourceUrl, formatCheckDate } from "../features/loanAssistant/services/schemeFreshness.js";
import { validateStateSchemes, loadStateSchemes, schemesVisibleFor, STATE_SCHEMES_PATH } from "../features/loanAssistant/services/stateSchemes.js";
import { buildIndexFrom, retrieveWith, getAllSchemes } from "../features/loanAssistant/services/schemeRetrieval.js";
import { postFarmerQuery } from "../features/loanAssistant/controllers/farmerQueryController.js";
import schemes from "../features/loanAssistant/data/schemes.json" with { type: "json" };

process.env.GROQ_API_KEY = "stub-key";
const NOW = new Date("2026-10-11T12:00:00Z");

// ---------- the metadata on every scheme ----------

test("every scheme carries source, date and benefit metadata, and nothing is invented", () => {
  assert.equal(schemes.length, 7);
  for (const s of schemes) {
    const f = s.freshness;
    assert.ok(f, `${s.id} has no freshness block`);
    assert.ok("sourceUrl" in f && "lastVerified" in f, s.id);
    // nobody has checked anything yet, so these must be empty rather than made up
    assert.equal(f.sourceUrl, null, `${s.id}: a source URL here must come from an official page, not from a guess`);
    assert.equal(f.lastVerified, null, `${s.id}: a check date here means someone really checked`);
    assert.ok(f.benefitAmount.summary.length > 10, s.id);
    assert.match(f.benefitAmount.origin, /not yet checked/i, s.id);
    assert.ok(Array.isArray(f.todo) && f.todo.length >= 3, `${s.id} must list what to verify`);
    assert.ok(f.todo.some((t) => /source URL/i.test(t)) && f.todo.some((t) => /lastVerified/.test(t)), s.id);
  }
});

test("every figure recorded is one that is already in the scheme's own text", () => {
  const text = (id) => { const s = schemes.find((x) => x.id === id); return JSON.stringify([s.description, s.eligibilityCriteria]); };
  const fig = (id) => schemes.find((s) => s.id === id).freshness.benefitAmount.figures;

  assert.deepEqual(fig("pm-kisan"), { perYearInr: 6000, installments: 3, perInstallmentInr: 2000 });
  assert.match(text("pm-kisan"), /₹6,000 per year/);
  assert.match(text("pm-kisan"), /three installments of ₹2,000/);

  assert.equal(fig("kcc").collateralFreeLimitInr, 300000);
  assert.equal(fig("kcc").approximate, true); // our text says "commonly cited around"
  assert.match(text("kcc"), /around ₹3 lakh/);

  assert.equal(fig("aif").interestSubventionUpToPercent, 3);
  assert.equal(fig("aif").loanCapInr, null); // the cap is NOT in our text, so it is not made up
  assert.match(text("aif"), /up to 3%/);

  assert.deepEqual(fig("pm-kisan-maandhan"), { entryAgeMin: 18, entryAgeMax: 40, maxHectares: 2 });
  assert.match(text("pm-kisan-maandhan"), /aged 18-40/);

  // schemes whose text has no figures record none
  for (const id of ["pmfby", "interest-subvention", "soil-health-card"]) assert.equal(fig(id), null, id);
});

test("the dates and links that WILL be filled in are checked: a typo cannot pass as 'fresh'", () => {
  assert.equal(isValidCheckDate("2026-10-01", NOW), true);
  for (const bad of ["2026-13-01", "2026-02-30", "01/10/2026", "2026-10-1", "2062-10-01", "", null, undefined, 20261001]) assert.equal(isValidCheckDate(bad, NOW), false, String(bad));
  assert.equal(isSafeSourceUrl("https://pmkisan.gov.in/"), true);
  for (const bad of ["http://example.com", "javascript:alert(1)", "pmkisan.gov.in", "", null, "https://"]) assert.equal(isSafeSourceUrl(bad), false, String(bad));
  assert.deepEqual(freshnessOf({ freshness: { lastVerified: "2062-01-01", sourceUrl: "javascript:x" } }, NOW), { lastVerified: null, sourceUrl: null });
  assert.deepEqual(freshnessOf({}, NOW), { lastVerified: null, sourceUrl: null });
});

// ---------- the sentence at the end of an answer ----------

const checked = (name, lastVerified) => ({ name, freshness: { lastVerified, sourceUrl: "https://example.gov.in/x" } });
const unchecked = (name) => ({ name, freshness: { lastVerified: null, sourceUrl: null } });

test("nothing checked: a plain warning, no date", () => {
  const f = freshnessFooter([unchecked("A"), unchecked("B")], NOW);
  assert.match(f, /^Note: these scheme details have not yet been checked against the official source/);
  assert.match(f, /confirm with your bank or local agriculture office before you apply/);
  assert.ok(!/\d{4}/.test(f));
});

test("everything checked: the date, and it is the OLDEST of them", () => {
  assert.equal(freshnessFooter([checked("A", "2026-09-30"), checked("B", "2026-08-15")], NOW), "Scheme details last checked on 15 August 2026.");
  assert.equal(freshnessFooter([checked("A", "2026-10-01")], NOW), "Scheme details last checked on 1 October 2026.");
});

test("a mix: the date for what was checked and which are not", () => {
  const f = freshnessFooter([checked("A", "2026-09-30"), unchecked("Scheme B"), unchecked("Scheme C")], NOW);
  assert.match(f, /last checked on 30 September 2026, except Scheme B; Scheme C/);
  assert.match(f, /have not yet been checked against the official source/);
});

test("no schemes, no footer; an impossible date is treated as unchecked", () => {
  assert.equal(freshnessFooter([], NOW), "");
  assert.equal(freshnessFooter(undefined, NOW), "");
  assert.match(freshnessFooter([checked("A", "2999-01-01")], NOW), /not yet been checked/);
  assert.equal(formatCheckDate("2026-01-05"), "5 January 2026");
});

// ---------- state schemes ----------

const stateScheme = (extra = {}) => ({
  id: "mh-example", name: "Example Maharashtra Scheme", category: "subsidy", description: "A scheme for farmers in the state.",
  eligibilityCriteria: ["Owns land"], requiredDocuments: ["Aadhaar"], tags: ["subsidy"], applicability: ["any crop in Maharashtra"],
  freshness: { sourceUrl: "https://example.maharashtra.gov.in/scheme", lastVerified: "2026-10-01", benefitAmount: { summary: "As on the official page", figures: null, origin: "Official source" }, todo: [] },
  ...extra,
});

test("the shipped state-scheme file is valid, has Maharashtra, and is empty (nothing unverified is shown)", () => {
  const file = JSON.parse(readFileSync(STATE_SCHEMES_PATH, "utf8"));
  assert.ok(Array.isArray(file.Maharashtra.schemes));
  assert.deepEqual(file.Maharashtra.schemes, []);
  assert.ok(file._template && file._comment);
  assert.deepEqual(validateStateSchemes(file, schemes.map((s) => s.id)), { schemes: [], errors: [] });
  assert.deepEqual(loadStateSchemes(), []);
});

test("a complete state scheme is accepted and tagged with its state", () => {
  const { schemes: ok, errors } = validateStateSchemes({ Maharashtra: { schemes: [stateScheme()] } }, ["pm-kisan"]);
  assert.deepEqual(errors, []);
  assert.deepEqual([ok[0].level, ok[0].state, ok[0].id], ["state", "Maharashtra", "mh-example"]);
});

test("an incomplete one is skipped with a reason, never half-shown; the template is ignored", () => {
  const file = {
    _template: stateScheme({ id: "template" }),
    Maharashtra: { schemes: [stateScheme({ freshness: { sourceUrl: null, lastVerified: null } }), stateScheme({ id: "mh-b", description: "" }), stateScheme({ id: "mh-c", tags: [] }), stateScheme({ id: "mh-ok" })] },
  };
  const { schemes: ok, errors } = validateStateSchemes(file);
  assert.deepEqual(ok.map((s) => s.id), ["mh-ok"]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /sourceUrl must be the official https page/);
  assert.match(errors[0], /lastVerified must be the date you checked it/);
  assert.match(errors[1], /missing "description"/);
  assert.match(errors[2], /"tags" must be a non-empty list/);
});

test("ids must be unique, including against the central schemes", () => {
  const dup = validateStateSchemes({ Maharashtra: { schemes: [stateScheme({ id: "kcc" })] } }, ["kcc"]);
  assert.equal(dup.schemes.length, 0);
  assert.match(dup.errors[0], /id "kcc" is already used/);
  const twice = validateStateSchemes({ Maharashtra: { schemes: [stateScheme(), stateScheme()] } });
  assert.equal(twice.schemes.length, 1);
});

test("a farmer sees central schemes always, and state schemes only for their own state", () => {
  const all = [{ id: "kcc" }, { id: "mh-1", state: "Maharashtra" }, { id: "ka-1", state: "Karnataka" }];
  const ids = (states) => schemesVisibleFor(all, states).map((s) => s.id);
  assert.deepEqual(ids(["Maharashtra"]), ["kcc", "mh-1"]);
  assert.deepEqual(ids([" maharashtra "]), ["kcc", "mh-1"]); // ignores case and spaces
  assert.deepEqual(ids(["Maharashtra", "Karnataka"]), ["kcc", "mh-1", "ka-1"]);
  assert.deepEqual(ids([]), ["kcc"]);
  assert.deepEqual(ids(undefined), ["kcc"]);
});

test("retrieval honours that: a Maharashtra scheme is found for a Maharashtra farmer and for no one else", () => {
  const mh = stateScheme({ id: "mh-pump", name: "Maharashtra Solar Pump Subsidy", description: "Subsidy for solar irrigation pumps for farmers in Maharashtra.", tags: ["solar", "pump", "irrigation", "subsidy"], applicability: ["solar pump for irrigation"] });
  const { schemes: validated } = validateStateSchemes({ Maharashtra: { schemes: [mh] } });
  const index = buildIndexFrom([...schemes, ...validated]);

  const ids = (states) => retrieveWith(index, "solar pump subsidy for irrigation", 3, states).map((s) => s.id);
  assert.equal(ids(["Maharashtra"])[0], "mh-pump");
  assert.ok(!ids(["Karnataka"]).includes("mh-pump"));
  assert.ok(!ids(undefined).includes("mh-pump"));
  assert.ok(!ids([]).includes("mh-pump"));
  // central schemes are unaffected
  assert.ok(retrieveWith(index, "kisan credit card", 3, []).some((s) => s.id === "kcc"));
});

test("with no state schemes, the corpus is exactly the 7 central ones", () => {
  assert.equal(getAllSchemes().length, 7);
  assert.equal(getAllSchemes({ states: ["Maharashtra"] }).length, 7);
  assert.equal(getAllSchemes({ all: true }).length, 7);
});

// ---------- the answer itself ----------

globalThis.fetch = async (_url, { body }) => {
  const prompt = JSON.parse(body).messages[0].content;
  const text = /^Detect the language/.test(prompt)
    ? JSON.stringify({ languageCode: "mr", languageName: "Marathi", translatedText: "What documents does the Kisan Credit Card need?" })
    : /^Translate the following text/.test(prompt) ? "[translated]" : "You may be eligible.";
  return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: text } }] }), text: async () => text };
};
async function ask(question, language = "en") {
  let out;
  const log = console.log;
  console.log = () => {};
  try { await postFarmerQuery({ params: { farmerId: "f" }, body: { question, language } }, { status() { return this; }, json(p) { out = p; return this; } }); }
  finally { console.log = log; }
  return out;
}

test("a scheme answer says the details are unchecked, and names what it used", async () => {
  const r = await ask("What documents does the Kisan Credit Card need?");
  assert.match(r.answer, /^You may be eligible\.\n\nNote: these scheme details have not yet been checked against the official source/);
  assert.ok(r.schemeInfo.length > 0);
  for (const info of r.schemeInfo) assert.deepEqual(Object.keys(info).sort(), ["id", "lastVerified", "name", "sourceUrl"]);
  assert.equal(r.schemeInfo[0].lastVerified, null);
});

test("in another language the note is translated with the answer", async () => {
  const r = await ask("मला किसान क्रेडिट कार्ड साठी कागदपत्रे कोणती लागतात?", "mr");
  assert.equal(r.answer, "[translated]");
  assert.match(r.answerEnglish, /Note: these scheme details have not yet been checked/);
});

test("answers that are not about scheme details carry no such note", async () => {
  assert.ok(!/not yet been checked/.test((await ask("Tell me a joke")).answer));
  assert.ok(!/not yet been checked/.test((await ask("Will it rain tomorrow?")).answer));
  assert.ok(!/not yet been checked/.test((await ask("What is the mandi price of onion?")).answer));
  assert.equal((await ask("Tell me a joke")).schemeInfo, undefined);
});

// ---------- the checklist for you ----------

test("the checklist script lists every scheme and every open item, and fails --check while any remain", () => {
  const run = (...a) => spawnSync(process.execPath, ["scripts/corpus-todo.mjs", ...a], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  for (const s of schemes) assert.ok(out.stdout.includes(`[${s.id}]`), s.id);
  assert.match(out.stdout, /source URL:\s+NOT SET/);
  assert.match(out.stdout, /last verified:\s+NEVER/);
  assert.match(out.stdout, /ELIGIBILITY RULES/);
  assert.match(out.stdout, /land limit: up to 2 hectares \(hard\)/); // the Maandhan rule
  assert.match(out.stdout, /USD_TO_INR/);
  assert.match(out.stdout, /AGMARKNET/);
  assert.match(out.stdout, /Maharashtra: 0 scheme\(s\) loaded/);
  assert.match(out.stdout, /\d+ item\(s\) waiting for a check/);
  assert.equal(run("--check").status, 1);
});
