// How current is what we tell a farmer about a scheme?
//
// Scheme rules, amounts and dates change, and the notes in data/schemes.json were written by hand.
// Each scheme carries a `freshness` block: the official source URL and the date someone last
// checked the scheme against it. Both are null until a person has actually done that, and this
// module never guesses: an unchecked scheme says so, in plain words, in every answer.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD that is not in the future (a typo like 2062-10-01 must not look "fresh"). */
export function isValidCheckDate(value, now = new Date()) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getTime() <= now.getTime() + 86400000;
}

/** Only https links, and only ones that parse: this ends up in a page as a link. */
export function isSafeSourceUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** { lastVerified, sourceUrl } for a scheme; either is null when missing or malformed. */
export function freshnessOf(scheme, now = new Date()) {
  const f = scheme?.freshness ?? {};
  return {
    lastVerified: isValidCheckDate(f.lastVerified, now) ? f.lastVerified : null,
    sourceUrl: isSafeSourceUrl(f.sourceUrl) ? f.sourceUrl : null,
  };
}

/** "12 October 2026" */
export function formatCheckDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

const CONFIRM = "please confirm with your bank or local agriculture office before you apply";

/**
 * One English sentence for the end of an answer that used these schemes, saying how recently
 * their details were checked. "" if no scheme was used.
 *  - all checked:   the OLDEST check date (the answer is only as fresh as its least fresh scheme)
 *  - none checked:  a plain warning, not a date
 *  - a mix:         the date for the checked ones, and which are not checked
 */
export function freshnessFooter(schemes, now = new Date()) {
  if (!schemes?.length) return "";
  const rows = schemes.map((s) => ({ name: s.name, ...freshnessOf(s, now) }));
  const checked = rows.filter((r) => r.lastVerified);
  const unchecked = rows.filter((r) => !r.lastVerified);

  if (unchecked.length === rows.length) {
    return `Note: these scheme details have not yet been checked against the official source, so ${CONFIRM}.`;
  }
  const oldest = checked.map((r) => r.lastVerified).sort()[0];
  if (unchecked.length === 0) return `Scheme details last checked on ${formatCheckDate(oldest)}.`;
  return `Scheme details were last checked on ${formatCheckDate(oldest)}, except ${unchecked.map((r) => r.name).join("; ")}, which have not yet been checked against the official source. Please ${CONFIRM.replace(/^please /, "")}.`;
}
