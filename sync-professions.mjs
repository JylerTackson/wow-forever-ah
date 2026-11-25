// Download all professions + recipes (with reagents) into the database.
//   node --env-file=.env sync-professions.mjs
// Re-run after a game patch. The web UI also has a "Sync professions" button that does the same.
import { requireCredentials } from "./lib/blizzard.mjs";
import { openDb } from "./lib/db.mjs";
import { syncProfessions } from "./lib/professions.mjs";

requireCredentials();
const t0 = Date.now();
const n = await syncProfessions(openDb());
console.log(`Done: ${n} recipes in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
