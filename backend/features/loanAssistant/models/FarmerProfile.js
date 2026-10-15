import mongoose from "mongoose";

// Facts about the farmer that scheme eligibility rules need but no other record
// holds (see data/schemeRules.json). Every field is optional: a missing field
// makes a rule report "needs more info" instead of guessing.
const farmerProfileSchema = new mongoose.Schema(
  {
    farmerId: { type: String, required: true, unique: true }, // same id the land and loan records use
    age: { type: Number },
    landTenure: { type: String, enum: ["owner", "tenant", "sharecropper", "none"] },
    incomeTaxPayer: { type: Boolean },
    governmentEmployee: { type: Boolean },
    institutionalLandholder: { type: Boolean },
    registeredProfessional: { type: Boolean },
    coveredBySocialSecurity: { type: Boolean },

    // The facts above are what the farmer SAID. An admin marks a fact verified after
    // checking documents; changing a fact drops its verification. See the admin routes.
    verifiedFields: { type: [String], default: [] },
    verifiedAt: { type: Date },
    verificationNote: { type: String }
  },
  { timestamps: true }
);

export default mongoose.model("FarmerProfile", farmerProfileSchema);
