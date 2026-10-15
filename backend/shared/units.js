// Land area is held in ACRES everywhere (land records, the crop plan, the loan form).
// Hectares appear only at the edges where a rule or a data table is written in them:
// scheme limits ("2 hectares") and the per-hectare input rates in the crop-plan data.
// Convert with these, never with a literal.

export const ACRES_PER_HECTARE = 2.47105;
export const SQUARE_METRES_PER_ACRE = 4046.86;

export const acresToHectares = (acres) => acres / ACRES_PER_HECTARE;
export const hectaresToAcres = (hectares) => hectares * ACRES_PER_HECTARE;

/** Land area in acres from a value in the given unit ("acres" | "hectares"). */
export function toAcres(value, unit = "acres") {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return unit === "hectares" || unit === "hectare" || unit === "ha" ? hectaresToAcres(n) : n;
}
