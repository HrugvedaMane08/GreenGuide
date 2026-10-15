import { questionStats } from "../services/questionLog.js";

/**
 * GET /api/admin/question-stats?days=30&limit=20   (x-admin-key)
 *
 * What farmers are asking and where the app falls short: volumes by kind, language and outcome;
 * the most common questions; the questions that failed (no matching scheme, translation or
 * generation failures, errors) with how near the best match came; and what is being declined.
 * Questions are shown as scrubbed English: see services/questionLog.js for what is and is not kept.
 */
export async function getQuestionStats(req, res) {
  try {
    // req.query is read-only in Express 5, so the validator checks these but cannot convert them.
    const days = Number.parseInt(req.query.days, 10) || 30;
    const limit = Number.parseInt(req.query.limit, 10) || 20;
    res.json(await questionStats({ days, limit }));
  } catch (err) {
    console.error("Error building question stats:", err.message);
    res.status(500).json({ error: "Failed to build question statistics" });
  }
}
