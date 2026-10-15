// Cheap, deterministic language checks, so the model is only asked when it is needed.
//
// Every question used to start with a model call that detected the language and translated it
// to English, even when the farmer had chosen English or typed plain English. That call is
// now skipped when the text is plainly English, and Hindi/Marathi typed in English letters
// ("mujhe loan chahiye") is recognised by keywords instead of being left to the model, which
// would sometimes call it English and answer in English.
//
// Order of trust: the SCRIPT is ground truth (Devanagari is never English), then an explicit
// language choice, then keywords. Anything unclear goes to the model, as before.

const DEVANAGARI = /[ऀ-ॿ]/;

// Typographic characters that appear in English text typed on a phone; they are not a language signal.
const TYPOGRAPHIC = /[‘’“”–—…₹• ]/g;

export const hasDevanagari = (text) => DEVANAGARI.test(String(text ?? ""));

/** True if the text is plain ASCII once phone punctuation (curly quotes, dashes, the rupee sign) is ignored. */
export function isPlainAscii(text) {
  return /^[\x00-\x7F]*$/.test(String(text ?? "").replace(TYPOGRAPHIC, " "));
}

// Words that Hindi / Marathi speakers type in Latin letters. "Distinctive" words essentially never
// occur in English, so one is enough; the others (hai, tha, toh...) could appear in English text
// (a typo for "hi", a name), so they only count towards the two-word minimum.
// Deliberately left OUT because they are ordinary English or appear in English scheme names:
// main, me, kisan, yojana, ka, ki, ke, pan, kara.
const HINDI = {
  distinctive: ["mujhe", "mujhko", "mera", "meri", "mere", "hamara", "hamari", "hamare", "humein", "hume", "chahiye", "chahie", "kaise", "kaisa", "kaisi", "kitna", "kitni", "kitne", "kyun", "kyon", "kya", "kab", "kahan", "kaun", "kaunsi", "kaunsa", "nahi", "nahin", "hoga", "hogi", "milega", "milegi", "milta", "milti", "batao", "bataiye", "batayein", "paisa", "paise", "fasal", "kheti", "zameen", "barish", "baarish", "sarkari", "sakta", "sakti", "sakte", "karna", "karni", "karne", "karein", "liye"],
  weak: ["hai", "hain", "tha", "thi", "honge", "aap", "apna", "apni", "apne", "aur", "bhi", "kuch", "koi", "toh", "agar", "lena", "dena", "wala", "wali", "wale", "sarkar", "karo"],
};
const MARATHI = {
  distinctive: ["mala", "tumhi", "tumchya", "majhi", "majha", "maza", "maze", "pahije", "pahijet", "kasa", "kashi", "kase", "kiti", "kuthe", "kadhi", "kaay", "milel", "milte", "milto", "shetkari", "sheti", "shetat", "pavsa", "pavsat", "aaplya", "aaplyala", "karaycha", "karayche", "sanga", "sangaa", "nahi"],
  weak: ["ahe", "aahe", "aahet", "ahet", "kay", "pik", "dya", "dyaa"],
};

const words = (text) => String(text ?? "").toLowerCase().match(/[a-z']+/g) ?? [];

function score(tokens, list) {
  const distinctive = tokens.filter((t) => list.distinctive.includes(t)).length;
  const weak = tokens.filter((t) => list.weak.includes(t)).length;
  return { distinctive, total: distinctive + weak };
}

/** "hi" | "mr" | null: which language plain-ASCII text is, judged by keywords. Needs 1 distinctive word or 2 of any. */
export function romanisedLanguage(text) {
  const tokens = words(text);
  const hi = score(tokens, HINDI);
  const mr = score(tokens, MARATHI);
  const hiOk = hi.distinctive >= 1 || hi.total >= 2;
  const mrOk = mr.distinctive >= 1 || mr.total >= 2;
  if (hiOk && (!mrOk || hi.total >= mr.total)) return "hi"; // a tie goes to Hindi
  if (mrOk) return "mr";
  return null;
}

// A small model translates Hindi/Marathi typed in English letters poorly on exactly the farming
// words that matter (it turned "pik vima", crop insurance, into "bike insurance"). These are given
// to it as a glossary, only for the words actually present, so no extra call and no guessing.
const GLOSSARY = {
  pik: "crop", fasal: "crop", vima: "insurance", bima: "insurance", anudan: "subsidy", karj: "loan", karz: "loan", rin: "loan",
  kisan: "farmer", shetkari: "farmer", sheti: "farming", kheti: "farming", zameen: "land", jamin: "land", jameen: "land",
  barish: "rain", baarish: "rain", pavsa: "rain", pavsat: "rain", yojana: "government scheme", mafi: "waiver (of a debt)",
  bhav: "price", bhaav: "price", mandi: "market (mandi)", bazar: "market", khad: "fertiliser", beej: "seed", pani: "water",
  kapus: "cotton", kapas: "cotton", gahu: "wheat", gehu: "wheat", kanda: "onion", pyaz: "onion", dhan: "rice (paddy)",
};

/** "word = meaning" lines for the glossary words that appear in the text (empty if none). */
export function glossaryFor(text) {
  const seen = new Set();
  const lines = [];
  for (const w of words(text)) {
    if (GLOSSARY[w] && !seen.has(w)) {
      seen.add(w);
      lines.push(`${w} = ${GLOSSARY[w]}`);
    }
  }
  return lines;
}

const NAMES = { hi: "Hindi", mr: "Marathi", en: "English" };

/**
 * What can be decided without the model.
 *
 *   { kind: "english" }                              plainly English: no detection or translation call
 *   { kind: "known", code, name, script }            language settled (Devanagari or romanised); the model
 *                                                    is still needed to translate, but not to detect
 *   { kind: "unknown" }                              ask the model, as before
 *
 * @param {string} text
 * @param {string} hint  "auto" | "en" | "hi" | "mr" (the farmer's dropdown / the speech language)
 */
export function classifyLanguage(text, hint) {
  const chosen = hint && hint !== "auto" ? hint : null;

  // Devanagari is never English, whatever was chosen. A Hindi/Marathi choice settles which; otherwise Hindi.
  if (hasDevanagari(text)) {
    const code = chosen === "mr" ? "mr" : "hi";
    return { kind: "known", code, name: NAMES[code], script: "devanagari" };
  }

  // Some other script (Tamil, Bengali...): not something we can judge here.
  if (!isPlainAscii(text)) return { kind: "unknown" };

  // The farmer said English, and the text is in English letters: believe them.
  if (chosen === "en") return { kind: "english" };

  const romanised = romanisedLanguage(text);
  if (romanised || chosen === "hi" || chosen === "mr") {
    // They picked Hindi/Marathi and typed Latin letters we cannot read as either: let the model decide.
    if (!romanised) return { kind: "unknown" };
    const code = chosen === "hi" || chosen === "mr" ? chosen : romanised;
    return { kind: "known", code, name: NAMES[code], script: "latin" };
  }

  return { kind: "english" };
}
