import { summarizeLands } from "./farmerContext.js";
import { freshnessOf } from "./schemeFreshness.js";
import {
  checkSchemeRestrictions,
  buildEligibilityFactsBlock,
  buildEligibilityProfile,
  evaluateSchemeEligibility
} from "./schemeEligibilityChecks.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

export function buildPrompt(farmerContext, retrievedSchemes) {
  const { land, lands, loanApplication } = farmerContext;

  // A farmer with several plots is judged on their whole holding, so say so.
  let holdingLine = "";
  if (lands?.length > 1) {
    const holding = summarizeLands(lands);
    holdingLine = `\n- Whole holding: ${holding.totalAcres} acres across ${holding.plots} plots; crops: ${holding.crops.join(", ") || "?"}`;
  }
  const profileSummary = `
Farmer profile:
- Location: ${land?.district || "?"}, ${land?.state || "?"}
- Land: ${land?.areaAcres ?? "?"} acres, soil: ${land?.soilType || "?"}, irrigation: ${land?.irrigationType || "?"}
- Primary crop: ${land?.primaryCrop || "?"}${holdingLine}
- Loan purpose: ${loanApplication?.purpose || "?"}
- Requested amount: ${loanApplication?.requestedAmount ?? "?"}
- Annual income: ${loanApplication?.annualIncome ?? "?"}
- Eligibility status (ML score): ${loanApplication?.eligibilityStatus || "?"}
`.trim();

  const schemesBlock = retrievedSchemes
    .map(
      (s, i) => `
Scheme ${i + 1} (id: ${s.id}): ${s.name}
Description: ${s.description}
Eligibility criteria: ${(s.eligibilityCriteria || []).join("; ")}
Required documents: ${(s.requiredDocuments || []).join("; ")}
`.trim()
    )
    .join("\n\n");

  // Eligibility verdicts are computed in code, not left to the model. Relying on
  // the model to read the eligibility prose correctly only worked about half the
  // time (it would call sugarcane a covered annual crop, or claim 4 acres exceeded
  // the 2-hectare limit when 4 acres is 1.62 ha). The same verdicts are returned
  // to the screen, so the text and the badge cannot disagree.
  const factsBlock = buildEligibilityFactsBlock(retrievedSchemes, buildEligibilityProfile(farmerContext));

  return `You are an assistant helping an Indian farmer understand which government schemes they may qualify for.

${profileSummary}

Here are the ${retrievedSchemes.length} candidate schemes retrieved for this farmer, ranked by relevance:

${schemesBlock}
${factsBlock ? `\n${factsBlock}\n` : ""}
For each scheme, write:
1. A short (2-3 sentence) plain-language explanation of why it may be relevant to THIS farmer specifically.
   - IMPORTANT: base this strictly on the farmer's actual loan status above. If eligibility status is
     "not_eligible" or "review", do NOT say or imply they have already "availed" or been granted the loan —
     phrase relevance conditionally (e.g. "if your loan is approved" / "once you take a crop loan").
     Only use language implying an active/disbursed loan when eligibility status is "eligible".
   - IMPORTANT: every scheme has a VERIFIED ELIGIBILITY line, and it overrides your own reading of the
     eligibility criteria. NOT ELIGIBLE: say plainly that the farmer does not qualify and give the reason;
     do not describe the scheme as something they can apply for. NEEDS MORE INFO: say what they need to
     confirm and do not claim they qualify. ELIGIBLE: you may say they appear to qualify. Never contradict it.
2. A checklist of the documents they need to apply, based on the "Required documents" given above.

Respond with ONLY valid JSON (no markdown fences, no commentary), in this exact shape:
{
  "explanations": [
    { "schemeId": "string", "explanation": "string", "documentChecklist": ["string", "..."] }
  ]
}`;
}

function stripCodeFences(text) {
  return text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

/**
 * Calls Groq to generate a plain-language explanation + document checklist
 * for each retrieved scheme. Falls back to a deterministic response built
 * from the corpus data if the API call or parsing fails, so the endpoint
 * never hard-fails just because generation had a problem.
 */
export async function generateSchemeExplanations(farmerContext, retrievedSchemes) {
  if (!retrievedSchemes || retrievedSchemes.length === 0) {
    return [];
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn("GROQ_API_KEY not set — returning fallback (non-LLM) explanations");
    return fallbackExplanations(retrievedSchemes, farmerContext?.land, buildEligibilityProfile(farmerContext));
  }

  const land = farmerContext?.land;
  const profile = buildEligibilityProfile(farmerContext);

  try {
    const response = await postWithRetry(apiKey, {
      model: GROQ_MODEL,
      temperature: 0.3,
      // GROQ_MODEL (openai/gpt-oss-*) is a reasoning model: reasoning tokens count
      // toward completion_tokens BEFORE any content is emitted. At max_tokens 1200
      // the JSON answer was always truncated (finish_reason: "length") and
      // JSON.parse silently fell back to the plain descriptions — which is why
      // earlier prompt tweaks (crop-type / loan-status hedging) appeared to do
      // nothing. "low" reasoning effort cuts reasoning from ~600-1300 tokens to
      // ~15 (keeps us well under the 8000 TPM free-tier limit) with no loss of
      // answer quality; 2500 leaves ample headroom for 3 scheme explanations.
      max_tokens: 2500,
      reasoning_effort: "low",
      // Force well-formed JSON so a truncated/prose response can't slip through.
      response_format: { type: "json_object" },
      messages: [
        { role: "user", content: buildPrompt(farmerContext, retrievedSchemes) }
      ]
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Groq API error:", response.status, errText);
      return fallbackExplanations(retrievedSchemes, land, profile);
    }

    const data = await response.json();
    const rawText = data?.choices?.[0]?.message?.content || "";
    const cleaned = stripCodeFences(rawText);
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed.explanations)) {
      throw new Error("Unexpected Groq response shape");
    }

    // Merge generated explanations back onto the retrieved scheme objects,
    // keyed by schemeId, so name/category/matchScore are preserved.
    return retrievedSchemes.map((scheme) => {
      const generated = parsed.explanations.find((e) => e.schemeId === scheme.id);
      const eligibility = evaluateSchemeEligibility(scheme, profile);
      return {
        schemeId: scheme.id,
        name: scheme.name,
        category: scheme.category,
        matchScore: scheme.matchScore,
        // when this scheme's details were last checked against an official source (null = not yet)
        freshness: freshnessOf(scheme),
        // A hard disqualifier is stated by code, not left to the model's wording.
        explanation: eligibility.verdict === "not_eligible"
          ? `You do not qualify for this scheme: ${eligibility.reason}`
          : generated?.explanation || scheme.description,
        documentChecklist: generated?.documentChecklist || scheme.requiredDocuments || [],
        // Structured verdicts travel with the response so the UI can surface a
        // caveat even if the generated prose glosses over one.
        eligibilityFlags: checkSchemeRestrictions(scheme, land),
        // Deterministic verdict from data/schemeRules.json: eligible / not_eligible / needs_more_info.
        eligibility
      };
    });
  } catch (err) {
    console.error("Groq generation failed, using fallback:", err.message);
    return fallbackExplanations(retrievedSchemes, land, profile);
  }
}

/**
 * POSTs to Groq, retrying once on a 429. The free tier is 8000 tokens/minute,
 * which two scheme-match requests in the same minute will exceed — without this
 * the second one silently degrades to the non-LLM fallback. Groq reports how
 * long to wait both in the Retry-After header and in the error message.
 */
async function postWithRetry(apiKey, body, { retries = 1 } = {}) {
  let response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  for (let attempt = 0; attempt < retries && response.status === 429; attempt++) {
    const waitSeconds = parseRetryAfter(response) ?? 5;
    // Cap the wait so a request can't hang the caller for minutes.
    const waitMs = Math.min(waitSeconds, 15) * 1000;
    console.warn(`Groq rate limited (429) — retrying in ${waitMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
  }

  return response;
}

function parseRetryAfter(response) {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header;
  return null;
}

/**
 * Non-LLM fallback so the feature degrades gracefully instead of breaking
 * (missing/invalid API key, Groq outage, malformed response, etc.)
 */
function fallbackExplanations(retrievedSchemes, land, profile) {
  return retrievedSchemes.map((scheme) => {
    const eligibilityFlags = checkSchemeRestrictions(scheme, land);
    const eligibility = evaluateSchemeEligibility(scheme, profile);

    // The eligibility rules don't need the LLM, so the verdict still reaches the
    // farmer even when generation fails — otherwise the fallback hands them a
    // bare scheme description with no hint that it may not apply to them.
    const explanation =
      eligibility.verdict === "not_eligible"
        ? `You do not qualify for this scheme: ${eligibility.reason}`
        : eligibility.verdict === "needs_more_info"
          ? `${scheme.description} Note: ${eligibility.reason}`
          : scheme.description;

    return {
      schemeId: scheme.id,
      name: scheme.name,
      category: scheme.category,
      matchScore: scheme.matchScore,
      explanation,
      freshness: freshnessOf(scheme),
      documentChecklist: scheme.requiredDocuments || [],
      eligibilityFlags,
      eligibility
    };
  });
}
