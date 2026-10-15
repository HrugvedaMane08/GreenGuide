import mongoose from "mongoose";

// Short-term memory so a follow-up ("and the documents?") can be understood. It holds the
// English text of recent messages for one farmer session, and nothing is kept for long:
// the database deletes each message 6 hours after it was written, and only the last few
// messages from the last 30 minutes are ever read (see services/conversationMemory.js).
const conversationMessageSchema = new mongoose.Schema({
  farmerId: { type: String, required: true },
  sessionId: { type: String, required: true, default: "default" },
  role: { type: String, enum: ["user", "assistant"], required: true },
  text: { type: String, required: true },
  intent: { type: String }, // assistant messages: what kind of answer it was
  schemeIds: { type: [String], default: [] }, // assistant messages: the schemes the answer was about
  createdAt: { type: Date, default: Date.now, expires: 6 * 60 * 60 }, // TTL: seconds
});

conversationMessageSchema.index({ farmerId: 1, sessionId: 1, createdAt: -1 });

export default mongoose.model("ConversationMessage", conversationMessageSchema);
