import Land from "../models/Land.js";
import LoanApplication from "../models/LoanApplication.js";
import { rescoreLoansForLand, scheduleSchemeRefresh } from "../services/loanRefresh.js";

export async function createLand(req, res) {
  try {
    const { farmerId, state, district, village, areaAcres, soilType, irrigationType, primaryCrop } = req.body;

    if (!farmerId || !state || !district || !areaAcres) {
      return res.status(400).json({ error: "farmerId, state, district, and areaAcres are required" });
    }

    const land = await Land.create({
      farmerId, state, district, village, areaAcres, soilType, irrigationType, primaryCrop
    });

    // A new plot changes the farmer's total holding, so schemes already matched for their
    // applications may now be wrong. Refreshed in the background; never fails the create.
    try {
      await scheduleSchemeRefresh(farmerId);
    } catch (e) {
      console.error("Could not schedule scheme refresh after new land:", e.message);
    }

    res.status(201).json(land);
  } catch (err) {
    console.error("Error creating land record:", err.message);
    res.status(500).json({ error: "Failed to create land record" });
  }
}

// Changing these can change a loan's score or the schemes a farmer qualifies for.
// (District only affects weather and irrigation, so it does not trigger a refresh.)
const AFFECTS_ELIGIBILITY = ["areaAcres", "state", "primaryCrop", "soilType", "irrigationType"];

/**
 * PATCH /api/lands/:id
 * Body: farmerId (must own the record) plus any of state, district, village,
 * areaAcres, soilType, irrigationType, primaryCrop. A field left out is unchanged;
 * the optional ones can be cleared with null.
 *
 * When something that matters changes, the farmer's loan applications are
 * brought up to date: scores are recomputed now, matched schemes in the background
 * (see services/loanRefresh.js).
 */
export async function updateLand(req, res) {
  try {
    const { id } = req.params;
    const { farmerId } = req.body;

    const land = await Land.findOne({ _id: id, farmerId, archivedAt: null });
    if (!land) {
      return res.status(404).json({ error: "Land record not found for this farmer" });
    }

    for (const field of ["state", "district", "village", "areaAcres", "soilType", "irrigationType", "primaryCrop"]) {
      const value = req.body[field];
      if (value === undefined) continue; // left out: unchanged
      land.set(field, value === null ? undefined : value);
    }

    const relevant = land.modifiedPaths().some((p) => AFFECTS_ELIGIBILITY.includes(p));
    await land.save();

    let loansRescored = 0;
    let schemesRefreshing = 0;
    if (relevant) {
      loansRescored = await rescoreLoansForLand(land);
      schemesRefreshing = await scheduleSchemeRefresh(farmerId);
    }

    res.json({ ...land.toObject(), refreshed: { loansRescored, schemesRefreshing } });
  } catch (err) {
    console.error("Error updating land record:", err.message);
    res.status(500).json({ error: "Failed to update land record" });
  }
}

/**
 * DELETE /api/lands/:id?farmerId=...
 *
 * A loan application needs its land, so what "delete" means depends on the history:
 *   - an application refers to it -> archived: gone from the farmer's holding,
 *     eligibility and Q&A, but kept so the application keeps its land;
 *   - nothing refers to it        -> really deleted.
 * Either way the farmer's total holding shrinks, so their applications' matched
 * schemes are refreshed.
 */
export async function deleteLand(req, res) {
  try {
    const { id } = req.params;
    const { farmerId } = req.query;

    const land = await Land.findOne({ _id: id, farmerId, archivedAt: null });
    if (!land) {
      return res.status(404).json({ error: "Land record not found for this farmer" });
    }

    const referenced = await LoanApplication.countDocuments({ landId: land._id });
    let mode;
    if (referenced === 0) {
      await land.deleteOne();
      mode = "deleted";
    } else {
      land.archivedAt = new Date();
      await land.save();
      mode = "archived";
    }

    try {
      await scheduleSchemeRefresh(farmerId);
    } catch (e) {
      console.error("Could not schedule scheme refresh after removing land:", e.message);
    }

    res.json({
      mode,
      message: mode === "deleted"
        ? "Land record deleted."
        : "Land record removed. It is kept in the background because loan applications refer to it."
    });
  } catch (err) {
    console.error("Error deleting land record:", err.message);
    res.status(500).json({ error: "Failed to delete land record" });
  }
}

export async function listLandsForFarmer(req, res) {
  try {
    const { farmerId } = req.params;
    const lands = await Land.find({ farmerId, archivedAt: null }).sort({ createdAt: -1 });
    res.json(lands);
  } catch (err) {
    console.error("Error fetching land records:", err.message);
    res.status(500).json({ error: "Failed to fetch land records" });
  }
}

export async function getLand(req, res) {
  try {
    // owner only: "not found" for anyone else, so an id reveals nothing
    const land = await Land.findOne({ _id: req.params.id, farmerId: req.query.farmerId, archivedAt: null });
    if (!land) return res.status(404).json({ error: "Land record not found" });
    res.json(land);
  } catch (err) {
    console.error("Error fetching land record:", err.message);
    res.status(500).json({ error: "Failed to fetch land record" });
  }
}
