import { useState } from "react";

const API_URL = process.env.REACT_APP_API_URL || "http://localhost:5000";

const INDIAN_STATES = [
  "Maharashtra", "Karnataka", "Gujarat", "Madhya Pradesh", "Uttar Pradesh",
  "Punjab", "Haryana", "Rajasthan", "Tamil Nadu", "Andhra Pradesh",
  "Telangana", "West Bengal", "Bihar", "Other",
];

const initialForm = {
  ownerName: "",
  aadhaarNumber: "",
  state: "",
  district: "",
  village: "",
  surveyNumber: "",
  areaAcres: "",
  irrigated: "unirrigated",
};

// Small header icon whose plot size visually reflects the acreage entered.
function FieldPlotIcon({ acres }) {
  const value = parseFloat(acres);
  const filled = !isNaN(value) && value > 0 ? Math.min(value, 10) : 0;
  const cols = 5;
  const rows = 2;
  const totalCells = cols * rows;
  const filledCells = Math.round((filled / 10) * totalCells);

  return (
    <svg width="56" height="40" viewBox="0 0 56 40" className="shrink-0">
      <rect x="0" y="0" width="56" height="40" rx="4" fill="#e8f0e9" />
      {Array.from({ length: totalCells }).map((_, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const isFilled = i < filledCells;
        return (
          <rect
            key={i}
            x={2 + col * 10.8}
            y={2 + row * 18}
            width="9.6"
            height="16"
            rx="1.5"
            fill={isFilled ? "#0e3b2e" : "#c9dccb"}
          />
        );
      })}
    </svg>
  );
}

export default function LandForm() {
  const [form, setForm] = useState(initialForm);
  const [status, setStatus] = useState("idle"); // idle | submitting | success | error
  const [errorMsg, setErrorMsg] = useState("");
  const [savedRecord, setSavedRecord] = useState(null);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function validate() {
    if (!form.ownerName.trim()) return "Owner name is required.";
    if (!/^\d{12}$/.test(form.aadhaarNumber))
      return "Aadhaar number must be exactly 12 digits.";
    if (!form.state) return "State is required.";
    if (!form.district.trim()) return "District is required.";
    if (!form.village.trim()) return "Village is required.";
    const acres = parseFloat(form.areaAcres);
    if (isNaN(acres) || acres <= 0) return "Enter a valid land area in acres.";
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setStatus("error");
      setErrorMsg(validationError);
      return;
    }

    setStatus("submitting");
    setErrorMsg("");

    try {
      const res = await fetch(`${API_URL}/api/land-records`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          areaAcres: parseFloat(form.areaAcres),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Request failed (${res.status})`);
      }

      const data = await res.json();
      setSavedRecord(data);
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err.message || "Something went wrong. Please try again.");
    }
  }

  function handleReset() {
    setForm(initialForm);
    setSavedRecord(null);
    setStatus("idle");
    setErrorMsg("");
  }

  return (
    <div className="min-h-screen bg-[#e8f0e9] flex justify-center items-start py-10 px-4">
      <div className="w-full max-w-xl">
        <div className="bg-white rounded-2xl shadow-md overflow-hidden">
          {/* Header */}
          <div className="bg-[#0e3b2e] px-6 py-5 flex items-center gap-4">
            <FieldPlotIcon acres={form.areaAcres} />
            <div>
              <h1 className="text-white text-lg font-semibold">
                Land Record
              </h1>
              <p className="text-[#c9dccb] text-sm">
                Enter your land details to get started
              </p>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 py-6 space-y-6">
            {/* Land basics */}
            <fieldset className="space-y-4">
              <legend className="text-[#0e3b2e] font-medium text-sm uppercase tracking-wide mb-1">
                Land Basics
              </legend>

              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  Owner Name
                </label>
                <input
                  type="text"
                  name="ownerName"
                  value={form.ownerName}
                  onChange={handleChange}
                  placeholder="e.g. Ramesh Patil"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#0e3b2e] focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  Aadhaar Number
                </label>
                <input
                  type="text"
                  name="aadhaarNumber"
                  value={form.aadhaarNumber}
                  onChange={handleChange}
                  placeholder="12-digit Aadhaar number"
                  maxLength={12}
                  inputMode="numeric"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#0e3b2e] focus:border-transparent"
                />
              </div>
            </fieldset>

            {/* Location */}
            <fieldset className="space-y-4">
              <legend className="text-[#0e3b2e] font-medium text-sm uppercase tracking-wide mb-1">
                Location
              </legend>

              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  State
                </label>
                <select
                  name="state"
                  value={form.state}
                  onChange={handleChange}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-800 bg-white focus:outline-none focus:ring-2 focus:ring-[#0e3b2e] focus:border-transparent"
                >
                  <option value="">Select state</option>
                  {INDIAN_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">
                    District
                  </label>
                  <input
                    type="text"
                    name="district"
                    value={form.district}
                    onChange={handleChange}
                    placeholder="e.g. Nashik"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#0e3b2e] focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">
                    Village
                  </label>
                  <input
                    type="text"
                    name="village"
                    value={form.village}
                    onChange={handleChange}
                    placeholder="e.g. Sinnar"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#0e3b2e] focus:border-transparent"
                  />
                </div>
              </div>
            </fieldset>

            {/* Area */}
            <fieldset className="space-y-4">
              <legend className="text-[#8b5e34] font-medium text-sm uppercase tracking-wide mb-1">
                Area & Survey
              </legend>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">
                    Survey Number
                  </label>
                  <input
                    type="text"
                    name="surveyNumber"
                    value={form.surveyNumber}
                    onChange={handleChange}
                    placeholder="e.g. 142/2"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#8b5e34] focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">
                    Area (acres)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="areaAcres"
                    value={form.areaAcres}
                    onChange={handleChange}
                    placeholder="e.g. 1.5"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#8b5e34] focus:border-transparent"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  Irrigation Status
                </label>
                <div className="flex gap-4">
                  {["irrigated", "unirrigated"].map((opt) => (
                    <label
                      key={opt}
                      className="flex items-center gap-2 text-sm text-gray-700"
                    >
                      <input
                        type="radio"
                        name="irrigated"
                        value={opt}
                        checked={form.irrigated === opt}
                        onChange={handleChange}
                        className="accent-[#8b5e34]"
                      />
                      {opt === "irrigated" ? "Irrigated" : "Unirrigated"}
                    </label>
                  ))}
                </div>
              </div>
            </fieldset>

            {status === "error" && (
              <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">
                {errorMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={status === "submitting"}
              className="w-full bg-[#0e3b2e] hover:bg-[#12503e] disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
            >
              {status === "submitting" ? "Saving..." : "Save Land Record"}
            </button>
          </form>
        </div>

        {/* Results panel */}
        {status === "success" && savedRecord && (
          <div className="mt-6 bg-white rounded-2xl shadow-md p-6 border-l-4 border-[#0e3b2e]">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[#0e3b2e] font-semibold text-base">
                Land Record Saved
              </h2>
              <button
                onClick={handleReset}
                className="text-sm text-[#8b5e34] hover:underline"
              >
                Add another
              </button>
            </div>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-gray-500">Owner</dt>
              <dd className="text-gray-800">{form.ownerName}</dd>
              <dt className="text-gray-500">Location</dt>
              <dd className="text-gray-800">
                {form.village}, {form.district}, {form.state}
              </dd>
              <dt className="text-gray-500">Survey No.</dt>
              <dd className="text-gray-800">{form.surveyNumber || "—"}</dd>
              <dt className="text-gray-500">Area</dt>
              <dd className="text-gray-800">
                {form.areaAcres} acres ({form.irrigated})
              </dd>
              {savedRecord._id && (
                <>
                  <dt className="text-gray-500">Record ID</dt>
                  <dd className="text-gray-800 font-mono text-xs">
                    {savedRecord._id}
                  </dd>
                </>
              )}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}