// Who is asking? Every route that reads or writes a farmer's records must be told which farmer,
// and that farmer must exist.
//
// What this replaces: the pages fell back to a shared "farmer1" (or the user's NAME) when nobody
// was logged in, and the server accepted any string as a farmer id, so records could be created
// for people who do not exist, and such records piled up under "farmer1".
//
// What this is NOT: authentication. There is no login token yet, so this proves an id names a
// real account, not that the caller is that account's owner. Anyone who knows (or guesses) a user
// id can still act as that user until the login issues and checks a token. The 401s below are
// "no identity / no such account", which is what the app can honestly say today.

import mongoose from "mongoose";

const OBJECT_ID = /^[a-f\d]{24}$/i;

export const LOGIN_REQUIRED = { error: "Please log in to continue.", code: "login_required" };
export const UNKNOWN_ACCOUNT = { error: "We couldn't find your account. Please log in again.", code: "unknown_account" };

// A positive answer is remembered briefly so a page making several calls does not look the
// account up every time. A deleted account stops working within the TTL.
const KNOWN_FOR_MS = 60 * 1000;
const MAX_REMEMBERED = 500;
const remembered = new Map(); // id -> expiry timestamp

export function forgetRememberedAccounts() {
  remembered.clear();
}

async function accountExists(id) {
  const expiry = remembered.get(id);
  if (expiry && expiry > Date.now()) return true;

  const found = await mongoose.model("User").exists({ _id: id });
  if (found) {
    if (remembered.size >= MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
    remembered.set(id, Date.now() + KNOWN_FOR_MS);
  }
  return Boolean(found);
}

/**
 * Express middleware: the farmer id must be present and name an existing account.
 *
 * @param {"params"|"body"|"query"} source  where the id is read from
 * @param {string} field                    its name (default "farmerId")
 * @param {object} options
 *   failOpenWhenDbDown  Let the request through (instead of 503) when the database is down. Only
 *                       for the Q&A routes, which are built to keep answering general scheme
 *                       questions without a database; they read no farmer data in that case.
 *   exists              Replace the account lookup (for tests).
 *   connected           Replace the "is the database up" check (for tests).
 */
export function requireFarmer(source, field = "farmerId", { failOpenWhenDbDown = false, exists = accountExists, connected = () => mongoose.connection.readyState === 1 } = {}) {
  return async function requireFarmerMiddleware(req, res, next) {
    const id = req[source]?.[field];

    // No identity at all: nobody is logged in.
    if (typeof id !== "string" || id.trim() === "") return res.status(401).json(LOGIN_REQUIRED);

    // Not even the shape of an account id (e.g. the old "farmer1" fallback, or a user NAME).
    if (!OBJECT_ID.test(id)) return res.status(401).json(UNKNOWN_ACCOUNT);

    if (!connected()) {
      if (failOpenWhenDbDown) return next();
      return res.status(503).json({ error: "The database is unavailable, so this feature can't be used right now." });
    }

    try {
      if (await exists(id)) return next();
      return res.status(401).json(UNKNOWN_ACCOUNT);
    } catch (err) {
      console.error(`Could not check account ${id}: ${err.message}`);
      return res.status(503).json({ error: "We couldn't check your account right now. Please try again." });
    }
  };
}

export const farmerInParams = (opts) => requireFarmer("params", "farmerId", opts);
export const farmerInBody = (opts) => requireFarmer("body", "farmerId", opts);
export const farmerInQuery = (opts) => requireFarmer("query", "farmerId", opts);
