// HTTP, model selection and rate-limit retries live in ./groqClient.js.
import { buildEligibilityFactsBlock, buildEligibilityProfile } from "./schemeEligibilityChecks.js";
import { callGroqRaw } from "./groqClient.js";
import { summarizeLands } from "./farmerContext.js";
import { formatHistoryForPrompt } from "./conversationMemory.js";

export const FALLBACK_ANSWER =
  "I'm not able to generate an answer right now due to a technical issue. Please try again in a moment, or check the Loan Assistant page for scheme details directly.";

export function buildPrompt({ question, retrievedSchemes, land, lands, farmer, verifiedFields, history }) {
  // All of the farmer's plots when known; `land` alone (one record) still works.
  const plots = lands?.length > 0 ? lands : land ? [land] : [];

  let profileLine = "";
  if (plots.length === 1) {
    const p = plots[0];
    profileLine = `Farmer context (may or may not be relevant to this question): location ${p.district || "?"}, ${p.state || "?"}; primary crop ${p.primaryCrop || "?"}; soil ${p.soilType || "?"}; irrigation ${p.irrigationType || "?"}.`;
  } else if (plots.length > 1) {
    const h = summarizeLands(plots);
    profileLine = `Farmer context (may or may not be relevant to this question): ${h.plots} land plots totalling ${h.totalAcres} acres; districts ${h.districts.join(", ") || "?"}; crops ${h.crops.join(", ") || "?"}; soil ${h.soilTypes.join(", ") || "?"}; irrigation ${h.irrigationTypes.join(", ") || "?"}.`;
  }
  const schemesBlock = retrievedSchemes.length
    ? retrievedSchemes
        .map(
          (s, i) => `
Scheme ${i + 1}: ${s.name}
Description: ${s.description}
Eligibility criteria: ${(s.eligibilityCriteria || []).join("; ")}
Required documents: ${(s.requiredDocuments || []).join("; ")}
`.trim()
        )
        .join("\n\n")
    : "(No closely matching scheme was found in the database for this question.)";

  const historyText = formatHistoryForPrompt(history);

  // Same deterministic eligibility verdicts the scheme-matching path returns, so
  // both surfaces give the farmer consistent answers instead of one hedging and
  // the other claiming blanket eligibility. Only included when we know the
  // farmer's land: with no record every verdict would be "needs more info".
  const factsBlock = plots.length > 0 ? buildEligibilityFactsBlock(retrievedSchemes, buildEligibilityProfile({ lands: plots, farmer, verifiedFields })) : "";

  return `You are a helpful assistant for Indian farmers using the GreenGuide app. Answer the farmer's question clearly and simply, in 3-6 sentences, in plain text (no markdown, no headers).
${profileLine}
Relevant scheme information retrieved from the database:
${schemesBlock}
${factsBlock ? `\n${factsBlock}\n` : ""}
${historyText ? `\nConversation so far (only to work out what the farmer is referring to):\n${historyText}\n` : ""}
Farmer's question:
"""${question}"""
Instructions:
- If the question is about government schemes/loans, base your answer ONLY on the scheme information given above — do not invent scheme names, amounts, or eligibility rules that aren't listed.
- IMPORTANT: if a scheme's eligibility criteria don't explicitly restrict it to certain crops, treat it as generally applicable rather than assuming the farmer's crop is excluded just because it isn't named. Only say a crop is ineligible if the criteria explicitly exclude it or explicitly limit coverage to a different, specific set of crops.
- Where a VERIFIED ELIGIBILITY line is given above, it overrides your own reading of the criteria and you must never contradict it. When the farmer is asking whether they qualify or can apply: NOT ELIGIBLE means say plainly that they do not qualify and why; NEEDS MORE INFO means say what they need to confirm and do not claim they qualify; ELIGIBLE means you may say they appear to qualify. When they are asking something else (documents, how it works, benefits), answer that and do not bring up eligibility unless it matters.
- If the retrieved scheme information doesn't actually answer the question, say so honestly and suggest checking the Loan Assistant page or a local agriculture office, rather than guessing.
- Answer only from the scheme information above. If the question is about something these schemes don't cover (for example crop, pest or soil advice), say you can only help with government schemes, weather and mandi prices, and suggest contacting the local KVK or agriculture office.
- If the farmer's question refers back to the conversation (for example "and the documents?" or "how do I apply for it?"), use the conversation to work out which scheme they mean and answer about that scheme.
- Keep the tone warm and simple, suitable for a farmer who may not be familiar with technical or bureaucratic language.`;
}

/**
 * Generates an English answer to a farmer's question, grounded in the
 * schemes retrieved via TF-IDF similarity (see schemeRetrieval.js).
 * Falls back to a generic apology message if Groq is unavailable, so the
 * endpoint never hard-fails.
 */
export async function generateAnswerFromContext({ question, retrievedSchemes, land, lands, farmer, verifiedFields, history }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn("GROQ_API_KEY not set — returning fallback answer");
    return FALLBACK_ANSWER;
  }
  try {
    // Via the shared client so a 429 waits out the stated delay instead of
    // going straight to the fallback. On the free tier's 8000 TPM budget a
    // single farmer question costs three calls, so rate limits are routine
    // rather than exceptional, and the fallback text reads like a real answer.
    const answer = await callGroqRaw(
      [{ role: "user", content: buildPrompt({ question, retrievedSchemes, land, lands, farmer, verifiedFields, history }) }],
      {
        temperature: 0.4,
        // Reasoning tokens count toward completion_tokens on GROQ_MODEL
        // (openai/gpt-oss-*), and at max_tokens 500 a normal answer finished
        // at 449 — one harder question away from being truncated mid-sentence.
        // 1200 leaves real headroom.
        max_tokens: 1200,
        purpose: "generate",
      }
    );
    return answer?.trim() || FALLBACK_ANSWER;
  } catch (err) {
    console.error("Answer generation failed, using fallback:", err.message);
    return FALLBACK_ANSWER;
  }
}