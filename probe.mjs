// Probe the (undocumented) WoW: Forever auction house API.
// Run: node --env-file=.env probe.mjs [houseId]
import { mkdir, writeFile } from "node:fs/promises";

const { BLIZZARD_CLIENT_ID: id, BLIZZARD_CLIENT_SECRET: secret } = process.env;
const REGION = (process.env.REGION || "us").toLowerCase();
const RULESET = process.env.RULESET_ID || "1";
const LOCALE = { us: "en_US", eu: "en_GB", kr: "ko_KR", tw: "zh_TW" }[REGION] ?? "en_US";
const API = `https://${REGION}.api.blizzard.com`;
const DYNAMIC = `dynamic-forever-${REGION}`;
const STATIC = `static-forever-${REGION}`;
const ITEM_SAMPLE = 25;

if (!id || !secret) {
  console.error("Missing BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

await mkdir("out", { recursive: true });

// 1. OAuth client-credentials token
const tokenRes = await fetch("https://oauth.battle.net/token", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
if (!tokenRes.ok) {
  console.error(`Token request failed: ${tokenRes.status} ${await tokenRes.text()}`);
  process.exit(1);
}
const { access_token, expires_in } = await tokenRes.json();
console.log(`✔ Got access token (expires in ${Math.round(expires_in / 3600)}h)\n`);

async function get(path, namespace) {
  const url = `${API}${path}${path.includes("?") ? "&" : "?"}namespace=${namespace}&locale=${LOCALE}`;
  const t0 = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  const text = await res.text();
  return {
    status: res.status,
    ms: Date.now() - t0,
    bytes: text.length,
    lastModified: res.headers.get("last-modified"),
    json: res.ok ? JSON.parse(text) : null,
    text,
  };
}

// 2. Auction house index for the ruleset
console.log(`== AH index: region=${REGION} ruleset=${RULESET} ==`);
const index = await get(`/data/wow/ruleset/${RULESET}/auctions/`, DYNAMIC);
console.log(`HTTP ${index.status} in ${index.ms}ms, Last-Modified: ${index.lastModified}`);
if (!index.json) {
  console.error(index.text.slice(0, 500));
  process.exit(1);
}
await writeFile("out/index.json", JSON.stringify(index.json, null, 2));
const houses = (index.json.auctions ?? []).map((h) => ({ id: h.id, name: h.name }));
console.table(houses);

// 3. Pull one house
const houseId = process.argv[2] || houses[0]?.id;
if (!houseId) {
  console.error("No house IDs found in index — see out/index.json");
  process.exit(1);
}
console.log(`\n== House ${houseId} ==`);
const house = await get(`/data/wow/ruleset/${RULESET}/auctions/${houseId}`, DYNAMIC);
console.log(`HTTP ${house.status} in ${house.ms}ms, ${(house.bytes / 1e6).toFixed(1)} MB, Last-Modified: ${house.lastModified}`);
if (!house.json) {
  console.error(house.text.slice(0, 500));
  process.exit(1);
}
await writeFile(`out/house-${houseId}.json`, JSON.stringify(house.json));
const auctions = house.json.auctions ?? [];
const itemIds = [...new Set(auctions.map((a) => a.item?.id).filter(Boolean))];
const withUnit = auctions.filter((a) => a.unit_price != null).length;
console.log(`Auctions: ${auctions.length}  |  distinct items: ${itemIds.length}  |  unit_price (commodity-style): ${withUnit}`);
if (auctions[0]) console.log("Sample auction:", JSON.stringify(auctions[0]));

// 4. Commodities sub-endpoint
const comm = await get(`/data/wow/ruleset/${RULESET}/auctions/${houseId}/commodities`, DYNAMIC);
console.log(`\nCommodities endpoint: HTTP ${comm.status}, ${(comm.bytes / 1e6).toFixed(1)} MB, auctions: ${comm.json?.auctions?.length ?? "n/a"}`);

// 5. Item metadata coverage (sample)
console.log(`\n== Item lookup sample (${Math.min(ITEM_SAMPLE, itemIds.length)} items, ${STATIC}) ==`);
let missing = 0;
for (const itemId of itemIds.slice(0, ITEM_SAMPLE)) {
  const r = await get(`/data/wow/item/${itemId}`, STATIC);
  if (r.status !== 200) missing++;
  console.log(`${String(itemId).padStart(7)}  ${r.status}  ${r.json?.name ?? ""}`);
}
console.log(`Item 404/err rate in sample: ${missing}/${Math.min(ITEM_SAMPLE, itemIds.length)}`);
console.log("\nRaw responses saved in ./out/");
