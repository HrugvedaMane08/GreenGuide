import mongoose from "mongoose";

// One row per question: enough to learn what farmers ask and where the app fails, with no way to
// tell who asked. Deliberately NOT stored: the farmer's id, the session, the original wording,
// and the answer text (answers quote the farmer's own land and details). The question is kept
// only as scrubbed English (see services/questionLog.js). Rows delete themselves after 90 days.
const questionLogSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now, expires: 90 * 24 * 60 * 60 },
  channel: { type: String, enum: ["typed", "voice"] },
  language: { type: String }, // detected: en | hi | mr | ...
  intent: { type: String }, // scheme | weather | mandi | agronomy | out | unknown
  followUp: { type: Boolean, default: false },
  // answered | declined | no_match | needs_district | translation_failed | generation_failed | weather_failed | error
  outcome: { type: String },
  failureReason: { type: String },
  question: { type: String }, // scrubbed, lower-cased English translation
  retrieval: { type: [{ _id: false, id: String, score: Number }], default: [] }, // the schemes retrieved and how well they matched
  topScore: { type: Number }, // best match score, also recorded when nothing was good enough
  sources: { type: [String], default: [] },
  modelCalls: { total: Number, byPurpose: { type: Map, of: Number }, attempts: Number },
  ms: { type: Number },
  answerChars: { type: Number },
});

questionLogSchema.index({ at: -1 });
questionLogSchema.index({ outcome: 1, at: -1 });

export default mongoose.model("QuestionLog", questionLogSchema);
