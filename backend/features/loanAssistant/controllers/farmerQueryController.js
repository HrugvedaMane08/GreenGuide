import Land from "../models/Land.js";
import { retrieveSchemesForQuestion, retrieveSchemes } from "../services/schemeRetrieval.js";
import { detectAndTranslateToEnglish, translateFromEnglish } from "../services/groqTranslation.js";
import { withCallStats } from "../services/groqClient.js";
import { generateAnswerFromContext, FALLBACK_ANSWER } from "../services/farmerAnswerGeneration.js";
import { loadHistory, rememberTurn, clearHistory, isFollowUp, contextualQuery, pinDiscussedScheme } from "../services/conversationMemory.js";
import { recordQuestion } from "../services/questionLog.js";
import { freshnessFooter, freshnessOf } from "../services/schemeFreshness.js";
import { SUPPORTED_LANGUAGES } from "../services/supportedLanguages.js";
import { transcribeAudio, isSupportedAudioType, MAX_AUDIO_BYTES } from "../services/groqTranscription.js";
import {
  classifyQuestion,
  OUT_OF_SCOPE_MESSAGE,
  AGRONOMY_MESSAGE,
  NO_SCHEME_MATCH_MESSAGE,
  MANDI_POINTER_MESSAGE,
} from "../services/questionScope.js";
import { isWeatherQuestion, answerWeatherQuestion, NO_DISTRICT_MESSAGE } from "../services/weatherQuestion.js";
import { loadFarmerContext, findFarmerLands } from "../services/farmerContext.js";

export function getLanguages(req, res) {
  res.json(SUPPORTED_LANGUAGES);
}

// A fixed English message, translated into the farmer's language, with no sources.
async function plainAnswer({ english, detectedLanguageCode, detectedLanguageName, translatedQuestion }) {
  const isEnglish = detectedLanguageCode === "en";
  return {
    answer: isEnglish ? english : await translateFromEnglish(english, detectedLanguageCode, detectedLanguageName, { cache: true }),
    answerEnglish: isEnglish ? undefined : english,
    detectedLanguageCode: detectedLanguageCode || "en",
    detectedLanguageName: detectedLanguageName || "English",
    translatedQuestion: isEnglish ? undefined : translatedQuestion,
    sources: [],
  };
}

/**
 * Shared answer pipeline used by both the typed and spoken entry points.
 *
 * Flow:
 *  1. Detect language + translate question to English (needed because the
 *     scheme corpus / TF-IDF retrieval in schemeRetrieval.js is English-only)
 *  2. Load the last few messages of this conversation, so "and the documents?" can be understood
 *  3. Retrieve relevant schemes for the (English) question: for a follow-up, searched together
 *     with what it refers to; with a relevance floor so weak matches are dropped
 *  4. Generate an English answer grounded in those retrieved schemes
 *  5. Translate the answer back into the farmer's language (skipped if English)
 *
 * `trace` is filled in as it goes (language, kind of question, outcome, retrieval scores...) and
 * becomes the question log row. It never contains the answer text or who asked.
 */
async function answerFarmerQuestion({ farmerId, question, language, sessionId, trace = {} }) {
  const { detectedLanguageCode, detectedLanguageName, translatedText: translatedQuestion, translationFailed } =
    await detectAndTranslateToEnglish(question, language);
  trace.language = detectedLanguageCode;
  trace.question = translatedQuestion;

  // Translation failed, so the question is still in its original script and
  // retrieval would match nothing. Answering anyway produces a confident reply
  // to a question we never read; say plainly that it should be asked again.
  if (translationFailed) {
    trace.outcome = "translation_failed";
    trace.failureReason = "the language model was unavailable";
    const message =
      "Sorry — the service is busy right now and your question could not be processed. Please try again in a moment.";
    return {
      answer: await translateFromEnglish(message, detectedLanguageCode, detectedLanguageName, { cache: true }),
      answerEnglish: message,
      detectedLanguageCode,
      detectedLanguageName,
      sources: [],
    };
  }

  const history = await loadHistory(farmerId, sessionId);
  const followUp = isFollowUp(translatedQuestion, history);
  trace.followUp = followUp;

  // GreenGuide answers about schemes/loans, weather and mandi prices. Anything
  // else is declined here rather than left to the model, which otherwise answers
  // confidently and off-mission. Crop/pest/soil questions get their own redirect
  // to the local KVK, since we have no agronomy data. Checked on the English
  // translation so one rule covers every supported language.
  const category = await classifyQuestion(translatedQuestion, { followUp });
  trace.intent = category;
  if (category === "out" || category === "agronomy") {
    trace.outcome = "declined";
    const declineMessage = category === "agronomy" ? AGRONOMY_MESSAGE : OUT_OF_SCOPE_MESSAGE;
    return {
      answer: await translateFromEnglish(declineMessage, detectedLanguageCode, detectedLanguageName, { cache: true }),
      answerEnglish: detectedLanguageCode === "en" ? undefined : declineMessage,
      detectedLanguageCode,
      detectedLanguageName,
      translatedQuestion: detectedLanguageCode === "en" ? undefined : translatedQuestion,
      sources: [],
      outOfScope: true,
      reason: category,
    };
  }

  // Weather questions are answered from live data for the farmer's district and
  // never touch scheme retrieval (which otherwise matched "rain" to crop insurance).
  if (isWeatherQuestion(translatedQuestion)) {
    trace.intent = "weather";
    // Every district the farmer has land in (or just the one the question names), so a
    // farmer with plots in several places is not told about only the newest. A failed
    // lookup is reported as such, never as "you have no district".
    let weatherLands = [];
    let landLookupFailed = false;
    try {
      weatherLands = await findFarmerLands(farmerId, { throwOnError: true });
    } catch (e) {
      landLookupFailed = true;
    }

    const { answer: weatherEnglish, source } = await answerWeatherQuestion({
      question: translatedQuestion,
      lands: weatherLands,
      landLookupFailed,
    });
    trace.outcome = source ? "answered" : weatherEnglish === NO_DISTRICT_MESSAGE ? "needs_district" : "weather_failed";
    if (!source && trace.outcome === "weather_failed") trace.failureReason = landLookupFailed ? "land lookup failed" : "weather service failed";
    const isEnglish = detectedLanguageCode === "en";
    return {
      answer: isEnglish ? weatherEnglish : await translateFromEnglish(weatherEnglish, detectedLanguageCode, detectedLanguageName),
      answerEnglish: isEnglish ? undefined : weatherEnglish,
      detectedLanguageCode: detectedLanguageCode || "en",
      detectedLanguageName: detectedLanguageName || "English",
      translatedQuestion: isEnglish ? undefined : translatedQuestion,
      sources: source ? [source] : [],
      weather: true,
    };
  }

  // Mandi prices are looked up per land record on the Loan Assistant page.
  if (category === "mandi") {
    trace.outcome = "answered";
    return plainAnswer({
      english: MANDI_POINTER_MESSAGE,
      detectedLanguageCode,
      detectedLanguageName,
      translatedQuestion,
    });
  }

  // The farmer as a whole: ALL their land records (eligibility limits are on the total
  // holding, not the newest plot) and what they saved in "About you". Best-effort and
  // non-fatal: with no records the question is simply answered without profile context.
  // Loaded before searching, because the states their land is in decide which state schemes
  // they may be shown.
  const { lands, facts: farmer, verifiedFields, summary } = await loadFarmerContext(farmerId);
  const states = summary.states;

  // A follow-up is searched together with what it refers to; a standalone question on its own.
  const retrievalQuery = followUp ? contextualQuery(translatedQuestion, history) : translatedQuestion;
  const retrievedSchemes = followUp
    ? pinDiscussedScheme(retrieveSchemesForQuestion(retrievalQuery, 3, { states }), history)
    : retrieveSchemesForQuestion(retrievalQuery, 3, { states });
  trace.retrieval = retrievedSchemes.map((s) => ({ id: s.id, score: s.matchScore }));
  // the best raw score is kept even when nothing was good enough, to see how near the misses are
  trace.topScore = retrievedSchemes[0]?.matchScore ?? retrieveSchemes(retrievalQuery, 1, { states })[0]?.matchScore ?? 0;

  // Nothing in the scheme documents matched well enough. Say so rather than
  // letting the model produce a confident answer from an unrelated scheme.
  if (retrievedSchemes.length === 0) {
    trace.outcome = "no_match";
    return plainAnswer({
      english: NO_SCHEME_MATCH_MESSAGE,
      detectedLanguageCode,
      detectedLanguageName,
      translatedQuestion,
    });
  }

  const answerEnglish = await generateAnswerFromContext({
    question: translatedQuestion,
    retrievedSchemes,
    land: lands[0] ?? null,
    lands,
    farmer,
    verifiedFields,
    history,
  });
  trace.sources = retrievedSchemes.map((s) => s.id);
  trace.outcome = answerEnglish === FALLBACK_ANSWER ? "generation_failed" : "answered";
  if (trace.outcome === "generation_failed") trace.failureReason = "the language model could not write an answer";
  else await rememberTurn({ farmerId, sessionId, question: translatedQuestion, answer: answerEnglish, intent: "scheme", schemeIds: trace.sources });

  // Say how recent the scheme details are (or that nobody has checked them yet). Added to what the
  // farmer reads, not to what is remembered for the conversation.
  const footer = freshnessFooter(retrievedSchemes);
  const shownEnglish = footer && trace.outcome === "answered" ? `${answerEnglish}\n\n${footer}` : answerEnglish;

  const isEnglish = detectedLanguageCode === "en";
  const answer = isEnglish
    ? shownEnglish
    : await translateFromEnglish(shownEnglish, detectedLanguageCode, detectedLanguageName);

  return {
    answer,
    answerEnglish: isEnglish ? undefined : shownEnglish,
    detectedLanguageCode: detectedLanguageCode || "en",
    detectedLanguageName: detectedLanguageName || "English",
    translatedQuestion: isEnglish ? undefined : translatedQuestion,
    sources: retrievedSchemes.map((s) => s.name),
    // per scheme: when it was last checked against an official source (null = not yet), and where
    schemeInfo: retrievedSchemes.map((s) => ({ id: s.id, name: s.name, ...freshnessOf(s) })),
  };
}

const describeCalls = (stats) =>
  stats.total === 0
    ? "0 model calls"
    : `${stats.total} model call${stats.total === 1 ? "" : "s"} (${Object.entries(stats.byPurpose).map(([k, v]) => `${k} ${v}`).join(", ")})` +
      (stats.attempts !== stats.total ? `, ${stats.attempts} HTTP attempts` : "");

/**
 * Answers a question and logs what it cost: how many model calls, and what for. English questions
 * and fixed replies should cost 0-1; a Marathi scheme question is 3 (translate in, answer,
 * translate back). Retries after a rate limit show up as extra HTTP attempts.
 */
async function runQuestion(args, channel) {
  const started = Date.now();
  const trace = { channel };
  try {
    const { result, stats } = await withCallStats(() => answerFarmerQuestion({ ...args, trace }));
    const ms = Date.now() - started;
    console.log(`💬 ${channel} question answered with ${describeCalls(stats)} in ${ms} ms`);
    // Fire and forget: logging must never slow or fail a question (see services/questionLog.js).
    recordQuestion({ ...trace, modelCalls: stats, ms, answerChars: result.answer?.length ?? 0 });
    return result;
  } catch (err) {
    const ms = Date.now() - started;
    if (err.modelCalls) console.log(`💬 ${channel} question FAILED after ${describeCalls(err.modelCalls)} in ${ms} ms: ${err.message}`);
    recordQuestion({ ...trace, outcome: "error", failureReason: err.message, modelCalls: err.modelCalls, ms });
    throw err;
  }
}

/**
 * POST /api/farmers/:farmerId/query
 * Body: { question: string, language: "auto" | ISO code }
 */
export async function postFarmerQuery(req, res) {
  try {
    const { farmerId } = req.params;
    const { question, language, sessionId } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ error: "Question is required." });
    }

    const result = await runQuestion({ farmerId, question: question.trim(), language, sessionId }, "typed");
    res.json(result);
  } catch (err) {
    console.error("🔥 Error answering farmer query:", err.message);
    res.status(500).json({ error: "Failed to answer your question right now. Please try again." });
  }
}

/**
 * POST /api/farmers/:farmerId/query/voice
 * Body: raw audio bytes (Content-Type: audio/webm, audio/mp4, audio/wav, ...)
 * Query: ?language=mr|hi|auto — passed to Whisper as a hint and used for the reply
 *
 * Sent as a raw body rather than multipart so no upload-parsing dependency is
 * needed: the browser can POST a MediaRecorder Blob directly.
 *
 * Returns the same shape as the typed route, plus `transcript` so the UI can
 * show the farmer what was heard — important when speech recognition mishears,
 * since otherwise an odd answer looks like the assistant being wrong.
 */
export async function postFarmerVoiceQuery(req, res) {
  try {
    const { farmerId } = req.params;
    const language = req.query.language || "auto";
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const contentType = req.get("content-type");

    if (sessionId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
      return res.status(400).json({ error: "Please fix: Session is not valid." });
    }

    // Content-type is checked first: express.raw() only populates a Buffer for
    // types matching "audio/*", so a wrong type would otherwise fall through to
    // the empty-body branch and report "no audio" for what is really a format
    // problem the caller can fix.
    if (!isSupportedAudioType(contentType)) {
      return res.status(415).json({
        error: `Unsupported audio format "${contentType || "unknown"}". Send webm, mp4/m4a, mp3, ogg, wav, or flac.`,
      });
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "No audio was received." });
    }

    if (language !== "auto" && !SUPPORTED_LANGUAGES[language]) {
      return res.status(400).json({ error: `Unsupported language code "${language}".` });
    }

    const { text: transcript, language: detectedAudioLanguage } = await transcribeAudio(
      req.body,
      contentType,
      language
    );

    const result = await runQuestion({ farmerId, question: transcript, language, sessionId }, "voice");

    res.json({ transcript, detectedAudioLanguage, ...result });
  } catch (err) {
    console.error("🔥 Error answering farmer voice query:", err.message);
    // Transcription failures are the farmer's problem to act on ("we couldn't
    // hear you"), so surface those rather than flattening them into a 500.
    const isUserActionable =
      /no speech|too large|unsupported audio|busy right now|no audio/i.test(err.message);
    res.status(isUserActionable ? 400 : 500).json({
      error: isUserActionable
        ? err.message
        : "Failed to answer your question right now. Please try again.",
    });
  }
}

/**
 * DELETE /api/farmers/:farmerId/conversation?sessionId=...
 * Forgets what was said so far in a session ("start a new topic").
 */
export async function clearConversation(req, res) {
  try {
    const removed = await clearHistory(req.params.farmerId, req.query.sessionId);
    res.json({ cleared: removed });
  } catch (err) {
    console.error("Error clearing conversation:", err.message);
    res.status(500).json({ error: "Could not clear the conversation" });
  }
}

export { MAX_AUDIO_BYTES };
