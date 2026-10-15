import Land from "../models/Land.js";
import { fetchMandiPrices, summarizeMandiRecords } from "../services/mandiPriceService.js";
import { commodityCandidates } from "../services/mandiCommodity.js";

// Each extra attempt is a network call with a 10s timeout, so cap how many we make.
const MAX_NAMES = 4;
const TIME_BUDGET_MS = 25000;

/**
 * GET /api/lands/:landId/mandi-price
 * Looks up the land's primary crop and returns current mandi prices for it.
 *
 * The crop name is normalised first (trim, case, brackets, synonyms such as
 * eggplant/brinjal/baingan) and turned into the commodity names the feed may know it by.
 * If nothing is found, BOTH the location and the name are widened: for each candidate
 * name, district -> state -> all-India, then the next name. The first hit wins.
 */
export async function getMandiPriceForLand(req, res) {
  try {
    const { landId } = req.params;

    // owner only
    const land = await Land.findOne({ _id: landId, farmerId: req.query.farmerId, archivedAt: null });
    if (!land) {
      return res.status(404).json({ error: "Land record not found" });
    }
    const names = commodityCandidates(land.primaryCrop).slice(0, MAX_NAMES);
    if (names.length === 0) {
      return res.status(400).json({ error: "This land record has no primary crop set" });
    }

    const scopes = [
      land.district && land.state && { level: "district", state: land.state, district: land.district },
      land.state && { level: "state", state: land.state },
      { level: "all-india" },
    ].filter(Boolean);

    const started = Date.now();
    const tried = [];
    let records = [];
    let matchedCommodity = null;
    let matchedScope = null;

    search: for (const commodity of names) {
      for (const scope of scopes) {
        if (Date.now() - started > TIME_BUDGET_MS) break search;
        const { level, ...location } = scope;
        tried.push(`${commodity} / ${level}`);
        records = await fetchMandiPrices({ commodity, ...location, limit: 10 });
        if (records.length > 0) {
          matchedCommodity = commodity;
          matchedScope = level;
          break search;
        }
      }
    }

    res.json({
      crop: land.primaryCrop,
      queriedState: land.state,
      queriedDistrict: land.district,
      // What actually matched, so the screen can say "prices for Brinjal, across Maharashtra".
      matchedCommodity,
      matchedScope,
      // Everything attempted, so an empty result is explainable rather than silent.
      tried,
      summary: summarizeMandiRecords(records),
      records
    });
  } catch (err) {
    console.error("Error fetching mandi price:", err.message);
    res.status(502).json({ error: "Failed to fetch mandi prices from the market data source" });
  }
}
