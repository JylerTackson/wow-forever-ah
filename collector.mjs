// WoW: Forever auction house collector.
//   node --env-file=.env collector.mjs          -> collect once
//   node --env-file=.env collector.mjs --loop   -> collect now, then re-check every POLL_MINUTES
//
// For each house it fetches the main (buyout) endpoint and the /commodities endpoint,
// skips snapshots it already has (by Last-Modified), stores per-item price stats, and
// diffs against the previous snapshot to estimate sales.
//
// How sales are estimated (the API has no sales data): an auction that disappears between two
// snapshots either sold, was cancelled, or expired. If the gap between snapshots is shorter than
// the minimum remaining time its time_left bucket guarantees, it can't have expired, so we count
// it as sold. A commodity auction whose quantity dropped was partially bought. Cancellations are
// indistinguishable from sales, so treat the numbers as an upper-bound estimate.
import { HOUSES, NS, RULESET, apiGet, pool, requireCredentials, sleep, staticGet } from "./lib/blizzard.mjs";
import { openDb, transaction } from "./lib/db.mjs";

requireCredentials();
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 10);
const KINDS = { main: "", commodities: "/commodities" };
// Minimum time remaining guaranteed by each time_left bucket (conservative across Classic/retail).
const MIN_TIME_LEFT = { SHORT: 0, MEDIUM: 30 * 60_000, LONG: 2 * 3600_000, VERY_LONG: 8 * 3600_000 };

const db = openDb();

// ---------- collection ----------
const latestSnapshot = db.prepare(
  "SELECT MAX(last_modified) AS lm FROM snapshots WHERE house_id = ? AND kind = ?"
);
const insertSnapshot = db.prepare(
  "INSERT INTO snapshots (house_id, kind, last_modified, fetched_at, auction_count) VALUES (?, ?, ?, ?, ?)"
);
const insertPrice = db.prepare("INSERT INTO item_prices VALUES (?, ?, ?, ?, ?, ?, ?)");
const insertSale = db.prepare("INSERT INTO item_sales VALUES (?, ?, ?, ?, ?, ?)");
const selectLive = db.prepare(
  "SELECT auction_id, item_id, quantity, unit_price, time_left FROM live_auctions WHERE house_id = ? AND kind = ?"
);
const deleteLive = db.prepare("DELETE FROM live_auctions WHERE house_id = ? AND kind = ?");
const insertLive = db.prepare("INSERT INTO live_auctions VALUES (?, ?, ?, ?, ?, ?, ?)");

// Normalize raw API auctions: commodities have unit_price; main auctions have a stack buyout.
function normalize(auctions) {
  const out = [];
  for (const a of auctions) {
    if (!a.item?.id || a.id == null) continue;
    const qty = a.quantity ?? 1;
    const unit = a.unit_price ?? (a.buyout != null ? Math.round(a.buyout / qty) : null);
    out.push({ id: a.id, item: a.item.id, qty, unit, timeLeft: a.time_left ?? null });
  }
  return out;
}

function summarize(auctions) {
  const byItem = new Map(); // item_id -> [{ unit, qty }]
  for (const a of auctions) {
    if (a.unit == null) continue; // bid-only auctions have no price to report
    let list = byItem.get(a.item);
    if (!list) byItem.set(a.item, (list = []));
    list.push({ unit: a.unit, qty: a.qty });
  }
  const rows = [];
  for (const [itemId, list] of byItem) {
    list.sort((x, y) => x.unit - y.unit);
    let total = 0, sum = 0;
    for (const l of list) { total += l.qty; sum += l.unit * l.qty; }
    let seen = 0, median = list[0].unit;
    for (const l of list) { seen += l.qty; if (seen >= total / 2) { median = l.unit; break; } }
    rows.push([itemId, list[0].unit, median, Math.round(sum / total), total, list.length]);
  }
  return rows;
}

function estimateSales(prev, current, gapMs) {
  const now = new Map(current.map((a) => [a.id, a]));
  const byItem = new Map(); // item_id -> [soldQty, soldAuctions, soldValue, removedQty]
  const bump = (item, i, v) => {
    let r = byItem.get(item);
    if (!r) byItem.set(item, (r = [0, 0, 0, 0]));
    r[i] += v;
  };
  for (const p of prev) {
    const cur = now.get(p.auction_id);
    if (!cur) {
      bump(p.item_id, 3, p.quantity);
      const couldHaveExpired = gapMs >= (MIN_TIME_LEFT[p.time_left] ?? 0);
      if (!couldHaveExpired && p.unit_price != null) {
        bump(p.item_id, 0, p.quantity);
        bump(p.item_id, 1, 1);
        bump(p.item_id, 2, p.quantity * p.unit_price);
      }
    } else if (cur.qty < p.quantity && p.unit_price != null) {
      const sold = p.quantity - cur.qty; // partial commodity purchase
      bump(p.item_id, 0, sold);
      bump(p.item_id, 2, sold * p.unit_price);
      bump(p.item_id, 3, sold);
    }
  }
  return [...byItem].filter(([, r]) => r[3] > 0).map(([item, r]) => [item, ...r]);
}

async function collectOne(houseId, kind) {
  const prevLm = latestSnapshot.get(houseId, kind).lm;
  const path = `/data/wow/ruleset/${RULESET}/auctions/${houseId}${KINDS[kind]}`;
  const res = await apiGet(path, NS.dynamic, { ifModifiedSince: prevLm });
  const label = `house ${houseId} ${kind.padEnd(11)}`;
  if (res.status === 304 || (prevLm && res.lastModified === prevLm)) {
    console.log(`  ${label} unchanged`);
    return [];
  }
  if (!res.json) {
    console.log(`  ${label} HTTP ${res.status} — skipped`);
    return [];
  }
  const auctions = normalize(res.json.auctions ?? []); // missing field = empty house
  const rows = summarize(auctions);
  const lm = res.lastModified ?? Date.now();
  const prevLive = prevLm ? selectLive.all(houseId, kind) : [];
  const sales = prevLive.length ? estimateSales(prevLive, auctions, lm - prevLm) : [];

  transaction(db, () => {
    const { lastInsertRowid: snap } = insertSnapshot.run(houseId, kind, lm, Date.now(), auctions.length);
    for (const r of rows) insertPrice.run(snap, ...r);
    for (const s of sales) insertSale.run(snap, ...s);
    deleteLive.run(houseId, kind);
    for (const a of auctions) insertLive.run(houseId, kind, a.id, a.item, a.qty, a.unit, a.timeLeft);
  });
  const soldUnits = sales.reduce((n, s) => n + s[1], 0);
  console.log(
    `  ${label} ${auctions.length} auctions, ${rows.length} items` +
      (prevLive.length ? `, ~${soldUnits} units sold since last` : "") +
      ` (snapshot ${new Date(lm).toISOString()})`
  );
  return rows.map((r) => r[0]);
}

// ---------- item names ----------
// Items first seen in recipe data only have a name; let the collector fill in quality/class.
const knownItem = db.prepare("SELECT 1 FROM items WHERE item_id = ? AND source IS NOT 'recipe'");
const upsertItem = db.prepare(`
  INSERT INTO items (item_id, name, quality, item_class, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_id) DO UPDATE SET name=excluded.name, quality=excluded.quality,
    item_class=excluded.item_class, source=excluded.source, fetched_at=excluded.fetched_at
`);
const staleUnknown = db.prepare("SELECT item_id FROM items WHERE name IS NULL AND fetched_at < ?");

async function resolveItems(itemIds) {
  const retryBefore = Date.now() - 7 * 24 * 3600_000; // re-check unknown items weekly
  const todo = [
    ...new Set([
      ...itemIds.filter((id) => !knownItem.get(id)),
      ...staleUnknown.all(retryBefore).map((r) => r.item_id),
    ]),
  ];
  if (!todo.length) return;
  console.log(`  resolving ${todo.length} item names...`);
  let found = 0;
  await pool(todo, 8, async (id) => {
    const { json, namespace } = await staticGet(`/data/wow/item/${id}`);
    if (json) found++;
    upsertItem.run(id, json?.name ?? null, json?.quality?.type ?? null, json?.item_class?.name ?? null, namespace, Date.now());
  });
  console.log(`  item names: ${found}/${todo.length} resolved`);
}

// ---------- house names ----------
async function resolveHouses() {
  const known = db.prepare("SELECT COUNT(*) n FROM houses").get().n;
  if (known) return;
  const r = await apiGet(`/data/wow/ruleset/${RULESET}/auctions/`, NS.dynamic);
  const ins = db.prepare("INSERT OR REPLACE INTO houses VALUES (?, ?)");
  for (const h of r.json?.auctions ?? []) ins.run(h.id, h.name);
}

// ---------- main ----------
async function runOnce() {
  console.log(`[${new Date().toLocaleString()}] collecting houses ${HOUSES.join(", ")}`);
  const newItems = [];
  for (const h of HOUSES) {
    for (const kind of Object.keys(KINDS)) {
      try {
        newItems.push(...(await collectOne(h, kind)));
      } catch (e) {
        console.error(`  house ${h} ${kind} failed: ${e.message}`);
      }
    }
  }
  try {
    await resolveHouses();
    await resolveItems([...new Set(newItems)]);
  } catch (e) {
    console.error(`  item resolution failed: ${e.message}`);
  }
}

await runOnce();
if (process.argv.includes("--loop")) {
  console.log(`Polling every ${POLL_MINUTES} min (Ctrl+C to stop)`);
  for (;;) {
    await sleep(POLL_MINUTES * 60_000);
    await runOnce();
  }
}
