import axios from "axios";

const MANDI_RESOURCE_ID = "9ef84268-d588-465a-a308-a864a43d0070";
const MANDI_API_URL = `https://api.data.gov.in/resource/${MANDI_RESOURCE_ID}`;

// data.gov.in publishes a public sample key that works for testing but caps
// results at 10 records. Get your own free key at https://data.gov.in
// (My Account -> Generate API Key) and set DATA_GOV_API_KEY in .env for
// production use / higher limits.
const SAMPLE_API_KEY = "579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b";

/**
 * Fetch current mandi (market) prices for a given crop/commodity, optionally
 * narrowed by state and district. Returns raw AGMARKNET records.
 */
export async function fetchMandiPrices({ commodity, state, district, limit = 10 }) {
  if (!commodity) {
    throw new Error("commodity is required to fetch mandi prices");
  }

  const apiKey = process.env.DATA_GOV_API_KEY || SAMPLE_API_KEY;

  const params = {
    "api-key": apiKey,
    format: "json",
    limit,
    "filters[commodity]": commodity
  };
  if (state) params["filters[state]"] = state;
  if (district) params["filters[district]"] = district;

  const response = await axios.get(MANDI_API_URL, { params, timeout: 10000 });
  const records = response.data?.records || [];

  return records.map((r) => ({
    state: r.state,
    district: r.district,
    market: r.market,
    commodity: r.commodity,
    variety: r.variety,
    arrivalDate: r.arrival_date,
    minPrice: Number(r.min_price) || null,
    maxPrice: Number(r.max_price) || null,
    modalPrice: Number(r.modal_price) || null
  }));
}

/**
 * Summarize a set of mandi records into a single average-modal-price figure,
 * useful for a quick headline number in the UI.
 */
export function summarizeMandiRecords(records) {
  const withModal = records.filter((r) => typeof r.modalPrice === "number");
  if (withModal.length === 0) {
    return { averageModalPrice: null, marketsReporting: 0 };
  }
  const avg = withModal.reduce((sum, r) => sum + r.modalPrice, 0) / withModal.length;
  return {
    averageModalPrice: Math.round(avg),
    marketsReporting: withModal.length
  };
}