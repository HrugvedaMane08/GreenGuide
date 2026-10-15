import mongoose from "mongoose";
import Land from "../models/Land.js";
import { buildIrrigationAdvisory } from "../services/irrigationService.js";

export async function getIrrigationAdvisory(req, res) {
  try {
    const { landId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(landId)) {
      return res.status(400).json({ error: "Invalid land ID format." });
    }

    // owner only
    const land = await Land.findOne({ _id: landId, farmerId: req.query.farmerId, archivedAt: null });
    if (!land) {
      return res.status(404).json({ error: "Land record not found." });
    }
    if (!land.district || !land.state) {
      return res.status(400).json({ error: "This land record is missing district/state, needed to fetch a weather forecast." });
    }

    // Try to find a matching Crop Calendar entry (UserCrop, registered in server.js)
    // to pin down the growth stage from an actual plant date, if one exists.
    let plantDate = null;
    try {
      const UserCrop = mongoose.model("UserCrop");
      if (land.primaryCrop) {
        const match = await UserCrop.findOne({
          userId: land.farmerId,
          name: new RegExp(`^${land.primaryCrop.trim()}$`, "i"),
        }).sort({ createdAt: -1 });
        if (match) plantDate = match.plantDate;
      }
    } catch (e) {
      // UserCrop model not registered yet, or no match — fall back to mid-season Kc.
    }

    const advisory = await buildIrrigationAdvisory(land, plantDate);
    res.json(advisory);
  } catch (err) {
    console.error("🔥 Error building irrigation advisory:", err.message);
    if (err.response && err.response.status === 404) {
      return res.status(404).json({ error: "Could not find weather data for this location. Check the district/state spelling on the land record." });
    }
    res.status(500).json({ error: "Failed to generate irrigation advisory due to a server error." });
  }
}