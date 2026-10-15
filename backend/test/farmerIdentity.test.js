import test from "node:test";
import assert from "node:assert/strict";

import { requireFarmer, farmerInParams, farmerInBody, farmerInQuery, LOGIN_REQUIRED, UNKNOWN_ACCOUNT } from "../middleware/farmerIdentity.js";

const GOOD = "64b7f0c2a1b2c3d4e5f60718";

// Runs the middleware on a fake request and reports what happened.
async function run(middleware, req) {
  let status = null, json = null, passed = false;
  const res = { status(c) { status = c; return this; }, json(p) { json = p; return this; } };
  await middleware({ params: {}, body: {}, query: {}, ...req }, res, () => { passed = true; });
  return { passed, status, json };
}
const known = (...ids) => ({ exists: async (id) => ids.includes(id), connected: () => true });

test("a known account passes, wherever the id is read from", async () => {
  const opts = known(GOOD);
  assert.ok((await run(farmerInParams(opts), { params: { farmerId: GOOD } })).passed);
  assert.ok((await run(farmerInBody(opts), { body: { farmerId: GOOD } })).passed);
  assert.ok((await run(farmerInQuery(opts), { query: { farmerId: GOOD } })).passed);
  assert.ok((await run(requireFarmer("body", "userId", opts), { body: { userId: GOOD } })).passed);
});

test("nobody logged in: a clear 401 asking for login", async () => {
  for (const req of [{}, { body: {} }, { body: { farmerId: "" } }, { body: { farmerId: "   " } }, { body: { farmerId: null } }, { body: { farmerId: 5 } }, { body: { farmerId: ["a"] } }]) {
    const r = await run(farmerInBody(known(GOOD)), req);
    assert.equal(r.status, 401, JSON.stringify(req));
    assert.deepEqual(r.json, LOGIN_REQUIRED);
  }
  assert.equal(LOGIN_REQUIRED.code, "login_required");
  assert.match(LOGIN_REQUIRED.error, /log in/i);
});

test("the old fallbacks are refused: 'farmer1' and a user's NAME are not accounts", async () => {
  for (const id of ["farmer1", "Asha Patil", "riya", "123", "64b7f0c2a1b2c3d4e5f6071", "64b7f0c2a1b2c3d4e5f60718z"]) {
    const r = await run(farmerInParams(known(GOOD)), { params: { farmerId: id } });
    assert.equal(r.status, 401, id);
    assert.deepEqual(r.json, UNKNOWN_ACCOUNT);
  }
});

test("a well-formed id that names no account is refused (the farmer is checked to exist)", async () => {
  const r = await run(farmerInQuery(known(GOOD)), { query: { farmerId: "64b7f0c2a1b2c3d4e5f60999" } });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, "unknown_account");
});

test("with the database down: 503, except the Q&A routes, which still answer general questions", async () => {
  const down = { exists: async () => { throw new Error("must not be asked"); }, connected: () => false };
  const strict = await run(farmerInParams(down), { params: { farmerId: GOOD } });
  assert.equal(strict.status, 503);
  const qa = await run(farmerInParams({ ...down, failOpenWhenDbDown: true }), { params: { farmerId: GOOD } });
  assert.ok(qa.passed);
  // fail-open is for a database that is down, never for a missing or malformed identity
  assert.equal((await run(farmerInParams({ ...down, failOpenWhenDbDown: true }), { params: {} })).status, 401);
  assert.equal((await run(farmerInParams({ ...down, failOpenWhenDbDown: true }), { params: { farmerId: "farmer1" } })).status, 401);
});

test("a failing account lookup is a 503, not a pass and not a crash", async () => {
  const r = await run(farmerInParams({ exists: async () => { throw new Error("boom"); }, connected: () => true }), { params: { farmerId: GOOD } });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /try again/i);
});

test("identity is checked before anything else can run", async () => {
  // the middleware never calls next() on a refusal, so a controller behind it cannot run
  let reached = false;
  const res = { status() { return this; }, json() { return this; } };
  await farmerInBody(known())({ body: { farmerId: "farmer1" } }, res, () => { reached = true; });
  assert.equal(reached, false);
});
