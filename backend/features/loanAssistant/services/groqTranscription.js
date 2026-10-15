const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

// whisper-large-v3 handles Indian languages noticeably better than the turbo
// variant, which is tuned for speed and degrades on code-mixed Marathi/Hindi.
const TRANSCRIPTION_MODEL = process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3";

// Groq caps uploads at 25MB on the free tier. Farmer questions are seconds long,
// so anything approaching this is a misuse and worth rejecting before upload.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Formats Groq accepts, mapped to the extension we send in the multipart part.
// Browsers record webm (Chrome/Firefox) or mp4/m4a (Safari).
const MIME_EXTENSIONS = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac"
};

export function isSupportedAudioType(mimeType) {
  return Boolean(extensionFor(mimeType));
}

function extensionFor(mimeType) {
  if (!mimeType) return null;
  // Strip codec parameters: "audio/webm;codecs=opus" -> "audio/webm"
  const base = String(mimeType).split(";")[0].trim().toLowerCase();
  return MIME_EXTENSIONS[base] || null;
}

/**
 * Transcribes a farmer's spoken question using Groq's Whisper endpoint.
 *
 * `languageHint` is an ISO 639-1 code ("mr", "hi", ...) or "auto". Passing a
 * hint measurably improves accuracy for Indian languages, so the frontend
 * should send the farmer's selected language when they've chosen one.
 *
 * Returns { text, language }. Throws on failure — unlike scheme generation
 * there is no meaningful fallback for "we couldn't hear you", and silently
 * returning empty text would send a blank question into the answer pipeline.
 */
export async function transcribeAudio(audioBuffer, mimeType, languageHint = "auto") {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set — voice input is unavailable");
  }

  if (!audioBuffer?.length) {
    throw new Error("No audio data received");
  }

  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new Error(`Audio is too large (${Math.round(audioBuffer.length / 1024 / 1024)}MB); limit is 25MB`);
  }

  const extension = extensionFor(mimeType);
  if (!extension) {
    throw new Error(`Unsupported audio format "${mimeType}"`);
  }

  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), `question.${extension}`);
  form.append("model", TRANSCRIPTION_MODEL);
  form.append("response_format", "verbose_json"); // gives us the detected language back
  if (languageHint && languageHint !== "auto") {
    form.append("language", languageHint);
  }

  const response = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` }, // no Content-Type: fetch sets the multipart boundary
    body: form
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Groq transcription error:", response.status, errText);
    throw new Error(
      response.status === 429
        ? "Voice service is busy right now. Please try again in a moment."
        : "Could not transcribe the audio."
    );
  }

  const data = await response.json();
  const text = (data?.text || "").trim();

  if (!text) {
    throw new Error("No speech was detected in the recording.");
  }

  return { text, language: data?.language || null };
}
