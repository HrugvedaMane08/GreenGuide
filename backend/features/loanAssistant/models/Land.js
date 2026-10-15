import mongoose from "mongoose";

const landSchema = new mongoose.Schema(
  {
    farmerId: { type: String, required: true }, // TODO: switch to ObjectId ref once auth is fixed
    state: { type: String, required: true },
    district: { type: String, required: true },
    village: { type: String },
    areaAcres: { type: Number, required: true },
    soilType: { type: String },
    irrigationType: { type: String },
    primaryCrop: { type: String },
    // Set instead of deleting when loan applications still refer to this land: it
    // disappears from the farmer's holding, eligibility and Q&A, but the loan history
    // keeps pointing at a real record.
    archivedAt: { type: Date }
  },
  { timestamps: true }
);

export default mongoose.model("Land", landSchema);
