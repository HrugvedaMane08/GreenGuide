import express from "express";
import { getSchemeEligibility } from "../controllers/schemeEligibilityController.js";
import { validateEligibilityQuery } from "../middleware/validators.js";
import { farmerInParams, farmerInBody, farmerInQuery } from "../../../middleware/farmerIdentity.js";

const router = express.Router();

// GET /api/schemes/eligibility?farmerId=...  -> eligibility for every scheme, no loan needed
router.get("/eligibility", farmerInQuery(), validateEligibilityQuery, getSchemeEligibility);

export default router;
