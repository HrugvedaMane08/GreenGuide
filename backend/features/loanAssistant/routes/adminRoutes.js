import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { validateQuestionStats } from "../middleware/validators.js";
import { getQuestionStats } from "../controllers/questionStatsController.js";

const router = express.Router();

// requireAdmin runs first so an unauthenticated caller learns nothing.
router.get("/question-stats", requireAdmin, validateQuestionStats, getQuestionStats);

export default router;
