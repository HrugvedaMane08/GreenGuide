import express from "express";
import { matchSchemesForLoan } from "../controllers/schemeController.js";
import { validateSchemeMatch } from "../middleware/validators.js";
import { farmerInParams, farmerInBody, farmerInQuery } from "../../../middleware/farmerIdentity.js";

const router = express.Router();

// POST /api/loans/:loanId/schemes  -> retrieve + generate matched schemes for this loan
router.post("/:loanId/schemes", farmerInBody(), validateSchemeMatch, matchSchemesForLoan);

export default router;