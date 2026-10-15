import express from "express";
import {
  getLanguages,
  postFarmerQuery,
  postFarmerVoiceQuery,
  clearConversation,
  MAX_AUDIO_BYTES
} from "../controllers/farmerQueryController.js";
import { validateFarmerQuery, validateConversationClear } from "../middleware/validators.js";
import { farmerInParams, farmerInBody, farmerInQuery } from "../../../middleware/farmerIdentity.js";

const router = express.Router();

// Accept a recorded blob as a raw body. express.json() is already mounted
// globally in server.js and would otherwise reject these as malformed JSON.
const audioBody = express.raw({ type: "audio/*", limit: MAX_AUDIO_BYTES });

router.get("/languages", getLanguages);
// The Q&A routes still answer general scheme questions when the database is down, so they let
// the request through in that one case (they read no farmer data then).
router.post("/:farmerId/query", farmerInParams({ failOpenWhenDbDown: true }), validateFarmerQuery, postFarmerQuery);
router.delete("/:farmerId/conversation", farmerInParams({ failOpenWhenDbDown: true }), validateConversationClear, clearConversation);
router.post("/:farmerId/query/voice", farmerInParams({ failOpenWhenDbDown: true }), audioBody, postFarmerVoiceQuery);

export default router;
