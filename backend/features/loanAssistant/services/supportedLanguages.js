// Languages offered in the "Ask a Question" dropdown.
// Keys are ISO 639-1 codes; values are the display names shown to farmers.
//
// Scoped to English, Hindi and Marathi. The pipeline is language-agnostic —
// adding a language back is just another entry here, since the dropdown, the
// request validation and the Whisper language hint all read from this object.
export const SUPPORTED_LANGUAGES = {
  en: "English",
  hi: "Hindi",
  mr: "Marathi",
};
