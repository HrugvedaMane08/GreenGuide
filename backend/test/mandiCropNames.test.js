import test, { mock } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

import { lookupCrop } from "../features/loanAssistant/services/schemeEligibilityChecks.js";
import { commodityCandidates } from "../features/loanAssistant/services/mandiCommodity.js";
import { getMandiPriceForLand } from "../features/loanAssistant/controllers/mandiController.js";
import Land from "../features/loanAssistant/models/Land.js";

// ---------- the crop-name matcher ----------

test("synonyms and spellings resolve to one canonical crop", () => {
  for (const [typed, key] of [
    ["Brinjal (Eggplant)", "brinjal"], ["eggplant", "brinjal"], ["Baingan", "brinjal"], ["COTTON", "cotton"], ["cotton ", "cotton"],
    ["Paddy", "rice"], ["dhan", "rice"], ["Corn", "maize"], ["Jowar (Sorghum)", "sorghum"], ["Okra (Lady's Finger)", "okra"],
    ["Bell Pepper", "capsicum"], ["soyabean", "soybean"], ["Green Gram (Moong)", "green gram"], ["moong", "green gram"],
    ["hybrid maize", "maize"], ["Bt cotton", "cotton"],
  ]) {
    assert.equal(lookupCrop(typed)?.key, key, typed);
  }
});

test("matching is whole-word, never a substring (licorice is not rice)", () => {
  assert.equal(lookupCrop("licorice"), null);
  assert.equal(lookupCrop("dragonfruit-xyz"), null);
  assert.equal(lookupCrop(""), null);
  assert.equal(lookupCrop(undefined), null);
});

test("existing behaviour is kept: duration and category still come back", () => {
  assert.equal(lookupCrop("sugarcane").duration, "long-duration");
  assert.equal(lookupCrop("Paddy").duration, "annual");
  assert.equal(lookupCrop("Paddy").matchedAs, "paddy");
});

// ---------- candidate market names ----------

test("messy input becomes clean, ordered, de-duplicated candidates", () => {
  assert.deepEqual(commodityCandidates("Brinjal (Eggplant)"), ["Brinjal", "Eggplant"]);
  assert.deepEqual(commodityCandidates("cotton "), ["Cotton"]);
  assert.deepEqual(commodityCandidates("  COTTON  "), ["Cotton"]);
  assert.deepEqual(commodityCandidates("baingan"), ["Brinjal", "Baingan"]);
});

test("a crop the feed names differently tries the feed's own name first", () => {
  const rice = commodityCandidates("Paddy");
  assert.equal(rice[0], "Paddy(Dhan)(Common)");
  assert.ok(rice.includes("Rice") && rice.includes("Paddy"));
  assert.equal(commodityCandidates("Green Gram (Moong)")[0], "Green Gram (Moong)(Whole)");
});

test("a crop that is not in our list is still tried under the name it was given", () => {
  assert.deepEqual(commodityCandidates("Dragon Fruit"), ["Dragon Fruit"]);
  assert.deepEqual(commodityCandidates("Dragon Fruit (Pitaya)"), ["Dragon Fruit", "Pitaya"]);
});

test("nothing typed means no candidates", () => {
  assert.deepEqual(commodityCandidates(""), []);
  assert.deepEqual(commodityCandidates("   "), []);
  assert.deepEqual(commodityCandidates(undefined), []);
});

// ---------- the controller: widen BOTH name and place ----------

function stubFeed(handler) {
  const calls = [];
  mock.method(axios, "get", async (_url, { params }) => {
    const call = { commodity: params["filters[commodity]"], district: params["filters[district]"], state: params["filters[state]"] };
    calls.push(call);
    const records = handler(call) ? [{ commodity: call.commodity, state: call.state ?? "Karnataka", district: "x", market: "m", modal_price: "2500" }] : [];
    return { data: { records } };
  });
  return calls;
}
function stubLand(land) {
  const seen = [];
  mock.method(Land, "findOne", async (filter) => { seen.push(filter); return land; });
  return seen;
}
async function callController() {
  let status = 200, body;
  const res = { status(c) { status = c; return this; }, json(p) { body = p; return this; } };
  await getMandiPriceForLand({ params: { landId: "64b7f0c2a1b2c3d4e5f60718" }, query: { farmerId: "64b7f0c2a1b2c3d4e5f60001" } }, res);
  return { status, body };
}

test("a messy crop name is found on the first request", async (t) => {
  t.after(() => mock.restoreAll());
  const calls = stubFeed((c) => c.commodity === "Brinjal");
  stubLand({ primaryCrop: "Brinjal (Eggplant)", state: "Maharashtra", district: "Pune" });
  const { status, body } = await callController();
  assert.equal(status, 200);
  assert.equal(calls.length, 1);
  assert.equal(body.matchedCommodity, "Brinjal");
  assert.equal(body.matchedScope, "district");
  assert.equal(body.records.length, 1);
});

test("widening changes the NAME as well as the place, name by name", async (t) => {
  t.after(() => mock.restoreAll());
  // The feed only knows rice as "Paddy(Dhan)(Common)", and only reports it at state level.
  const calls = stubFeed((c) => c.commodity === "Paddy(Dhan)(Common)" && c.district === undefined);
  stubLand({ primaryCrop: "rice", state: "Maharashtra", district: "Pune" });
  const { body } = await callController();
  assert.deepEqual(calls.map((c) => `${c.commodity}|${c.district ?? "-"}|${c.state ?? "-"}`), [
    "Paddy(Dhan)(Common)|Pune|Maharashtra",
    "Paddy(Dhan)(Common)|-|Maharashtra",
  ]);
  assert.equal(body.matchedCommodity, "Paddy(Dhan)(Common)");
  assert.equal(body.matchedScope, "state");
});

test("when the first name has no data anywhere, the next name is tried", async (t) => {
  t.after(() => mock.restoreAll());
  const calls = stubFeed((c) => c.commodity === "Rice" && c.state === undefined); // only "Rice", only all-India
  stubLand({ primaryCrop: "paddy", state: "Maharashtra", district: "Pune" });
  const { body } = await callController();
  assert.equal(body.matchedCommodity, "Rice");
  assert.equal(body.matchedScope, "all-india");
  // "Paddy(Dhan)(Common)" fails in all 3 places (3 requests), then "Rice" fails at district and state before hitting at all-India.
  assert.equal(calls.length, 6);
  assert.ok(body.tried.includes("Paddy(Dhan)(Common) / all-india"));
});

test("no data under any name: an empty result that says everything it tried", async (t) => {
  t.after(() => mock.restoreAll());
  stubFeed(() => false);
  stubLand({ primaryCrop: "Brinjal (Eggplant)", state: "Maharashtra", district: "Pune" });
  const { status, body } = await callController();
  assert.equal(status, 200);
  assert.equal(body.records.length, 0);
  assert.equal(body.matchedCommodity, null);
  assert.equal(body.tried.length, 6); // 2 names x 3 places
  assert.ok(body.tried.includes("Eggplant / all-india"));
});

test("a land with no state or district skips the narrower scopes", async (t) => {
  t.after(() => mock.restoreAll());
  const calls = stubFeed(() => false);
  stubLand({ primaryCrop: "Wheat" });
  await callController();
  assert.deepEqual(calls.map((c) => `${c.district ?? "-"}|${c.state ?? "-"}`), ["-|-"]);
});

test("no crop recorded -> 400; archived or missing land -> 404 (archived land is never read)", async (t) => {
  t.after(() => mock.restoreAll());
  const seen = stubLand({ primaryCrop: "  ", state: "x", district: "y" });
  assert.equal((await callController()).status, 400);
  assert.deepEqual(seen[0].archivedAt, null);
  assert.equal(seen[0].farmerId, "64b7f0c2a1b2c3d4e5f60001"); // only the owner's land is ever read
  mock.restoreAll();
  stubLand(null);
  assert.equal((await callController()).status, 404);
});

test("a feed failure is a 502, and the loop does not keep hammering a dead feed", async (t) => {
  t.after(() => mock.restoreAll());
  let n = 0;
  mock.method(axios, "get", async () => { n += 1; throw new Error("connect ECONNREFUSED"); });
  stubLand({ primaryCrop: "Brinjal (Eggplant)", state: "Maharashtra", district: "Pune" });
  const { status } = await callController();
  assert.equal(status, 502);
  assert.equal(n, 1);
});
