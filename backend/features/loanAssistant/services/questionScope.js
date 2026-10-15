// Decides whether a question is something GreenGuide can actually answer.
//
// It answers three things: government schemes/loans, weather for the farmer's
// district, and mandi prices. Anything else is turned away with a message that
// says so.
//
// An earlier version let broad farming words ("crop", "soil", "water", "land",
// "pest", "seed", "fertilizer"...) pass automatically. We have no agronomy data,
// so those questions were accepted and then answered weakly from whichever scheme
// shared a word. They now get a clear redirect to the local KVK instead.
//
// The check runs on the ENGLISH translation, after detection, so one keyword
// list serves every language the app supports.

import { callGroqRaw } from "./groqClient.js";
import { isWeatherQuestion } from "./weatherQuestion.js";

// Schemes, credit and money — the topics the scheme corpus covers.
const SCHEME_TERMS = [
  "scheme", "schemes", "yojana", "subsidy", "subsidies", "loan", "loans", "credit",
  "kcc", "kisan", "pm-kisan", "pmfby", "maandhan", "pension", "insurance", "premium",
  "eligib", "apply", "application", "document", "documents", "installment", "instalment",
  "benefit", "benefits", "interest", "repay", "bank", "grant", "fund", "compensation",
  "registration", "aadhaar", "beneficiary", "disburse",
  // The Soil Health Card is a scheme; plain "soil" is not.
  "soil health", "soil test",
];

// Mandi prices. The first group is unambiguous; the second ("price of") is only
// a mandi question when it isn't about an agronomy input ("price of fertilizer").
const MANDI_TERMS = ["mandi", "mandis", "msp", "agmarknet", "market price", "market rate", "modal price", "minimum support price"];
const MANDI_WEAK_TERMS = ["price of", "prices of", "selling price"];

// Farming-practice words. With none of the topics above they mean the farmer is
// asking for agronomy advice, which we have no data for.
const AGRONOMY_TERMS = [
  "crop", "crops", "pest", "pests", "seed", "seeds", "soil", "fertiliser", "fertilizer",
  "fertilisers", "fertilizers", "manure", "compost", "water", "irrigation", "irrigate",
  "disease", "diseases", "yield", "sow", "sowing", "harvest", "harvesting", "weed", "weeds",
  "insect", "insects", "fungus", "pesticide", "herbicide", "plant", "plants", "variety",
  "varieties", "cultivation", "cultivate", "grow", "growing",
];

// Clear out-of-scope signals: general knowledge, entertainment, chit-chat.
const OUT_OF_SCOPE_TERMS = [
  "prime minister", "president", "capital of", "who is", "who was", "history of",
  "joke", "jokes", "poem", "song", "movie", "film", "cricket", "football", "sport",
  "recipe", "cook", "translate", "python", "javascript", "code", "programming",
  "multiplied", "multiply", "divide", "plus", "minus", "calculate", "square root",
];

const WORD = (t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
const hasAny = (q, terms) => terms.some((t) => WORD(t).test(q));

/**
 * Keyword-only classification. Returns one of:
 *   "scheme" | "weather" | "mandi" | "agronomy" | "out" | "unknown"
 *
 * Order matters. A topical term beats a general one ("Who is eligible for
 * PM-KISAN?" contains "who is" but is about a scheme), and clear off-topic words
 * beat agronomy words ("a joke about crops" is a joke).
 */
export function keywordCategory(text) {
  const q = String(text || "").toLowerCase();
  if (!q.trim()) return "out";

  if (hasAny(q, SCHEME_TERMS)) return "scheme";
  if (isWeatherQuestion(q)) return "weather";

  const agronomy = hasAny(q, AGRONOMY_TERMS);
  if (hasAny(q, MANDI_TERMS) || (!agronomy && hasAny(q, MANDI_WEAK_TERMS))) return "mandi";

  if (hasAny(q, OUT_OF_SCOPE_TERMS)) return "out";
  if (agronomy) return "agronomy";
  return "unknown";
}

/**
 * Classifies a question. Keywords decide the clear cases; only genuinely
 * ambiguous ones cost an API call, and if that call fails the question is allowed
 * through as a scheme question: a wrongly rejected real question is worse for a
 * farmer than a wrongly accepted one, and retrieval still has to find a match
 * before anything is answered.
 */
export async function classifyQuestion(englishQuestion, { followUp = false } = {}) {
  const category = keywordCategory(englishQuestion);
  if (category !== "unknown") return category;

  // "and for my wife?" has no topic words, but it is a continuation of a scheme conversation
  // that was already judged in scope, so it needs no model call to decide that.
  if (followUp) return "scheme";

  try {
    const raw = await callGroqRaw(
      [
        {
          role: "user",
          content:
            `Does this question ask about government schemes, agricultural loans/subsidies, weather, or mandi (market) prices?\n\n` +
            `Question: "${englishQuestion}"\n\n` +
            `Answer with exactly one word: YES or NO.`,
        },
      ],
      { model: process.env.GROQ_TRANSLATION_MODEL || "qwen/qwen3.8-27b", max_tokens: 200, temperature: 0, purpose: "scope" }
    );
    const answer = raw.trim().toUpperCase();
    if (answer.includes("NO")) return "out";
    return "scheme";
  } catch (err) {
    console.warn(`Scope check failed (${err.message}); allowing the question through.`);
    return "scheme";
  }
}

/** True if the question is one we can answer (scheme, weather or mandi). */
export async function isInScope(englishQuestion) {
  const category = await classifyQuestion(englishQuestion);
  return category !== "out" && category !== "agronomy";
}

// Shown for questions that are not about our topics at all.
export const OUT_OF_SCOPE_MESSAGE =
  "I can only help with government schemes, weather and mandi prices. " +
  "Please ask me something about those — for example, which scheme you could apply for, or whether rain is expected.";

// Shown for crop, pest, soil and fertilizer questions: they are about farming, so
// a flat refusal would be unhelpful, but we have no data to answer from.
export const AGRONOMY_MESSAGE =
  "I can help with government schemes, weather and mandi prices. " +
  "For crop/pest advice, please contact your local KVK or agriculture office.";

// Shown when a scheme question matches nothing in the scheme documents well
// enough to answer from.
export const NO_SCHEME_MATCH_MESSAGE =
  "I couldn't find this in the scheme documents. Please check with your local agriculture office, " +
  "or ask about a specific scheme such as PM-KISAN, Kisan Credit Card or crop insurance.";

// Mandi prices are looked up per land record on the Loan Assistant page.
export const MANDI_POINTER_MESSAGE =
  "Today's mandi prices for your crop are shown on the Loan Assistant page. " +
  "Choose your land record there and the Mandi Price card appears below it.";
