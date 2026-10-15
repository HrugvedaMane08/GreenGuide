# GreenGuide — Technical Documentation

A multilingual advisory web application for Indian farmers. Farmers ask questions
by typing or speaking, in English, Hindi or Marathi, and receive answers about
government schemes and weather that are grounded in a curated scheme corpus
rather than generated from the model's own knowledge.

Repository: https://github.com/RiyaMhatre12/GreenGuide

---

## 1. What the application does

| Capability | Description |
|---|---|
| Ask a Question | Typed or spoken questions in English/Hindi/Marathi, answered in the same language |
| Loan Assistant | Loan applications scored for eligibility, matched to government schemes |
| Land records | Farmers register plots: location, area, soil, irrigation, primary crop |
| Weather | Current conditions, forecasts, and automated alerts by email |
| Crop planning | Crop selection, a crop calendar, and a reference library |
| Mandi prices | Market price lookup per land record |
| Irrigation advisory | Irrigation guidance derived from land and weather data |

Scope is deliberately narrow: the assistant answers questions about **schemes,
loans and subsidies, or weather**, and declines anything else. That boundary is
enforced in code, not by prompt instruction alone (see §6.3).

---

## 2. Technology stack

### Backend

| Technology | Version | Role |
|---|---|---|
| Node.js | 22.x | Runtime (ES modules — `"type": "module"`) |
| Express | 5.1 | HTTP server and routing |
| MongoDB | 8.0 | Database, running locally |
| Mongoose | 8.24 | ODM: schemas, validation, queries |
| bcryptjs | 3.0 | Password hashing (salt rounds: 10) |
| jsonwebtoken | 9.0 | JWT session tokens |
| node-cron | 4.2 | Scheduled weather alerts and deadline checks |
| Nodemailer | 7.0 | Email notifications via Gmail SMTP |
| express-validator | 7.3 | Request validation |
| axios / node-fetch | 1.12 / 3.3 | Outbound HTTP to third-party APIs |
| dotenv | 17.4 | Environment configuration |
| date-fns | 4.1 | Date arithmetic |

### Frontend

| Technology | Version | Role |
|---|---|---|
| Static HTML + vanilla JS | — | 13 pages served from `frontend/public/` |
| Express | 5.1 | Static file server on port 3000 |
| Tailwind CSS | 3.4 | Utility CSS (with PostCSS, Autoprefixer) |
| React | — | Partial: `Login.js`, `Landform.js` in `frontend/src/` |
| react-router-dom | 7.18 | Routing in the React portion |
| framer-motion | 13.0 | Animation |
| lucide-react | 1.29 | Icons |

> **Note on the frontend:** the project is mid-migration. The pages farmers
> actually use — including Ask a Question — are static HTML with vanilla JS.
> The React code under `src/` is partial and not the primary interface.

### Machine learning

| Technology | Role |
|---|---|
| Python + scikit-learn | Trains the loan-eligibility model offline |
| Logistic regression | Eligibility scoring |
| NumPy | Numerical work during training |

Training is offline only. The learned weights are exported to
`eligibility_weights.json` with the `StandardScaler` folded in, so the Node
runtime performs a single dot product plus a sigmoid — no Python at runtime.

### AI and external services

| Service | Model / endpoint | Purpose |
|---|---|---|
| Groq | `openai/gpt-oss-20b` | Answer generation |
| Groq | `qwen/qwen3.8-27b` | Language detection and translation |
| Groq | `whisper-large-v3` | Speech-to-text |
| Browser Web Speech API | `speechSynthesis` | Text-to-speech (client-side, free) |
| OpenWeatherMap | `/data/2.5/weather`, `/forecast` | Weather and forecasts |
| data.gov.in | Mandi price resource | Market prices |
| Gmail SMTP | — | Email notifications |

Model choices are measured, not assumed. `qwen3.8-27b` was selected for
translation after benchmarking: 3/3 correct at **38 completion tokens**, versus
130 for `gpt-oss-20b`, which matters against the free tier's 8000 tokens-per-minute
cap. `whisper-large-v3` is used over `turbo` because it handles Indian languages
noticeably better.

---

## 3. Architecture

```
Browser (HTML + vanilla JS, port 3000)
   |
   |  fetch() JSON  /  raw audio body
   v
Express API (port 5000)
   |
   +-- Auth, users, crops, weather ....... server.js
   |
   +-- features/loanAssistant/
   |      routes/       HTTP surface
   |      controllers/  orchestration
   |      services/     business logic, AI calls
   |      models/       Mongoose schemas
   |      data/         scheme corpus, model weights
   |
   +-- MongoDB (localhost:27017/mydb)
   |
   +-- Groq API  |  OpenWeatherMap  |  data.gov.in  |  Gmail SMTP
```

The loan assistant is organised as a self-contained feature module. Core app
concerns (auth, users, crops, weather) live in `server.js`.

### Directory layout

```
GreenGuide/
├── backend/
│   ├── server.js                    Core API, auth, weather, cron jobs
│   ├── model/User.js
│   ├── config/  utils/
│   └── features/loanAssistant/
│       ├── controllers/             6 controllers
│       ├── routes/                  6 route modules
│       ├── services/                12 services
│       ├── models/                  Land.js, LoanApplication.js
│       ├── data/                    schemes.json, eligibility_weights.json
│       ├── middleware/requireAdmin.js
│       └── ml_training/             train_eligibility_model.py
├── frontend/
│   ├── server.js                    Static server, port 3000
│   ├── public/                      13 HTML pages
│   └── src/                         Partial React
└── scripts/install-voices.ps1       Windows TTS voice installer
```

---

## 4. Data models

**User** (`backend/model/User.js`) — name, email, password (bcrypt-hashed),
location, notification preferences.

**Land** (`features/loanAssistant/models/Land.js`) — `farmerId`, state, district,
village, `areaAcres`, `soilType`, `irrigationType`, `primaryCrop`.

**LoanApplication** — `landId`, purpose, `requestedAmount`, `annualIncome`,
`existingLoans`, credit history, `eligibilityStatus`, `matchedSchemes`.

**Scheme corpus** (`data/schemes.json`) — 7 government schemes, each with a
description, eligibility criteria, required documents, tags, and an
`applicability` field used only for retrieval (see §6.1).

---

## 5. API surface

### Farmer Q&A
```
GET  /api/farmers/languages              Supported languages
POST /api/farmers/:farmerId/query        Typed question  (JSON)
POST /api/farmers/:farmerId/query/voice  Spoken question (raw audio body)
```

### Loans, schemes, land
```
POST /api/lands                          Create land record
GET  /api/lands/farmer/:farmerId
GET  /api/lands/:landId/mandi-price
GET  /api/lands/:landId/irrigation-advisory
POST /api/loans                          Submit application (scored on submit)
PATCH /api/loans/:loanId                 Add / change / clear answers and re-score (owner's farmerId required)
GET  /api/loans/farmer/:farmerId
POST /api/loans/:loanId/schemes          Match schemes to an application
GET  /api/schemes/eligibility           Eligibility for all 7 schemes from land alone (?farmerId=, optional &purpose=)
PATCH /api/lands/:id                     Edit a land record (recomputes loans; see 6.4)
DELETE /api/lands/:id?farmerId=          Remove land: archived or deleted depending on loan history (see 6.4)
GET  /api/farmer-profiles/admin/:farmerId             Admin: what a farmer declared and what is verified
POST /api/farmer-profiles/admin/:farmerId/verify      Admin: mark declared facts verified ({fields, note?})
POST /api/farmer-profiles/admin/:farmerId/unverify    Admin: withdraw a verification ({fields})
GET  /api/farmer-profiles/:farmerId      Saved eligibility facts (age, tenure, exclusions)
PUT  /api/farmer-profiles/:farmerId      Save them (null clears a field)
```

### Core
```
POST /api/login  /api/users  /api/forgot-password  /api/reset-password
GET  /api/crops  /api/users  /api/users/:id/notifications
POST /api/crop-plan  /api/user-crops  /api/activity
```

A guard on `/api` returns **503** when MongoDB is disconnected, so requests fail
in ~250 ms instead of hanging for Mongoose's 10-second buffering timeout. Routes
under `/api/farmers` are exempt, since Q&A works without the database.

---

## 6. How the significant parts work

### 6.1 Retrieval (RAG)

Scheme retrieval is **TF-IDF with cosine similarity**, implemented directly in
`services/schemeRetrieval.js` — no vector database, no embedding API. The corpus
is 7 documents, so the index is built once at startup and cached in memory.

```
tokenize → stopword removal → spelling normalisation
        → TF-IDF vectors → cosine similarity → top-K
```

Two details matter:

**Scheme documents carry an `applicability` field** describing the farm
situations each scheme suits, written in the vocabulary that farmer profiles
actually produce. Without it, profile queries had almost nothing to match
against: crop names, states, districts and irrigation types appear nowhere in
the scheme prose. This field is indexed for retrieval only and never reaches the
generation prompt.

**Queries emit only matchable terms.** Districts and rupee amounts are dropped
(they match nothing and dilute the vector); acreage becomes "small marginal
holding" or "medium larger holding", which is how scheme eligibility is actually
written.

Measured over 1,440 synthetic profiles: **91.0% top-1 accuracy, 100% top-3
recall**, no empty results. Since the controller requests `topK = 3`, the
correct scheme reaches the farmer every time.

### 6.2 The multilingual pipeline

```
Question (any language)
   │
   ├─ [voice] Groq whisper-large-v3 → transcript
   │
   ├─ Detect language + translate to English   (qwen3.8-27b)
   ├─ Scope check: schemes/weather only?       (keywords, no API call)
   ├─ Retrieve top-3 schemes                   (TF-IDF, English corpus)
   ├─ Generate grounded English answer         (gpt-oss-20b)
   └─ Translate answer back                    (qwen3.8-27b)
        │
        └─ Browser speechSynthesis reads it aloud
```

English is the pivot language because the scheme corpus and TF-IDF index are
English-only. Adding a language requires one entry in `supportedLanguages.js` —
the dropdown, request validation and Whisper hint all read from it.

**Reliability measures**, each added in response to an observed failure:

- **Script is ground truth.** Devanagari input is never treated as English, no
  matter what detection returns. The model intermittently reported `en` for
  Marathi text, which meant the answer was never translated back.
- **Retries with rate-limit awareness.** `services/groqClient.js` is a single
  HTTP layer that honours the delay Groq states in a 429 body ("try again in
  2.2875s") and retries 5xx and network errors.
- **Token budgets scale with input.** Devanagari costs 3–4× more tokens than
  English. A fixed budget made long answers return `finish_reason: "length"`
  with empty content, which a `|| englishText` fallback swallowed as success.
- **Honest failure.** If translation genuinely fails, the farmer is told the
  service is busy — *in their own language* — rather than receiving a confident
  answer to a question the system never read.

### 6.3 Scope enforcement

The assistant answers three things: **government schemes and loans, weather for
the farmer's district, and mandi prices**. Everything else is declined.

The decision is made in `services/questionScope.js` **before** generation is
called, because a prompt instruction is guidance, not a boundary. Keyword lists
decide the clear cases; only genuinely ambiguous questions cost an API call.
Questions fall into six categories:

| Category | Handling |
|---|---|
| scheme | Scheme retrieval, then a grounded answer |
| weather | Live OpenWeather data for the land record's district (no scheme retrieval) |
| mandi | Pointer to the Mandi Price card on the Loan Assistant page |
| agronomy | Crop, pest, soil, fertilizer, water questions: redirected to the local KVK, because there is no agronomy data to answer from |
| out | Declined (general knowledge, jokes, arithmetic) |
| unknown | One yes/no model call; if it fails the question is allowed through |

Broad farming words ("crop", "soil", "water", "land", "seed"...) no longer count
as in-scope on their own; a scheme, weather or mandi term must be present, and it
wins over a farming word ("subsidy for drip irrigation" is a scheme question).

Scheme answers need a relevance floor: if the best retrieval score is below 0.10
and the question doesn't name a scheme, the farmer is told the answer isn't in
the scheme documents instead of receiving one built from an unrelated scheme. The
floor is on the best score only because an acronym query scores low against long
documents (see `schemeRetrieval.js`).

Classification runs on the **English translation**, so one rule covers every
supported language, and refusals are translated back.

### 6.4 Loan eligibility scoring

Scoring is a **logistic regression model**, not an LLM call — deterministic,
instant, and explainable.

**Skipped answers are unknown, not bad.** The model needs income, existing loans,
credit history, the loan amount and land size (`REQUIRED_SCORE_INPUTS` in
`eligibilityScorer.js`). If any is missing the application is **not scored**: it gets
status `needs_more_info`, no score, and `missingFields` naming what to add. Nothing is
defaulted (a skipped income used to score as income 0, and a skipped credit history
as "bad" in the scorer but "OK" in the controller). An explicit 0, or an explicit
"credit history not clean", is a real answer and is scored. Scheme matching does not
depend on the loan being scored.

**Validation** uses express-validator. Shared helpers and conventions are in
`middleware/validation.js`; rules live beside what they guard
(`features/loanAssistant/middleware/validators.js` for the loan assistant,
`middleware/coreValidators.js` for accounts, the crop calendar and crop plan).
Every route that takes input is covered: ids in URLs must be valid, required fields
are listed together, money and area must be numbers (area and loan amount above 0,
income and existing loans 0 or more), durations must be whole numbers, emails
must look like emails, signup passwords need 8+ characters, questions must be
text of at most 1000 characters in a supported language, and blank optional fields
mean "not provided". Failures return 400 with a readable `error` and a structured
`errors[]`; none of these inputs can produce a 500 any more. A duplicate signup
email returns 409.

**Updating a loan.** `PATCH /api/loans/:loanId` takes the owner's `farmerId` plus any
of the answer fields: a field left out is unchanged, `null` clears it (back to
"not provided"). The application is re-scored, so a farmer whose application said
"needs more info" can add the missing answers without filing a second one. Changing
the purpose drops the matched schemes as stale.

**The farmer as a whole.** Q&A, scheme matching and eligibility use ALL of a farmer's
land records (`services/farmerContext.js`), not the newest one. Scheme limits are on
the family's total holding, so PM-KISAN's and Maandhan's 2-hectare limits are judged
on the sum across plots, and a crop rule passes if any of the farmer's crops is
covered. Scheme matching builds its retrieval query from every plot too.

**Eligibility with no loan.** `GET /api/schemes/eligibility?farmerId=...` returns a
verdict and one-line reason for every scheme from land records and saved facts alone,
ordered eligible first, plus `needsMoreInfoAbout` (what would settle the open
ones). An optional `purpose` lets the two purpose-based schemes (AIF, MISS) be
answered. The Loan Assistant page shows this at the top, above the steps.

**No approval step.** An application is the farmer's own record: answers, an eligibility
rating and score, and matched schemes. Nothing approves or rejects it; there is no
status, and no admin loan routes. (Admins still verify declared facts, below.)

**When land changes.** Adding a plot, or editing size, state, crop, soil or
irrigation (`PATCH /api/lands/:id`), brings the farmer's applications up to
date: scores are recomputed immediately, and matched schemes are flagged
`matchedSchemesStale` and recomputed in the background, one application at a time
(`services/loanRefresh.js`) since recomputing calls the language model. Editing only
a village or district does not trigger it. The page shows an "updating" notice until
the matches are fresh.

**Removing land.** `DELETE /api/lands/:id?farmerId=...` depends on the loan history: if an
application refers to the land it is archived (`archivedAt`) so it vanishes from the farmer's
holding, eligibility, Q&A and weather but the application still points at a real record;
if nothing refers to it, it is deleted. Archived land cannot be edited or used for a new
loan. Removing any plot refreshes the farmer's applications' matches.

**Several districts.** A weather question is answered for the district it names ("rain in
Nashik?"); otherwise for each distinct district the farmer has land in, largest holding
first, up to three, with a pointer to the rest.

**How firm a verdict is.** What a farmer enters in "About you" is their own word. No public
system can confirm someone's tax status or employment, so verification is a human step: an
admin checks documents and marks facts verified
(`POST /api/farmer-profiles/admin/:farmerId/verify`). Every verdict then carries `basis`:
`land_records` (rests on no declared fact), `self_declared` (rests on at least one
unverified fact, listed in `selfDeclared`) or `verified`. Changing or clearing a verified
fact drops its verification. The page and both prompts say when a verdict is unverified,
and approving an application whose matched schemes rest on unverified facts succeeds but
returns `warnings` naming them. Land size and crop are not covered: they come from land
records the lender should check against the documents they ask for.

Features: debt-to-income ratio, income per acre, existing loans, credit history.
`areaAcres` is deliberately **not** scored on its own: it overlapped with
`incomePerAcre` (which already encodes land size), and the model learned a
spurious negative weight on land size — a multicollinearity artifact implying
"more land = lower score".

Scheme eligibility is separate from the loan score and never uses it. It is decided
by `schemeEligibilityChecks.js` from one editable config, `data/schemeRules.json`,
which holds the rules for all 7 schemes (land size, age, crop class, land tenure,
loan purpose, and exclusions such as income-tax payers and government employees).
Each scheme returns **eligible / not_eligible / needs_more_info** with a one-line
reason:

- any *hard* rule failing (an exclusion, or a hard limit like Maandhan's 2 ha) gives
  `not_eligible`, even if other inputs are still missing;
- a missing input, or a *soft* limit that varies by state or season (PM-KISAN's
  2 ha target group, PMFBY's annual-crop coverage), gives `needs_more_info`;
- otherwise `eligible`.

The rules are taken from each scheme's criteria text in `schemes.json`; verify them
against the official guidelines before relying on them.

Age, land tenure and the exclusion facts are collected in the **"About you"**
panel on the Loan Assistant page and saved per farmer (`models/FarmerProfile.js`,
`GET/PUT /api/farmer-profiles/:farmerId`). Scheme matching and Q&A (typed and
spoken) both read them; anything not supplied is reported as "need to confirm".
A `farmerProfile` in the body of `POST /api/loans/:loanId/schemes` overrides the
saved values for that request.

The same verdicts are used three ways, so they cannot disagree:
- returned as `eligibility` on each matched scheme and shown as a badge on the page;
- given to the model in both prompts as a `VERIFIED ELIGIBILITY` line per scheme
  that it must not contradict;
- for `not_eligible`, the scheme's explanation is the rule's own text, not model
  wording.

### 6.5 Voice

**Input** — audio is POSTed as a raw body and read with `express.raw()`, so no
multipart upload dependency is needed. Groq `whisper-large-v3` transcribes it.

**Output** — the browser's built-in `speechSynthesis`, which is free and needs no
vendor account. After a spoken question the answer plays **automatically**,
since a farmer who asked aloud may not be able to read the reply. Recording also
**stops on its own** after 1.8 s of silence, detected via a Web Audio analyser,
because a farmer who cannot read the "Stop" label has no way to know a second
tap is required.

Voice selection prefers an exact language match, then the Indian regional
variant (`en-IN`), then any variant of the base language. Where no voice exists
for the answer's language, the **English** answer is read instead with a visible
note explaining why — understandable speech beats unintelligible speech.

### 6.6 Crops, units and the crop plan

`backend/shared/crops.json` is the single list of crops (54, with aliases such as paddy/dhan for rice
and eggplant/baingan for brinjal). Irrigation, scheme eligibility, mandi prices, the crop plan and the
calendar all resolve a typed crop through `shared/crops.js`: an exact name or alias first, then a
whole word ("Bt cotton"), longest name first, never a substring. Land is held in **acres** everywhere
(`shared/units.js` is the one conversion); `POST /api/crop-plan` takes acres (or `unit: "hectares"`),
prices in **INR** at a configurable `USD_TO_INR`, reads `"50-60 kg"` as a range (average used), and does
not multiply per-tree or per-plant rates by land area (they are shown as rates and left out of the
total). Mandi prices try each market name for the crop, widening name and place together.

### 6.7 Notifications

Harvest reminders and weather alerts live in `services/notifications.js` (decisions in
`services/weatherAlerts.js`), scheduled in IST. Weather alerts respect the email opt-out, look at the
next 24 hours as well as now, and send each alert type at most once per IST day. Harvest reminders
catch up missed days (the most urgent unsent one goes, older ones are closed), are marked sent only
when the email really sent, and use `harvestDuration` as the harvest window.

### 6.8 What a question costs

English questions cost no detection call, and fixed replies (declines, "ask your KVK") cost none; a
Marathi scheme question costs three (translate in, answer, translate back). Hindi and Marathi typed in
English letters are recognised by keywords (`languageHints.js`), with a glossary of farming words
passed to the model. Every question logs its model calls by purpose.

### 6.9 Conversation memory and the question log

The last 6 messages of a session (30-minute window; the database deletes them after 6 hours) let a
follow-up be understood: it is searched with the scheme under discussion, which is pinned first. Each
question also writes a log row (language, kind, outcome, retrieval scores, model calls) with **no
farmer id, session, original wording or answer text**; the question is scrubbed English and rows expire
after 90 days. `GET /api/admin/question-stats` shows the most common questions, the failures with the
best match score reached, and what is being declined.

### 6.10 Identity

Every route that reads or writes farmer data needs a farmer id that names a real account; otherwise
it answers a clear 401 (`login_required` / `unknown_account`). The pages use only the logged-in
account and go to the login page when there is none. Land and loans are readable only by their owner.
This is **identification, not authentication**: there is no login token yet, so anyone who knows a
user id can still use it. Records created before this under the shared id `farmer1` can be moved to a
real account with `scripts/reassign-farmer-records.mjs` (a dry run unless `--apply` is given).

### 6.11 How current the scheme details are

Each scheme has a `freshness` block: official `sourceUrl`, `lastVerified` date, the benefit figures
(copied only from this project's own notes) and a to-do list. **All source URLs and dates are empty
today**, because nobody has checked a scheme against an official source yet; every scheme answer and
card says so. When `lastVerified` is set the answer says "Scheme details last checked on <date>"
(the oldest date among the schemes used). `npm run corpus:todo` prints everything still to verify;
`-- --check` fails while anything remains. State schemes go in `data/stateSchemes.json` (Maharashtra
is there and empty); an entry without an official URL and check date is skipped, and farmers see a
state's schemes only when their land is in that state.

---

## 7. Configuration

`backend/.env`:

| Variable | Purpose |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `GROQ_API_KEY` | Groq API authentication |
| `GROQ_MODEL` | Generation model (`openai/gpt-oss-20b`) |
| `GROQ_TRANSLATION_MODEL` | Optional override (default `qwen/qwen3.8-27b`) |
| `GROQ_TRANSCRIPTION_MODEL` | Optional override (default `whisper-large-v3`) |
| `OPENWEATHER_API_KEY` | Weather API |
| `GMAIL_USER`, `GMAIL_PASS` | SMTP credentials (Gmail App Password) |
| `JWT_SECRET`, `JWT_EXPIRE` | Token signing |
| `ADMIN_API_KEY` | Admin route protection |
| `WEATHER_CRON` | Alert schedule (default hourly, IST) |
| `USD_TO_INR` | Rate used to show crop-plan costs in rupees (default 83.5 is stale: set today's rate) |

---

## 8. Running the project

**Prerequisites:** Node.js 22+, MongoDB running locally, a Groq API key, an
OpenWeatherMap API key.

```bash
# 1. MongoDB must be listening on 127.0.0.1:27017

# 2. Backend
cd backend
npm install
npm start                 # → http://localhost:5000

# 3. Frontend (separate terminal)
cd frontend
node server.js            # → http://localhost:3000
```

Then open `http://localhost:3000/ask-question`.

**Optional — Indian-language speech (Windows):**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-voices.ps1
```
Requires administrator rights; the script self-elevates. Note that Windows 11
Home Single Language offers **no Marathi TTS voice** — Marathi text answers work
correctly, but spoken output falls back to Indian English.

---

## 9. Known limitations

| Limitation | Detail |
|---|---|
| Marathi TTS unavailable | Windows offers no `mr-IN` voice package on Home editions. Text is unaffected; speech falls back to `en-IN`. |
| Groq free tier | 8000 tokens/minute. Each question costs three API calls, so heavy use hits the ceiling. Handled with retries and an honest "service is busy" message. |
| Synthetic training data | The eligibility model is trained on a synthetic dataset, not real lending outcomes. Scores are indicative, not decisions. |
| Admin routes | Protected only by a shared `ADMIN_API_KEY`, not per-user authentication. |
| Small corpus | 7 schemes. TF-IDF suits this size; a larger corpus would justify embeddings. |
| Not authenticated | Farmer ids are checked to exist, but there is no login token, so knowing a user id is enough to act as that user (see 6.10). |
| Scheme details unverified | No scheme has been checked against an official source; see 6.11 and `npm run corpus:todo`. |
| Frontend inconsistency | Static HTML and React coexist mid-migration. |
| Limited automated tests | `npm test` (in `backend/`) runs 20 offline tests covering retrieval, scope gating, scoring and eligibility checks. The Groq calls, voice path, auth and frontend are untested. |

---

## 10. Engineering notes

Several decisions in this codebase came from measurement rather than intuition,
and are worth preserving:

**Silent fallbacks are the dominant failure mode here.** Three separate bugs
followed the same shape: an API call failed, a `catch` substituted a plausible
default, and the farmer received a confident wrong answer with nothing logged.
Fallbacks in this codebase now either log loudly or tell the user what happened.

**TF-IDF failures are usually vocabulary problems, not scoring bugs.** A
retrieval defect here was initially attributed to a cosine-normalisation bug.
The cosine implementation was in fact correct; the real cause was that 12 of 17
query terms existed nowhere in the corpus. Check term overlap before changing
similarity math.

**Prompt framing leaks into output.** The translation prompt once opened with
"You are a translation assistant for an Indian farming app", which primed the
model to invent plausible farming questions instead of translating what was
asked. Removing the domain framing fixed it.

**Deterministic beats prompted where correctness matters.** Eligibility verdicts,
scope enforcement and language detection from script are all decided in code.
Prompt instructions are used for tone and phrasing, not for rules.

---

*Generated 15 September 2026.*
