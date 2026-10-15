# GreenGuide

A multilingual advisory web app for Indian farmers. Farmers ask questions by typing
or speaking in English, Hindi or Marathi, and get answers about government schemes,
loans and weather. Answers are grounded in a curated scheme corpus instead of the
model's own knowledge.

> **Important: the scheme data is not verified.** The seven schemes in
> `backend/features/loanAssistant/data/schemes.json` are hand-written summaries of real
> schemes. They have **not** been checked against official sources, and the app says so
> on every scheme card. Do not rely on them for real loan or subsidy decisions.

## Features

| Feature | What it does |
|---|---|
| Ask a Question | Typed or spoken questions (Groq Whisper for speech, browser text-to-speech for answers), answered in the farmer's language |
| Loan Assistant | Register land, apply for a loan, get an eligibility score and matched government schemes |
| "Which schemes can I get?" | Rule-based eligibility check for every scheme from land records and an optional "About you" form, no loan needed |
| Weather | Current weather, forecast and email alerts (OpenWeatherMap) |
| Crop tools | Crop selection and plan with costs in INR, crop calendar with email reminders, crop library |
| Mandi prices | Market prices per land record (Agmarknet via data.gov.in) |
| Irrigation advisory | Guidance from land and weather data |

How the Loan Assistant works:

- **Retrieval:** TF-IDF cosine similarity over the scheme corpus picks the top matches.
- **Eligibility:** deterministic rules in `schemeRules.json` decide eligible / not eligible / needs more info. The language model only writes the explanation.
- **Loan score:** a logistic regression trained on **synthetic data** (`ml_training/train_eligibility_model.py`). It is a demonstration, not a credit model.

Full technical documentation is in [TECH_STACK.md](TECH_STACK.md). Screenshots are in
[docs/UI_SCREENSHOTS.md](docs/UI_SCREENSHOTS.md).

## Tech stack

Node.js 22 (ES modules), Express 5, MongoDB with Mongoose, Groq (LLM and speech-to-text),
OpenWeatherMap, static HTML and vanilla JS frontend served by Express.

## Getting started

### Prerequisites

- Node.js 22 or later
- MongoDB running locally on `127.0.0.1:27017` (or a MongoDB Atlas connection string)
- API keys: Groq, OpenWeatherMap, data.gov.in; a Gmail App Password for email alerts

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env     # then fill in the values
npm run dev              # http://localhost:5000
```

Environment variables (see `backend/.env.example`):

| Variable | Purpose |
|---|---|
| `MONGO_URI` | MongoDB connection string (defaults to the local database) |
| `JWT_SECRET`, `JWT_EXPIRE` | Session token signing |
| `GROQ_API_KEY`, `GROQ_MODEL` | Answer generation, translation, transcription |
| `OPENWEATHER_API_KEY` | Weather and alerts |
| `DATA_GOV_API_KEY` | Mandi prices |
| `GMAIL_USER`, `GMAIL_PASS` | Notification emails (use a Google App Password) |
| `ADMIN_API_KEY` | Admin-only endpoints; if unset they stay disabled |
| `USD_TO_INR` | Exchange rate for crop-plan costs |

### 2. Frontend

```bash
cd frontend
npm install
node server.js           # http://localhost:3000
```

Open `http://localhost:3000/signup` to create an account.

### 3. Tests

```bash
cd backend
npm test
```

The tests do not need a database or network access.

## Project layout

```
backend/
  server.js                  accounts, crop calendar, crop plan, weather proxy, scheduled jobs
  features/loanAssistant/    land, loans, schemes, Q&A, eligibility
    data/                    schemes.json, schemeRules.json, stateSchemes.json, model weights
    services/                retrieval, eligibility rules, Groq calls, translation
    ml_training/             script that produces the eligibility model weights
  middleware/ shared/ test/
frontend/
  public/                    the pages (login, dashboard, loan assistant, ask a question, ...)
  server.js                  static file server
docs/                        screenshots and walkthrough
```

## Known limitations

- Scheme details are unverified (see above). Official source links and check dates are empty until someone verifies each scheme.
- The loan eligibility model is trained on synthetic data.
- The Groq free tier is rate limited. When a call fails, the app silently falls back to plain scheme descriptions.
- Voice answers use the browser's built-in voices, which differ by device. Hindi numbers are converted to words before speaking; other languages are not yet.

## License

[MIT](LICENSE)
