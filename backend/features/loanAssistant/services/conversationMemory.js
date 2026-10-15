// Remembers the last few messages of a conversation so that a follow-up can be understood.
//
// Today every question stands alone: "and the interest rate?" after a Kisan Credit Card
// question was answered across three different schemes, and "how do I apply for it?" failed
// outright ("I couldn't find this"). With memory, a short referring question is searched
// together with what it refers to, and the recent exchange goes to the answer step.
//
// Retention: messages are English text, deleted by the database after 6 hours, and only the last
// 6 from the last 30 minutes are ever read. A session is whatever id the page sends; a farmer
// who does not send one shares a single "default" conversation.

import ConversationMessage from "../models/ConversationMessage.js";
import { getAllSchemes, mentionsSchemeByName } from "./schemeRetrieval.js";

export const MEMORY = { maxMessages: 6, windowMinutes: 30, maxChars: 600 };

const clip = (text, n = MEMORY.maxChars) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const keyOf = (farmerId, sessionId) => ({ farmerId, sessionId: sessionId || "default" });
const connected = (Model) => Model?.db?.readyState === undefined || Model.db.readyState === 1;

/** The recent messages for this session, oldest first: [{ role, text, intent, schemeIds }]. [] if none or unavailable. */
export async function loadHistory(farmerId, sessionId, { now = new Date(), Model = ConversationMessage } = {}) {
  if (!farmerId || !connected(Model)) return [];
  try {
    const since = new Date(now.getTime() - MEMORY.windowMinutes * 60000);
    const docs = await Model.find({ ...keyOf(farmerId, sessionId), createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(MEMORY.maxMessages)
      .lean();
    return docs.reverse().map((d) => ({ role: d.role, text: d.text, intent: d.intent, schemeIds: d.schemeIds ?? [] }));
  } catch (err) {
    console.warn(`Could not load conversation history: ${err.message}`);
    return [];
  }
}

/** Stores one question/answer exchange. Best-effort: never fails the question. */
export async function rememberTurn({ farmerId, sessionId, question, answer, intent, schemeIds = [] }, { now = new Date(), Model = ConversationMessage } = {}) {
  if (!farmerId || !connected(Model)) return;
  try {
    await Model.insertMany([
      { ...keyOf(farmerId, sessionId), role: "user", text: clip(question), createdAt: now },
      // a millisecond later, so the pair always sorts user -> assistant
      { ...keyOf(farmerId, sessionId), role: "assistant", text: clip(answer), intent, schemeIds, createdAt: new Date(now.getTime() + 1) },
    ]);
  } catch (err) {
    console.warn(`Could not store conversation turn: ${err.message}`);
  }
}

/** Forgets a session (used by "start a new topic"). */
export async function clearHistory(farmerId, sessionId, { Model = ConversationMessage } = {}) {
  if (!farmerId || !connected(Model)) return 0;
  return (await Model.deleteMany(keyOf(farmerId, sessionId))).deletedCount ?? 0;
}

// ---------------------------------------------------------------- understanding a follow-up

const CONNECTIVE = /^(and|also|then|so|ok|okay|but|or|what about|how about|what else|and what about)\b/i;
const PRONOUN = /\b(it|its|this|that|these|those|them|they|the same|that one|this one|the other one)\b/i;
// What people ask ABOUT a scheme once they know which one: documents, how to apply, amounts, dates...
const ASPECT = /\b(documents?|papers?|apply|application|eligib\w*|benefits?|amounts?|how much|last date|deadline|interest|rate|premium|limit|instal+ments?|process|steps|cost|fees?|charges?)\b/i;
// A subject of its own: if the question names one it needs no help from earlier messages.
const TOPIC = /\b(insurance|pension|loan|loans|credit|subsid\w*|fund|soil|scheme|schemes|yojana|msp|mandi|weather|rain|forecast)\b/i;

/**
 * Is this question leaning on what was said before? True when an earlier answer was about a scheme
 * and the question has no subject of its own but starts with "and..." / "what about...", points at
 * "it"/"that", asks only about an aspect ("the documents?"), or is just a few words.
 */
export function isFollowUp(question, history) {
  const lastSchemeAnswer = [...(history ?? [])].reverse().find((m) => m.role === "assistant" && m.intent === "scheme");
  if (!lastSchemeAnswer) return false;

  const q = String(question ?? "").trim();
  if (!q) return false;
  if (mentionsSchemeByName(q) || TOPIC.test(q)) return false; // it stands on its own

  const wordCount = q.split(/\s+/).length;
  return CONNECTIVE.test(q) || (PRONOUN.test(q) && wordCount <= 14) || ASPECT.test(q) || wordCount <= 4;
}

const schemeName = (id) => getAllSchemes({ all: true }).find((s) => s.id === id)?.name;

/**
 * The text to search with for a follow-up: the scheme the last answer was about, what was asked
 * before, and the new question. ("Kisan Credit Card (KCC) What documents does it need? and the interest rate?")
 */
export function contextualQuery(question, history) {
  const lastAnswer = [...(history ?? [])].reverse().find((m) => m.role === "assistant" && m.intent === "scheme");
  const lastQuestion = [...(history ?? [])].reverse().find((m) => m.role === "user")?.text ?? "";
  const topScheme = lastAnswer?.schemeIds?.[0] ? schemeName(lastAnswer.schemeIds[0]) : "";
  return [topScheme, lastQuestion, question].filter(Boolean).join(" ");
}

/**
 * For a follow-up, put the scheme the conversation was about first. Searching "and the interest
 * rate?" alongside "Kisan Credit Card" still ranks the Interest Subvention scheme first (the
 * word "interest" is its whole subject), but the farmer is asking about the card. The other
 * retrieved schemes stay after it, so a follow-up that really moves on is not cut off.
 */
export function pinDiscussedScheme(retrieved, history) {
  const lastAnswer = [...(history ?? [])].reverse().find((m) => m.role === "assistant" && m.intent === "scheme");
  const discussedId = lastAnswer?.schemeIds?.[0];
  if (!discussedId) return retrieved;

  const found = retrieved.find((s) => s.id === discussedId);
  const scheme = found ?? (() => { const s = getAllSchemes({ all: true }).find((x) => x.id === discussedId); return s && { ...s, matchScore: 0 }; })();
  if (!scheme) return retrieved;
  return [scheme, ...retrieved.filter((s) => s.id !== discussedId)].slice(0, 3);
}

/** The exchange as text for the answer prompt, or "" if there is none. */
export function formatHistoryForPrompt(history) {
  if (!history?.length) return "";
  return history.map((m) => `${m.role === "user" ? "Farmer" : "Assistant"}: ${clip(m.text, 350)}`).join("\n");
}
