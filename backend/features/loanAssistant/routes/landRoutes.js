import express from "express";
import { createLand, updateLand, deleteLand, listLandsForFarmer, getLand } from "../controllers/landController.js";
import { validateLand, validateLandUpdate, validateLandDelete, validateLandIdParam } from "../middleware/validators.js";
import { farmerInParams, farmerInBody, farmerInQuery } from "../../../middleware/farmerIdentity.js";

const router = express.Router();

router.post("/", farmerInBody(), validateLand, createLand);
router.get("/farmer/:farmerId", farmerInParams(), listLandsForFarmer);
router.get("/:id", farmerInQuery(), validateLandIdParam, getLand);
router.patch("/:id", farmerInBody(), validateLandUpdate, updateLand);
router.delete("/:id", farmerInQuery(), validateLandDelete, deleteLand);

export default router;
