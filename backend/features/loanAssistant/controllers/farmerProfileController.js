import FarmerProfile from "../models/FarmerProfile.js";
import { sanitizeFarmerFacts, FARMER_FACT_FIELDS } from "../services/schemeEligibilityChecks.js";

const pick = (doc) => Object.fromEntries(FARMER_FACT_FIELDS.filter((f) => doc?.[f] !== undefined && doc?.[f] !== null).map((f) => [f, doc[f]]));

// What a farmer sees: the facts they gave, and which of them the lender has verified.
const farmerView = (doc) => ({ ...pick(doc), verifiedFields: (doc?.verifiedFields || []).filter((f) => doc?.[f] !== undefined && doc?.[f] !== null) });

/**
 * The farmer's saved facts and which are verified. Best-effort on purpose: scheme
 * matching and Q&A work without them (the rules then report "needs more info"), so a
 * lookup problem must never fail those requests.
 * Returns { facts, verifiedFields }.
 */
export async function findFarmerFactsDetailed(farmerId) {
  if (!farmerId || FarmerProfile.db.readyState !== 1) return { facts: {}, verifiedFields: [] };
  try {
    const doc = await FarmerProfile.findOne({ farmerId }).lean();
    const view = farmerView(doc);
    return { facts: pick(doc), verifiedFields: view.verifiedFields };
  } catch (err) {
    console.warn(`Could not load farmer profile for ${farmerId}: ${err.message}`);
    return { facts: {}, verifiedFields: [] };
  }
}

/** Just the facts (see findFarmerFactsDetailed for verification). {} if none or unavailable. */
export async function findFarmerFacts(farmerId) {
  return (await findFarmerFactsDetailed(farmerId)).facts;
}

/** GET /api/farmer-profiles/:farmerId */
export async function getFarmerProfile(req, res) {
  try {
    const doc = await FarmerProfile.findOne({ farmerId: req.params.farmerId }).lean();
    res.json(farmerView(doc));
  } catch (err) {
    console.error("Error fetching farmer profile:", err.message);
    res.status(500).json({ error: "Failed to fetch your details" });
  }
}

/**
 * PUT /api/farmer-profiles/:farmerId
 * Body: any of age, landTenure, incomeTaxPayer, governmentEmployee,
 * institutionalLandholder, registeredProfessional, coveredBySocialSecurity.
 * A field sent as null or "" is cleared; a field left out is unchanged.
 * Changing or clearing a field removes its verification: what was checked is no longer
 * what is on file.
 */
export async function saveFarmerProfile(req, res) {
  try {
    const { farmerId } = req.params;
    const body = req.body || {};
    const { facts, rejected } = sanitizeFarmerFacts(body);

    if (rejected.length > 0) {
      return res.status(400).json({ error: `Invalid value for: ${rejected.join(", ")}` });
    }

    const clear = FARMER_FACT_FIELDS.filter((f) => f in body && (body[f] === null || body[f] === ""));

    const existing = await FarmerProfile.findOne({ farmerId }).lean();
    const changed = [...Object.keys(facts), ...clear].filter((f) => existing?.[f] !== facts[f]);
    const stillVerified = (existing?.verifiedFields || []).filter((f) => !changed.includes(f));

    const update = { $set: { ...facts, verifiedFields: stillVerified }, $setOnInsert: { farmerId } };
    if (clear.length > 0) update.$unset = Object.fromEntries(clear.map((f) => [f, ""]));

    const doc = await FarmerProfile.findOneAndUpdate({ farmerId }, update, { upsert: true, new: true, runValidators: true }).lean();
    res.json(farmerView(doc));
  } catch (err) {
    console.error("Error saving farmer profile:", err.message);
    res.status(500).json({ error: "Failed to save your details" });
  }
}

// ---------------------------------------------------------------- admin: verification
// A fact is "verified" once an admin has checked it against documents (tax return,
// service record, ...). Nothing here checks anything by itself: no public system lets
// us confirm a person's tax status or employment, so the check is a human one, and
// this records that it happened.

const adminView = (doc) => ({
  farmerId: doc?.farmerId,
  facts: pick(doc),
  verifiedFields: farmerView(doc).verifiedFields,
  unverifiedFields: FARMER_FACT_FIELDS.filter((f) => doc?.[f] !== undefined && doc?.[f] !== null && !(doc.verifiedFields || []).includes(f)),
  verifiedAt: doc?.verifiedAt,
  verificationNote: doc?.verificationNote,
  updatedAt: doc?.updatedAt,
});

/** GET /api/farmer-profiles/admin/:farmerId */
export async function adminGetFarmerProfile(req, res) {
  try {
    const doc = await FarmerProfile.findOne({ farmerId: req.params.farmerId }).lean();
    if (!doc) return res.status(404).json({ error: "This farmer has not saved any details" });
    res.json(adminView(doc));
  } catch (err) {
    console.error("Error fetching farmer profile (admin):", err.message);
    res.status(500).json({ error: "Failed to fetch the farmer's details" });
  }
}

/** POST /api/farmer-profiles/admin/:farmerId/verify   Body: { fields: [...], note? } */
export async function adminVerifyFields(req, res) {
  try {
    const { farmerId } = req.params;
    const { fields, note } = req.body;

    const doc = await FarmerProfile.findOne({ farmerId }).lean();
    if (!doc) return res.status(404).json({ error: "This farmer has not saved any details" });

    const empty = fields.filter((f) => doc[f] === undefined || doc[f] === null);
    if (empty.length > 0) {
      return res.status(409).json({ error: `Nothing to verify yet for: ${empty.join(", ")}. The farmer has not given a value.` });
    }

    const updated = await FarmerProfile.findOneAndUpdate(
      { farmerId },
      { $addToSet: { verifiedFields: { $each: fields } }, $set: { verifiedAt: new Date(), ...(note ? { verificationNote: note } : {}) } },
      { new: true }
    ).lean();
    res.json(adminView(updated));
  } catch (err) {
    console.error("Error verifying farmer details:", err.message);
    res.status(500).json({ error: "Failed to record the verification" });
  }
}

/** POST /api/farmer-profiles/admin/:farmerId/unverify   Body: { fields: [...] } */
export async function adminUnverifyFields(req, res) {
  try {
    const { farmerId } = req.params;
    const updated = await FarmerProfile.findOneAndUpdate({ farmerId }, { $pullAll: { verifiedFields: req.body.fields } }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: "This farmer has not saved any details" });
    res.json(adminView(updated));
  } catch (err) {
    console.error("Error removing verification:", err.message);
    res.status(500).json({ error: "Failed to remove the verification" });
  }
}
