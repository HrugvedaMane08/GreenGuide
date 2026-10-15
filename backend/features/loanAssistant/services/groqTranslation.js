// Same Groq integration pattern as ../services/groqGeneration.js (used by
// scheme matching) — raw fetch against the OpenAI-compatible chat completions
// endpoint, same env vars, same graceful-fallback philosophy.

import { callGroqRaw } from "./groqClient.js";
import { classifyLanguage, glossaryFor } from "./languageHints.js";

function stripCodeFences(text) {
  return text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

// Thin wrapper: HTTP, model choice and 429 retries live in groqClient.js.
async function callGroq(messages, opts = {}) {
  return callGroqRaw(messages, opts);
}

// Detection and translation are mechanical tasks with no reasoning to do, but
// GROQ_MODEL is openai/gpt-oss-20b, which spends ~900 tokens thinking before
// emitting anything. At the old 500-token budget it regularly ran out mid-
// thought and returned an EMPTY body ("Unexpected end of JSON input"), which
// the catch turned into "assume English" — so a Marathi question came back in
// English.
//
// Measured over this account's available models (3/3 correct each):
//   qwen/qwen3.8-27b    38 completion tokens
//   openai/gpt-oss-20b 130
//   groq/compound-mini 163
// Qwen is ~3.4x cheaper per call, which matters directly against the free
// tier's 8000 tokens-per-minute cap since each question costs three calls.
// Note this account has no Llama chat models — verify with GET /v1/models
// before changing this default.
const TRANSLATION_MODEL = process.env.GROQ_TRANSLATION_MODEL || "qwen/qwen3.8-27b";

// Marathi and Hindi share the Devanagari block, so script alone cannot tell them apart, but it
// can prove the text is NOT English, which is the failure that actually hurt farmers: a dropped
// detection silently answered a Marathi question in English. The same holds for Hindi/Marathi
// typed in English letters, which keywords can recognise (see languageHints.js).

/**
 * Detects the language of the farmer's question and translates it to English
 * (English is needed because the scheme corpus / TF-IDF retrieval is English-only).
 *
 * @param {string} questionText - the farmer's raw question, in any language
 * @param {string} languageHint - "auto", or an ISO code like "hi" if the farmer picked one from the dropdown
 */
export async function detectAndTranslateToEnglish(questionText, languageHint) {
  const language = classifyLanguage(questionText, languageHint);

  // Plainly English: nothing to detect and nothing to translate, so no model call. (This used to
  // be a call on every single question, including ones the farmer had marked as English.)
  if (language.kind === "english") {
    return { detectedLanguageCode: "en", detectedLanguageName: "English", translatedText: questionText, modelSkipped: true };
  }

  // The language is already settled by the script or by keywords ("known"), or it is not: the
  // model is still needed to translate, but a settled language is never overturned by it.
  const known = language.kind === "known" ? language : null;

  try {
    const hintLine =
      known && known.script === "latin"
        ? `The text is ${known.name} written in English (Latin) letters.`
        : languageHint && languageHint !== "auto"
          ? `The farmer has indicated their question is in language code "${languageHint}". Use this unless the text clearly suggests otherwise.`
          : "Detect the language automatically.";

    // For Latin-letter Hindi/Marathi, tell the model what the farming words mean (see languageHints.js).
    const glossary = known && known.script === "latin" ? glossaryFor(questionText) : [];
    const glossaryLine = glossary.length ? `
Word meanings to use: ${glossary.join("; ")}.
` : "";

    // Deliberately domain-free. An earlier version opened with "You are a
    // ... assistant for an Indian farming app", which primed the model to
    // invent plausible farming questions ("What is the price of wheat per
    // quintal?") instead of translating what was actually asked. Naming no
    // domain, and demanding a literal translation, fixed that.
    const prompt = `Detect the language of the text below and translate it literally into English.

${hintLine}
${glossaryLine}
Translate ONLY what is written. Do not infer, expand, summarise, or invent any content that is not present in the text.

Text:
"""${questionText}"""

Respond with ONLY valid JSON (no markdown fences, no commentary), in this exact shape:
{"languageCode": "ISO 639-1 code, e.g. hi", "languageName": "Full language name, e.g. Hindi", "translatedText": "the literal English translation"}

If the text is already in English, set languageCode to "en", languageName to "English", and translatedText to the original text unchanged.`;

    // Three attempts: the observed failures are transient (an empty body when
    // the rate limiter bites, or occasional malformed JSON), and a later
    // attempt almost always succeeds. Without this a single blip meant a
    // Marathi farmer got an English answer.
    let parsed;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await callGroq([{ role: "user", content: prompt }], { model: TRANSLATION_MODEL, max_tokens: 800, purpose: "translate-in" });
        if (!raw.trim()) throw new Error("Empty response body");
        const candidate = JSON.parse(stripCodeFences(raw));
        if (!candidate.translatedText || !candidate.languageCode) {
          throw new Error("Unexpected translation response shape");
        }
        parsed = candidate;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`Language detection attempt ${attempt + 1}/3 failed (${e.message}).`);
        // Brief pause before retrying so a token-budget dip has time to refill.
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    if (!parsed) throw lastErr;

    // The model intermittently reports "en" for text that is not English. Believing it means the
    // answer is never translated back, so the farmer gets English.
    if (known && parsed.languageCode === "en") {
      console.warn(`Detection returned "en" for ${known.script} ${known.name} text; overriding to ${known.name}.`);
      return { detectedLanguageCode: known.code, detectedLanguageName: known.name, translatedText: parsed.translatedText };
    }

    return {
      detectedLanguageCode: known ? known.code : parsed.languageCode,
      detectedLanguageName: known ? known.name : parsed.languageName || parsed.languageCode,
      translatedText: parsed.translatedText,
    };
  } catch (err) {
    // Falling back to English is safe only for English input. For a language we have already
    // recognised the question still can't be retrieved against the English corpus, but keeping the
    // real language means the answer is at least translated back into it rather than silently
    // arriving in English.
    if (known) {
      console.error(
        `Language detection failed for ${known.name} text: ${err.message}. ` +
        `Keeping ${known.code} so the answer is still translated back.`
      );
      return {
        detectedLanguageCode: known.code,
        detectedLanguageName: known.name,
        translatedText: questionText,
        // The text is still not English, so the English-only retriever will match nothing.
        // Flagged so the caller can say the question couldn't be understood rather than
        // answering as if nothing went wrong.
        translationFailed: true,
      };
    }

    console.error("Language detection/translation failed, assuming English:", err.message);
    return { detectedLanguageCode: "en", detectedLanguageName: "English", translatedText: questionText };
  }
}

// Only successful translations of fixed messages are kept (see the `cache` option below).
const FIXED_TRANSLATIONS = new Map();

/**
 * Translates an English answer into the farmer's detected/selected language.
 * Returns the original English text unchanged if translation fails, so the
 * farmer still gets an answer even if this step has a problem.
 */
export async function translateFromEnglish(englishText, languageCode, languageName, { cache = false } = {}) {
  if (!languageCode || languageCode === "en") return englishText;

  // Fixed messages (declines, "couldn't find this", "ask your KVK"...) are the same text for
  // every farmer, so translate each once per language instead of on every question.
  const cacheKey = cache && englishText.length <= 800 ? `${languageCode}|${englishText}` : null;
  if (cacheKey && FIXED_TRANSLATIONS.has(cacheKey)) return FIXED_TRANSLATIONS.get(cacheKey);

  // Indic scripts need far more tokens than the English source: Devanagari
  // costs roughly 3-4x per character, and reasoning models spend part of the
  // budget thinking before emitting anything. A fixed 700 made long answers
  // return finish_reason "length" with EMPTY content, which silently fell back
  // to English. Scale with the input and keep a generous floor.
  const maxTokens = Math.min(4000, Math.max(1200, Math.ceil(englishText.length * 2.5)));

  try {
    const prompt = `Translate the following text into ${languageName} (${languageCode}). Keep it natural and easy for a farmer to read. Respond with ONLY the translated text — no quotes, no commentary, no markdown.

Text to translate:
"""${englishText}"""`;

    const translated = (await callGroq([{ role: "user", content: prompt }], { model: TRANSLATION_MODEL, max_tokens: maxTokens, purpose: "translate-out" })).trim();

    // An empty result means the budget was exhausted before any output. Say so
    // rather than returning English as though translation had succeeded.
    if (!translated) {
      console.error(
        `Answer translation to ${languageName} returned empty (token budget ${maxTokens} exhausted); returning English.`
      );
      return englishText;
    }

    if (cacheKey) {
      if (FIXED_TRANSLATIONS.size >= 200) FIXED_TRANSLATIONS.delete(FIXED_TRANSLATIONS.keys().next().value); // bounded
      FIXED_TRANSLATIONS.set(cacheKey, translated);
    }
    return translated;
  } catch (err) {
    console.error("Answer translation failed, returning English:", err.message);
    return englishText;
  }
}