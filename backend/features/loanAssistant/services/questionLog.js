// Records what was asked and how it went, so the most common questions and the failures can be
// seen (GET /api/admin/question-stats), without recording who asked.
//
// What goes in: when, channel, language, the kind of question, whether it was a follow-up, the
// outcome and (for failures) a short reason, how well the retrieved schemes matched, the schemes
// used, and how many model calls it cost.
// What stays out: the farmer's id and session, their original wording, and the answer text
// (answers quote the farmer's own land and details). The question itself is kept only as
// scrubbed, lower-cased English.
//
// Limit: scrubbing removes anything shaped like a number, e-mail address, link or PAN, but it
// cannot recognise a NAME typed into a question. Rows delete themselves after 90 days.

import QuestionLog from "../models/QuestionLog.js";

export const FAILED_OUTCOMES = ["no_match", "translation_failed", "generation_failed", "weather_failed", "error"];

/** Lower-cases, and replaces e-mail addresses, links, PAN-like ids and long numbers with placeholders. */
export function scrubForLog(text, max = 200) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+/g, "<link>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b[a-z]{5}\d{4}[a-z]\b/g, "<id>") // PAN
    .replace(/\+?\d[\d\s().-]{5,}\d/g, "<number>") // phone, Aadhaar, account numbers: 7+ digits with separators
    .replace(/\b\d{4,}\b/g, "<number>") // any other long number, amounts included
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Stores one log row. Best-effort and silent: logging must never slow or fail a question.
 * Returns the promise so tests can wait for it; callers in the request path do not.
 */
export async function recordQuestion(trace, { Model = QuestionLog } = {}) {
  if (Model?.db?.readyState !== undefined && Model.db.readyState !== 1) return null;
  try {
    return await Model.create({
      at: new Date(),
      channel: trace.channel,
      language: trace.language,
      intent: trace.intent,
      followUp: Boolean(trace.followUp),
      outcome: trace.outcome ?? "answered",
      failureReason: trace.failureReason ? scrubForLog(trace.failureReason, 200) : undefined,
      question: scrubForLog(trace.question),
      retrieval: trace.retrieval ?? [],
      topScore: trace.topScore,
      sources: trace.sources ?? [],
      modelCalls: trace.modelCalls
        ? { total: trace.modelCalls.total, byPurpose: trace.modelCalls.byPurpose, attempts: trace.modelCalls.attempts }
        : undefined,
      ms: trace.ms,
      answerChars: trace.answerChars,
    });
  } catch (err) {
    console.warn(`Could not log question: ${err.message}`);
    return null;
  }
}

/**
 * The picture for admins: volumes, the most common questions, the ones that failed, and what is
 * being declined. All figures are for the last `days` days.
 */
export async function questionStats({ days = 30, limit = 20 } = {}, { Model = QuestionLog, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400000);
  const group = (field) => [{ $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }];
  const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id ?? "unknown", r.n]));

  const [facets] = await Model.aggregate([
    { $match: { at: { $gte: since } } },
    {
      $facet: {
        total: [{ $count: "n" }],
        byIntent: group("intent"),
        byLanguage: group("language"),
        byOutcome: group("outcome"),
        byChannel: group("channel"),
        followUps: [{ $match: { followUp: true } }, { $count: "n" }],
        modelCalls: [{ $group: { _id: null, avg: { $avg: "$modelCalls.total" }, max: { $max: "$modelCalls.total" } } }],
        top: [
          // Follow-ups ("and the interest rate?") mean nothing without the conversation, so they are
          // counted (followUps) but kept out of the list of common questions.
          { $match: { question: { $nin: [null, ""] }, followUp: { $ne: true } } },
          { $group: { _id: "$question", count: { $sum: 1 }, intent: { $first: "$intent" }, outcomes: { $addToSet: "$outcome" }, lastAsked: { $max: "$at" } } },
          { $sort: { count: -1, lastAsked: -1 } },
          { $limit: limit },
        ],
        failed: [
          { $match: { outcome: { $in: FAILED_OUTCOMES } } },
          { $group: { _id: { question: "$question", outcome: "$outcome" }, count: { $sum: 1 }, intent: { $first: "$intent" }, failureReason: { $first: "$failureReason" }, bestScore: { $max: "$topScore" }, lastAsked: { $max: "$at" } } },
          { $sort: { count: -1, lastAsked: -1 } },
          { $limit: limit },
        ],
        declined: [
          { $match: { outcome: "declined" } },
          { $group: { _id: "$question", count: { $sum: 1 }, intent: { $first: "$intent" }, lastAsked: { $max: "$at" } } },
          { $sort: { count: -1, lastAsked: -1 } },
          { $limit: limit },
        ],
      },
    },
  ]);

  const total = facets.total[0]?.n ?? 0;
  const tidy = (rows, keyed) => rows.map((r) => (keyed ? { question: r._id.question, outcome: r._id.outcome, ...strip(r) } : { question: r._id, ...strip(r) }));
  const strip = ({ _id, ...rest }) => rest;

  return {
    window: { days, since, total },
    byIntent: toMap(facets.byIntent),
    byLanguage: toMap(facets.byLanguage),
    byOutcome: toMap(facets.byOutcome),
    byChannel: toMap(facets.byChannel),
    followUps: facets.followUps[0]?.n ?? 0,
    modelCalls: { average: Math.round((facets.modelCalls[0]?.avg ?? 0) * 100) / 100, max: facets.modelCalls[0]?.max ?? 0 },
    topQuestions: tidy(facets.top, false),
    failed: tidy(facets.failed, true),
    topDeclined: tidy(facets.declined, false),
  };
}
