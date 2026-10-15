import express from "express";
import { getIrrigationAdvisory } from "../controllers/irrigationController.js";
import { farmerInParams, farmerInBody, farmerInQuery } from "../../../middleware/farmerIdentity.js";

const router = express.Router();

router.get("/:landId/irrigation-advisory", farmerInQuery(), getIrrigationAdvisory);

export default router;