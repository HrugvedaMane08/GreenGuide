// Moves records from one farmer id to another, e.g. the ones created while nobody was logged in
// and the pages fell back to a shared "farmer1".
//
//   node scripts/reassign-farmer-records.mjs --from farmer1 --to <user id>            (dry run: shows what would move)
//   node scripts/reassign-farmer-records.mjs --from farmer1 --to <user id> --apply    (does it)
//
// The target must be a real user. Nothing is deleted. A farmer profile ("About you" answers) is
// only moved if the target has none, since a farmer has one and silently merging two would mix
// answers given by different people; if both exist the old one is left where it is and reported.
// Back up first if the data matters (mongodump), because --apply changes documents in place.

import "dotenv/config";
import mongoose from "mongoose";

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const from = value("--from");
const to = value("--to");
const apply = args.includes("--apply");

if (!from || !to || from === to) {
  console.error("Usage: node scripts/reassign-farmer-records.mjs --from <old farmer id> --to <user id> [--apply]");
  process.exit(2);
}
if (!/^[a-f\d]{24}$/i.test(to)) {
  console.error(`--to must be a user id (24 hex characters); "${to}" is not.`);
  process.exit(2);
}

await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/mydb", { serverSelectionTimeoutMS: 5000 });
const db = mongoose.connection.db;

try {
  const user = await db.collection("users").findOne({ _id: new mongoose.Types.ObjectId(to) }, { projection: { name: 1 } });
  if (!user) {
    console.error(`No user has the id ${to}. Nothing was changed.`);
    process.exitCode = 1;
  } else {
    console.log(`${apply ? "MOVING" : "DRY RUN: would move"} records from "${from}" to ${user.name ?? "(unnamed)"} (${to})\n`);

    for (const collection of ["lands", "loanapplications", "conversationmessages"]) {
      const n = await db.collection(collection).countDocuments({ farmerId: from });
      if (apply && n > 0) await db.collection(collection).updateMany({ farmerId: from }, { $set: { farmerId: to } });
      console.log(`${collection.padEnd(22)} ${n} ${apply ? "moved" : "to move"}`);
    }

    const profileFrom = await db.collection("farmerprofiles").findOne({ farmerId: from });
    const profileTo = await db.collection("farmerprofiles").findOne({ farmerId: to });
    if (!profileFrom) console.log(`${"farmerprofiles".padEnd(22)} none`);
    else if (profileTo) console.log(`${"farmerprofiles".padEnd(22)} LEFT in place: ${user.name} already has their own answers; merge by hand if you want them`);
    else {
      if (apply) await db.collection("farmerprofiles").updateOne({ farmerId: from }, { $set: { farmerId: to } });
      console.log(`${"farmerprofiles".padEnd(22)} 1 ${apply ? "moved" : "to move"}`);
    }

    if (!apply) console.log("\nNothing was changed. Add --apply to do it.");
  }
} finally {
  await mongoose.disconnect();
}
