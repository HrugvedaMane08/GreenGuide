import test from "node:test";
import assert from "node:assert/strict";

import { classifyLanguage, romanisedLanguage, isPlainAscii, hasDevanagari, glossaryFor } from "../features/loanAssistant/services/languageHints.js";
import { withCallStats, callGroqRaw } from "../features/loanAssistant/services/groqClient.js";
import { detectAndTranslateToEnglish, translateFromEnglish } from "../features/loanAssistant/services/groqTranslation.js";
import { postFarmerQuery } from "../features/loanAssistant/controllers/farmerQueryController.js";

process.env.GROQ_API_KEY = "stub-key";

// A stand-in for the model that records what each call was for.
const calls = [];
globalThis.fetch = async (_url, { body }) => {
  const prompt = JSON.parse(body).messages[0].content;
  let kind, text;
  if (/^Detect the language/.test(prompt)) {
    kind = "translate-in";
    const q = /"""([\s\S]*?)"""/.exec(prompt)[1];
    const indic = hasDevanagari(q) || /mujhe|chahiye|mala|pahije|fasal/i.test(q);
    text = JSON.stringify({ languageCode: indic ? "en" : "en", languageName: "English", translatedText: indic ? "I need a loan" : q }); // deliberately says "en" for Indian-language text
  } else if (/^Translate the following text/.test(prompt)) { kind = "translate-out"; text = `[translated #${calls.length}]`; }
  else if (/^Does this question ask/.test(prompt)) { kind = "scope"; text = "YES"; }
  else { kind = "generate"; text = "You may be eligible."; }
  calls.push(kind);
  return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: text } }] }), text: async () => text };
};
const reset = () => { calls.length = 0; };

// ---------- the heuristics ----------

test("plain English is English, whatever the punctuation", () => {
  for (const q of ["Am I eligible for PM-KISAN?", "What is the main benefit of KCC?", "How much do I get?", "Hai, I need a loan", "Limit is ₹3 lakh — is that right?", "what’s the premium?", "hello there"]) {
    assert.equal(classifyLanguage(q, "auto").kind, "english", q);
  }
  assert.equal(isPlainAscii("it’s ₹5 – fine…"), true);
  assert.equal(isPlainAscii("café"), false);
});

test("choosing English is believed for text in English letters; Devanagari is never English", () => {
  assert.equal(classifyLanguage("mujhe loan chahiye", "en").kind, "english"); // explicit choice wins over keywords
  const deva = classifyLanguage("मुझे लोन चाहिए", "en");
  assert.deepEqual([deva.kind, deva.code, deva.script], ["known", "hi", "devanagari"]);
  assert.equal(classifyLanguage("मला कर्ज हवे", "mr").code, "mr");
});

test("romanised Hindi and Marathi are recognised by keywords", () => {
  for (const q of ["mujhe loan chahiye", "kya main KCC ke liye apply kar sakta hu", "mera fasal kharab ho gaya", "PM-KISAN ke liye kya documents chahiye", "barish kab hogi"]) {
    assert.equal(romanisedLanguage(q), "hi", q);
    assert.deepEqual([classifyLanguage(q, "auto").kind, classifyLanguage(q, "auto").script], ["known", "latin"], q);
  }
  for (const q of ["mala kisan yojana pahije", "kiti pension milel", "mala sheti sathi loan pahije"]) assert.equal(romanisedLanguage(q), "mr", q);
});

test("one ambiguous word is not enough; two are", () => {
  assert.equal(romanisedLanguage("hai"), null);
  assert.equal(romanisedLanguage("Hai, how are you"), null);
  assert.equal(romanisedLanguage("loan hai toh bata"), "hi"); // hai + toh
});

test("a Hindi/Marathi choice with text we cannot read as either goes to the model, not to English", () => {
  assert.equal(classifyLanguage("loan documents", "hi").kind, "unknown");
  assert.equal(classifyLanguage("loan documents", "mr").kind, "unknown");
  assert.equal(classifyLanguage("வணக்கம்", "auto").kind, "unknown"); // another script entirely
});

// ---------- the model is skipped when it is not needed ----------

test("English costs no detection or translation call", async () => {
  reset();
  const r = await detectAndTranslateToEnglish("Am I eligible for PM-KISAN?", "auto");
  assert.equal(calls.length, 0);
  assert.deepEqual([r.detectedLanguageCode, r.translatedText, r.modelSkipped], ["en", "Am I eligible for PM-KISAN?", true]);
  await detectAndTranslateToEnglish("Tell me about KCC", "en");
  assert.equal(calls.length, 0);
});

test("romanised Hindi is translated by the model but never left as English, even if the model says 'en'", async () => {
  reset();
  const r = await detectAndTranslateToEnglish("mujhe loan chahiye", "auto");
  assert.deepEqual(calls, ["translate-in"]);
  assert.equal(r.detectedLanguageCode, "hi"); // the stub model said "en"
  assert.equal(r.detectedLanguageName, "Hindi");
  assert.equal(r.translatedText, "I need a loan");
});

test("Devanagari still goes to the model and is never reported as English", async () => {
  reset();
  const r = await detectAndTranslateToEnglish("मला कर्ज हवे", "mr");
  assert.deepEqual(calls, ["translate-in"]);
  assert.equal(r.detectedLanguageCode, "mr");
});

test("if the model fails on romanised Hindi the farmer is told, in Hindi, not answered in English", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, headers: new Headers(), text: async () => "bad request", json: async () => ({}) });
  try {
    const r = await detectAndTranslateToEnglish("mujhe loan chahiye", "auto");
    assert.equal(r.translationFailed, true);
    assert.equal(r.detectedLanguageCode, "hi");
  } finally {
    globalThis.fetch = real;
  }
});

// ---------- counting and logging ----------

test("calls are tallied by purpose, including retries as HTTP attempts", async () => {
  reset();
  const { stats } = await withCallStats(async () => {
    await callGroqRaw([{ role: "user", content: "Does this question ask about x" }], { purpose: "scope" });
    await callGroqRaw([{ role: "user", content: "Translate the following text" }], { purpose: "translate-out" });
    await callGroqRaw([{ role: "user", content: "Translate the following text" }], { purpose: "translate-out" });
  });
  assert.deepEqual(stats, { total: 3, byPurpose: { scope: 1, "translate-out": 2 }, attempts: 3 });
});

test("outside withCallStats nothing is recorded and nothing breaks; concurrent questions do not mix", async () => {
  await callGroqRaw([{ role: "user", content: "x" }]); // no store: fine
  const [a, b] = await Promise.all([
    withCallStats(async () => { await callGroqRaw([{ role: "user", content: "1" }], { purpose: "generate" }); }),
    withCallStats(async () => { await callGroqRaw([{ role: "user", content: "2" }], { purpose: "scope" }); await callGroqRaw([{ role: "user", content: "3" }], { purpose: "scope" }); }),
  ]);
  assert.equal(a.stats.total, 1);
  assert.equal(b.stats.total, 2);
});

test("a failing question still reports what it spent", async () => {
  await assert.rejects(
    withCallStats(async () => { await callGroqRaw([{ role: "user", content: "x" }], { purpose: "generate" }); throw new Error("boom"); }),
    (err) => err.message === "boom" && err.modelCalls.total === 1 && err.modelCalls.byPurpose.generate === 1
  );
});

// ---------- whole questions ----------

async function ask(question, language) {
  reset();
  let out;
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await postFarmerQuery({ params: { farmerId: "f" }, body: { question, language } }, { status() { return this; }, json(p) { out = p; return this; } });
  } finally {
    console.log = log;
  }
  return { out, logs, calls: [...calls] };
}

test("what each kind of question costs", async () => {
  assert.deepEqual((await ask("Am I eligible for PM-KISAN?", "auto")).calls, ["generate"]); // was 2
  assert.deepEqual((await ask("Am I eligible for PM-KISAN?", "en")).calls, ["generate"]); // was 2
  assert.deepEqual((await ask("Tell me a joke", "en")).calls, []); // declined: was 1
  assert.deepEqual((await ask("Will it rain tomorrow?", "en")).calls, []); // weather needs a district: was 1
  assert.deepEqual((await ask("मी पीएम-किसानसाठी पात्र आहे का?", "mr")).calls, ["translate-in", "generate", "translate-out"]);
});

test("each question logs its model calls", async () => {
  const r = await ask("Am I eligible for PM-KISAN?", "en");
  assert.ok(r.logs.some((l) => /typed question answered with 1 model call \(generate 1\)/.test(l)), r.logs.join("|"));
  const none = await ask("Tell me a joke", "en");
  assert.ok(none.logs.some((l) => /answered with 0 model calls/.test(l)), none.logs.join("|"));
});

test("a romanised Hindi question is answered in Hindi", async () => {
  const r = await ask("mujhe loan chahiye", "auto");
  assert.equal(r.out.detectedLanguageCode, "hi");
  assert.match(r.out.answer, /^\[translated/); // went through translate-out
});

// ---------- fixed messages are translated once per language ----------

test("a fixed message is translated once and reused; ordinary answers are never cached", async () => {
  reset();
  const msg = "I can only help with government schemes, weather and mandi prices (cache test).";
  const first = await translateFromEnglish(msg, "mr", "Marathi", { cache: true });
  const second = await translateFromEnglish(msg, "mr", "Marathi", { cache: true });
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  await translateFromEnglish(msg, "hi", "Hindi", { cache: true }); // a different language is a different entry
  assert.equal(calls.length, 2);
  await translateFromEnglish("Your answer text", "mr", "Marathi");
  await translateFromEnglish("Your answer text", "mr", "Marathi");
  assert.equal(calls.length, 4); // no `cache` flag: always translated
});

// ---------- the glossary for romanised farming words ----------

test("glossary lists only the farming words present in the question", () => {
  assert.deepEqual(glossaryFor("mala pik vima kasa miLel"), ["pik = crop", "vima = insurance"]);
  assert.deepEqual(glossaryFor("kanda cha bhav kay ahe"), ["kanda = onion", "bhav = price"]);
  assert.deepEqual(glossaryFor("mujhe loan chahiye"), []);
  assert.deepEqual(glossaryFor("pik pik vima"), ["pik = crop", "vima = insurance"]); // each word once
});

test("the glossary reaches the model for Latin-letter Hindi/Marathi, and only then", async () => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body).messages[0].content);
    return real(url, init);
  };
  try {
    await detectAndTranslateToEnglish("mala pik vima kasa miLel", "auto");
    assert.match(seen[0], /Word meanings to use: pik = crop; vima = insurance\./);
    assert.match(seen[0], /written in English \(Latin\) letters/);

    seen.length = 0;
    await detectAndTranslateToEnglish("मला पीक विमा हवा", "mr"); // Devanagari: no glossary
    assert.ok(!/Word meanings/.test(seen[0]));
    seen.length = 0;
    await detectAndTranslateToEnglish("mujhe loan chahiye", "auto"); // romanised, but no glossary words
    assert.ok(!/Word meanings/.test(seen[0]));
  } finally {
    globalThis.fetch = real;
  }
});
