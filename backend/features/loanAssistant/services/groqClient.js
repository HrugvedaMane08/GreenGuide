// Shared Groq HTTP layer.
//
// Each caller used to have its own copy of this fetch, and none of them handled
// 429. On the free tier the token-per-minute budget (8000 TPM) is small, and a
// single farmer question costs three calls — detect, generate, translate — with
// Devanagari costing 3-4x more tokens than English. So a handful of questions
// in a minute reliably exhausted the budget, and every caller turned that into
// a silent English fallback.
//
// Groq's 429 body states exactly how long to wait ("try again in 2.2875s"), so
// waiting that long and retrying turns a hard failure into a short delay.

import { AsyncLocalStorage } from "node:async_hooks";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// How many model calls does one question cost? Each call says what it is for (`purpose`), and
// anything run inside withCallStats() is tallied, so it can be logged per question without
// threading a counter through every function.
const callStats = new AsyncLocalStorage();

/**
 * Runs fn and returns { result, stats } where stats is
 * { total, byPurpose: { "translate-in": 1, generate: 1, ... }, attempts } (attempts counts HTTP
 * requests, so retries after a rate limit show up). If fn throws, the error carries `modelCalls`.
 */
export async function withCallStats(fn) {
  const raw = { calls: {}, attempts: 0 };
  const summarise = () => ({ total: Object.values(raw.calls).reduce((a, b) => a + b, 0), byPurpose: { ...raw.calls }, attempts: raw.attempts });
  try {
    const result = await callStats.run(raw, fn);
    return { result, stats: summarise() };
  } catch (err) {
    err.modelCalls = summarise();
    throw err;
  }
}

const MAX_RETRIES = 3;
const MAX_WAIT_MS = 15000;

function parseRetryDelayMs(response, bodyText) {
  const header = response.headers.get("retry-after");
  if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;

  // e.g. "Please try again in 2.2875s" / "in 1m12s"
  const m = /try again in ((?:\d+m)?[\d.]+)s/i.exec(bodyText || "");
  if (m) {
    const raw = m[1];
    const min = /(\d+)m/.exec(raw);
    const secs = parseFloat(raw.replace(/^\d+m/, "")) || 0;
    return ((min ? Number(min[1]) * 60 : 0) + secs) * 1000;
  }
  return 1000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST to Groq chat completions, retrying on rate limits and transient 5xx.
 * Returns the assistant message content (possibly an empty string).
 */
export async function callGroqRaw(messages, { temperature = 0.2, max_tokens = 500, model, purpose = "other" } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  const stats = callStats.getStore();
  if (stats) stats.calls[purpose] = (stats.calls[purpose] ?? 0) + 1;

  // This account has no Llama chat models; gpt-oss-20b is the configured
  // GROQ_MODEL and a safe last-resort default.
  const useModel = model || process.env.GROQ_MODEL || "openai/gpt-oss-20b";
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    if (stats) stats.attempts += 1;
    try {
      response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: useModel, temperature, max_tokens, messages }),
      });
    } catch (netErr) {
      // Network blip: back off briefly and try again.
      lastErr = netErr;
      if (attempt < MAX_RETRIES) { await sleep(500 * (attempt + 1)); continue; }
      throw netErr;
    }

    if (response.ok) {
      const data = await response.json();
      return data?.choices?.[0]?.message?.content || "";
    }

    const errText = await response.text();
    lastErr = new Error(`Groq API error ${response.status}: ${errText}`);

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_RETRIES) throw lastErr;

    const waitMs = Math.min(parseRetryDelayMs(response, errText), MAX_WAIT_MS);
    console.warn(
      `Groq ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}); waiting ${Math.round(waitMs)}ms.`
    );
    await sleep(waitMs);
  }

  throw lastErr;
}
