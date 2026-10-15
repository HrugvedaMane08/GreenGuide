import express from "express";
import {
  getFarmerProfile,
  saveFarmerProfile,
  adminGetFarmerProfile,
  adminVerifyFields,
  adminUnverifyFields
} from "../controllers/farmerProfileController.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { validateVerification } from "../middleware/validators.js";
import { farmerInParams, farmerInBody, farmerInQuery } from "../../../middleware/farmerIdentity.js";

const router = express.Router();

// Admin: see what a farmer declared and mark facts verified after checking documents.
// requireAdmin runs first so an unauthenticated caller learns nothing.
router.get("/admin/:farmerId", requireAdmin, adminGetFarmerProfile);
router.post("/admin/:farmerId/verify", requireAdmin, validateVerification, adminVerifyFields);
router.post("/admin/:farmerId/unverify", requireAdmin, validateVerification, adminUnverifyFields);

router.get("/:farmerId", farmerInParams(), getFarmerProfile);
router.put("/:farmerId", farmerInParams(), saveFarmerProfile);

export default router;
