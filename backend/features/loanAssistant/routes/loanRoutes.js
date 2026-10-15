import express from "express";
import {
  createLoanApplication,
  updateLoanApplication,
  listLoanApplicationsForFarmer
} from "../controllers/loanController.js";
import { farmerInParams, farmerInBody } from "../../../middleware/farmerIdentity.js";
import { validateLoan, validateLoanUpdate } from "../middleware/validators.js";

const router = express.Router();

router.post("/", farmerInBody(), validateLoan, createLoanApplication);
router.patch("/:loanId", farmerInBody(), validateLoanUpdate, updateLoanApplication);
router.get("/farmer/:farmerId", farmerInParams(), listLoanApplicationsForFarmer);

export default router;
