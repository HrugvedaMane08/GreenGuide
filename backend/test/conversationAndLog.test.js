import test from "node:test";
import assert from "node:assert/strict";

import { loadHistory, rememberTurn, clearHistory, isFollowUp, contextualQuery, formatHistoryForPrompt, MEMORY } from "../features/loanAssistant/services/conversationMemory.js";
import { scrubForLog, recordQuestion } from "../features/loanAssistant/services/questionLog.js";
import { classifyQuestion } from "../features/loanAssistant/services/questionScope.js";
import { buildPrompt } from "../features/loanAssistant/services/farmerAnswerGeneration.js";
import { validateFarmerQuery, validateConversationClear, validateQuestionStats } from "../features/loanAssistant/middleware/validators.js";
import { handleValidation } from "../middleware/validation.js";
import schemes from "../features/loanAssistant/data/schemes.json" with { type: "json" };

const NOW = new Date("2026-10-10T10:00:00Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);

// ---------- a tiny in-memory stand-in for the messages collection ----------

function fakeMessages() {
  const docs = [];
  const matches = (d, f) => Object.entries(f).every(([k, v]) => (k === "createdAt" ? d.createdAt >= v.$gte : d[k] === v));
  return {
    docs,
    db: { readyState: 1 },
    insertMany: async (list) => { docs.push(...list.map((d) => ({ ...d }))); },
    deleteMany: async (f) => { const before = docs.length; for (let i = docs.length - 1; i >= 0; i--) if (matches(docs[i], f)) docs.splice(i, 1); return { deletedCount: before - docs.length }; },
    find: (f) => {
      let rows = docs.filter((d) => matches(d, f));
      const q = { sort: () => { rows = [...rows].sort((a, b) => b.createdAt - a.createdAt); return q; }, limit: (n) => { rows = rows.slice(0, n); return q; }, lean: async () => rows };
      return q;
    },
  };
}

// ---------- remembering ----------

test("a turn is stored as a user message then an assistant message, and read back in order", async () => {
  const Model = fakeMessages();
  await rememberTurn({ farmerId: "f1", sessionId: "s1", question: "What documents does KCC need?", answer: "You need Aadhaar...", intent: "scheme", schemeIds: ["kcc"] }, { now: NOW, Model });
  const h = await loadHistory("f1", "s1", { now: NOW, Model });
  assert.deepEqual(h.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(h[1].schemeIds, ["kcc"]);
  assert.equal(h[1].intent, "scheme");
});

test("only the last 6 messages come back", async () => {
  const Model = fakeMessages();
  for (let i = 0; i < 5; i++) await rememberTurn({ farmerId: "f1", sessionId: "s1", question: `q${i}`, answer: `a${i}`, intent: "scheme" }, { now: minutesAgo(10 - i), Model });
  const h = await loadHistory("f1", "s1", { now: NOW, Model });
  assert.equal(h.length, MEMORY.maxMessages);
  assert.deepEqual(h.map((m) => m.text), ["q2", "a2", "q3", "a3", "q4", "a4"]); // the newest three exchanges, oldest first
});

test("messages older than the memory window are not read", async () => {
  const Model = fakeMessages();
  await rememberTurn({ farmerId: "f1", sessionId: "s1", question: "old", answer: "old", intent: "scheme" }, { now: minutesAgo(MEMORY.windowMinutes + 5), Model });
  await rememberTurn({ farmerId: "f1", sessionId: "s1", question: "recent", answer: "recent", intent: "scheme" }, { now: minutesAgo(5), Model });
  assert.deepEqual((await loadHistory("f1", "s1", { now: NOW, Model })).map((m) => m.text), ["recent", "recent"]);
});

test("conversations are kept apart: by farmer and by session; no session id means one shared 'default'", async () => {
  const Model = fakeMessages();
  await rememberTurn({ farmerId: "f1", sessionId: "s1", question: "a", answer: "a", intent: "scheme" }, { now: NOW, Model });
  await rememberTurn({ farmerId: "f1", sessionId: "s2", question: "b", answer: "b", intent: "scheme" }, { now: NOW, Model });
  await rememberTurn({ farmerId: "f2", sessionId: "s1", question: "c", answer: "c", intent: "scheme" }, { now: NOW, Model });
  await rememberTurn({ farmerId: "f1", question: "d", answer: "d", intent: "scheme" }, { now: NOW, Model });
  assert.deepEqual((await loadHistory("f1", "s1", { now: NOW, Model })).map((m) => m.text), ["a", "a"]);
  assert.deepEqual((await loadHistory("f2", "s1", { now: NOW, Model })).map((m) => m.text), ["c", "c"]);
  assert.deepEqual((await loadHistory("f1", undefined, { now: NOW, Model })).map((m) => m.text), ["d", "d"]);
});

test("long answers are clipped, and 'new topic' forgets a session", async () => {
  const Model = fakeMessages();
  await rememberTurn({ farmerId: "f1", sessionId: "s1", question: "q", answer: "x".repeat(5000), intent: "scheme" }, { now: NOW, Model });
  assert.equal(Model.docs[1].text.length, MEMORY.maxChars);
  assert.equal(await clearHistory("f1", "s1", { Model }), 2);
  assert.deepEqual(await loadHistory("f1", "s1", { now: NOW, Model }), []);
});

test("memory is best-effort: a database that is down or erroring never throws", async () => {
  const down = { db: { readyState: 0 } };
  assert.deepEqual(await loadHistory("f1", "s1", { Model: down }), []);
  await rememberTurn({ farmerId: "f1", sessionId: "s1", question: "q", answer: "a" }, { Model: down });
  const broken = { db: { readyState: 1 }, find: () => { throw new Error("boom"); }, insertMany: async () => { throw new Error("boom"); } };
  assert.deepEqual(await loadHistory("f1", "s1", { Model: broken }), []);
  await rememberTurn({ farmerId: "f1", sessionId: "s1", question: "q", answer: "a" }, { Model: broken });
  assert.deepEqual(await loadHistory("", "s1", { Model: fakeMessages() }), []);
});

// ---------- understanding a follow-up ----------

const kccHistory = [
  { role: "user", text: "What documents does the Kisan Credit Card need?" },
  { role: "assistant", text: "You need Aadhaar and PAN...", intent: "scheme", schemeIds: ["kcc", "pmfby"] },
];

test("short, referring or aspect-only questions are follow-ups", () => {
  for (const q of ["and the documents?", "and the interest rate?", "how do I apply for it?", "what about the last date?", "is there a limit on that?", "how much?", "ok and the amount", "What documents do I need?"]) {
    assert.equal(isFollowUp(q, kccHistory), true, q);
  }
});

test("a question with a subject of its own is not, even with 'it' or 'and' in it", () => {
  for (const q of ["Am I eligible for PM-KISAN?", "what about the pension scheme?", "and what about crop insurance?", "Tell me about Soil Health Card", "will it rain tomorrow", "How do I get a loan for a tractor today please"]) {
    assert.equal(isFollowUp(q, kccHistory), false, q);
  }
});

test("with nothing to follow there is no follow-up", () => {
  assert.equal(isFollowUp("and the documents?", []), false);
  assert.equal(isFollowUp("and the documents?", undefined), false);
  assert.equal(isFollowUp("and the documents?", [{ role: "assistant", text: "Sorry", intent: "declined" }]), false); // the last answer was not about a scheme
  assert.equal(isFollowUp("", kccHistory), false);
});

test("a follow-up is searched together with the scheme it refers to and what was asked", () => {
  const q = contextualQuery("and the interest rate?", kccHistory);
  assert.match(q, /Kisan Credit Card \(KCC\)/);
  assert.match(q, /What documents does the Kisan Credit Card need\?/);
  assert.match(q, /and the interest rate\?$/);
  assert.equal(contextualQuery("and the documents?", []), "and the documents?");
});

test("the recent exchange is laid out for the prompt", () => {
  const text = formatHistoryForPrompt(kccHistory);
  assert.equal(text.split("\n").length, 2);
  assert.match(text, /^Farmer: What documents/);
  assert.match(text, /\nAssistant: You need Aadhaar/);
  assert.equal(formatHistoryForPrompt([]), "");
});

test("a follow-up needs no model call to be judged in scope; an unrelated unknown still does", async () => {
  process.env.GROQ_API_KEY = "stub";
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_u, init) => { calls.push(JSON.parse(init.body).messages[0].content); return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: "NO" } }] }), text: async () => "NO" }; };
  try {
    assert.equal(await classifyQuestion("and for my wife?", { followUp: true }), "scheme");
    assert.equal(calls.length, 0);
    assert.equal(await classifyQuestion("and for my wife?"), "out"); // not a follow-up: asked to the model (stub says NO)
    assert.equal(calls.length, 1);
    assert.equal(await classifyQuestion("Tell me a joke", { followUp: true }), "out"); // keywords still decide first
  } finally {
    globalThis.fetch = real;
  }
});

test("the answer prompt carries the conversation, and says how to use it, only when there is one", () => {
  const kcc = schemes.find((s) => s.id === "kcc");
  const withHistory = buildPrompt({ question: "and the interest rate?", retrievedSchemes: [kcc], history: kccHistory });
  assert.match(withHistory, /Conversation so far/);
  assert.match(withHistory, /Farmer: What documents does the Kisan Credit Card need\?/);
  assert.match(withHistory, /refers back to the conversation/);
  const without = buildPrompt({ question: "What is KCC?", retrievedSchemes: [kcc], history: [] });
  assert.ok(!/Conversation so far/.test(without));
});

// ---------- the question log ----------

test("scrubbing removes numbers, e-mail, links and PAN, and lower-cases for grouping", () => {
  assert.equal(scrubForLog("My phone is 98765 43210, mail me at Asha.K@Example.com"), "my phone is <number>, mail me at <email>");
  assert.equal(scrubForLog("Aadhaar 1234 5678 9012 and PAN ABCDE1234F"), "aadhaar <number> and pan <id>");
  assert.equal(scrubForLog("see https://example.com/x?y=1 for details"), "see <link> for details");
  assert.equal(scrubForLog("loan of 50000 rupees"), "loan of <number> rupees");
  assert.equal(scrubForLog("Am I eligible for PM-KISAN?"), "am i eligible for pm-kisan?");
  assert.equal(scrubForLog("x".repeat(500)).length, 200);
  assert.equal(scrubForLog(undefined), "");
});

test("a log row has the useful facts and nothing that identifies the farmer", async () => {
  const rows = [];
  const Model = { db: { readyState: 1 }, create: async (doc) => { rows.push(doc); return doc; } };
  await recordQuestion({
    channel: "typed", language: "mr", intent: "scheme", followUp: true, outcome: "no_match", failureReason: "nothing scored above 0.10",
    question: "How do I apply for 9876543210?", retrieval: [{ id: "kcc", score: 0.05 }], topScore: 0.05, sources: [],
    modelCalls: { total: 3, byPurpose: { generate: 1 }, attempts: 3 }, ms: 120, answerChars: 80,
    // things that must never be stored even if a caller passed them:
    farmerId: "secret-farmer", sessionId: "secret-session", answer: "Your 3 acres in Pune...", originalQuestion: "मूळ",
  }, { Model });
  const row = rows[0];
  assert.equal(row.question, "how do i apply for <number>?");
  assert.equal(row.outcome, "no_match");
  assert.equal(row.topScore, 0.05);
  assert.equal(row.modelCalls.total, 3);
  const text = JSON.stringify(row);
  for (const secret of ["secret-farmer", "secret-session", "Your 3 acres", "मूळ"]) assert.ok(!text.includes(secret), secret);
});

test("logging never throws, and does nothing when the database is down", async () => {
  assert.equal(await recordQuestion({ question: "q" }, { Model: { db: { readyState: 0 }, create: async () => { throw new Error("must not be called"); } } }), null);
  assert.equal(await recordQuestion({ question: "q" }, { Model: { db: { readyState: 1 }, create: async () => { throw new Error("boom"); } } }), null);
});

// ---------- validators ----------

async function run(validators, { body = {}, params = {}, query = {} } = {}) {
  const req = { body: { ...body }, params: { ...params }, query: { ...query }, headers: {}, cookies: {} };
  let status = null, json = null, passed = false;
  const res = { status(c) { status = c; return this; }, json(p) { json = p; return this; } };
  for (const v of validators) {
    if (v === handleValidation) handleValidation(req, res, () => { passed = true; });
    else if (typeof v.run === "function") await v.run(req);
  }
  return { passed, status, json, query: req.query };
}

test("session ids are checked; stats paging is bounded", async () => {
  const ask = (body) => run(validateFarmerQuery, { params: { farmerId: "f1" }, body: { question: "hi", ...body } });
  assert.ok((await ask({ sessionId: "abc_123-XYZ" })).passed);
  assert.ok((await ask({})).passed);
  assert.match((await ask({ sessionId: "has space" })).json.error, /Session is not valid/);
  assert.match((await ask({ sessionId: "x".repeat(65) })).json.error, /Session is not valid/);
  assert.ok((await run(validateConversationClear, { params: { farmerId: "f1" }, query: { sessionId: "s1" } })).passed);
  assert.ok((await run(validateQuestionStats, { query: {} })).passed);
  const ok = await run(validateQuestionStats, { query: { days: "7", limit: "5" } });
  assert.ok(ok.passed);
  // (Express 5 makes req.query read-only, so the controller does the number conversion, not the validator)
  assert.match((await run(validateQuestionStats, { query: { days: "0" } })).json.error, /Days must be/);
  assert.match((await run(validateQuestionStats, { query: { limit: "500" } })).json.error, /Limit must be/);
});

// ---------- pinning the scheme under discussion ----------

import { pinDiscussedScheme } from "../features/loanAssistant/services/conversationMemory.js";

test("a follow-up keeps the scheme being discussed first, whatever the search ranked first", () => {
  const retrieved = [{ id: "interest-subvention", matchScore: 0.23 }, { id: "kcc", matchScore: 0.2 }, { id: "pmfby", matchScore: 0.1 }];
  assert.deepEqual(pinDiscussedScheme(retrieved, kccHistory).map((s) => s.id), ["kcc", "interest-subvention", "pmfby"]);
});

test("if the search missed the discussed scheme entirely, it is added at the front (max 3)", () => {
  const retrieved = [{ id: "aif", matchScore: 0.2 }, { id: "pmfby", matchScore: 0.1 }, { id: "soil-health-card", matchScore: 0.1 }];
  const pinned = pinDiscussedScheme(retrieved, kccHistory);
  assert.deepEqual(pinned.map((s) => s.id), ["kcc", "aif", "pmfby"]);
  assert.equal(pinned[0].matchScore, 0);
  assert.match(pinned[0].name, /Kisan Credit Card/);
});

test("nothing discussed, nothing pinned", () => {
  const retrieved = [{ id: "aif", matchScore: 0.2 }];
  assert.equal(pinDiscussedScheme(retrieved, []), retrieved);
});
