import express from "express";
import { getMandiPriceForLand } from "../controllers/mandiController.js";
import { validateLandIdForMandi } from "../middleware/validators.js";
import { farmerInParams, farmerInBody, farmerInQuery } from "../../../middleware/farmerIdentity.js";

const router = express.Router();

// GET /api/lands/:landId/mandi-price -> current market prices for that land's primary crop
router.get("/:landId/mandi-price", farmerInQuery(), validateLandIdForMandi, getMandiPriceForLand);

export default router;