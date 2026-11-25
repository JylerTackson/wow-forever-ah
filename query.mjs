// Look up an item's latest price per house, plus recent history.
//   node query.mjs "Ironfeather"            -> all collected houses
//   node query.mjs "Ironfeather" 110        -> one house, with history
import { DatabaseSync } from "node:sqlite";

const [search, house] = process.argv.slice(2);
if (!search) {
  console.error('Usage: node query.mjs "<item name or id>" [houseId]');
  process.exit(1);
}
const db = new DatabaseSync(process.env.DB_PATH || "auctions.db", { readOnly: true });
const g = (c) => {
  const gold = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, cp = c % 100;
  return [gold && `${gold}g`, (gold || s) && `${s}s`, `${cp}c`].filter(Boolean).join(" ");
};

const items = /^\d+$/.test(search)
  ? db.prepare("SELECT item_id, name FROM items WHERE item_id = ?").all(Number(search))
  : db.prepare("SELECT item_id, name FROM items WHERE name LIKE ? ORDER BY length(name) LIMIT 5").all(`%${search}%`);
if (!items.length) {
  console.log("No matching item (names are resolved after the first collection).");
  process.exit(0);
}

for (const { item_id, name } of items) {
  console.log(`\n${name} (${item_id})`);
  const latest = db.prepare(`
    SELECT s.house_id, s.kind, s.last_modified, p.*
    FROM item_prices p JOIN snapshots s ON s.id = p.snapshot_id
    WHERE p.item_id = ? AND s.last_modified = (
      SELECT MAX(last_modified) FROM snapshots WHERE house_id = s.house_id AND kind = s.kind)
    ${house ? "AND s.house_id = ?" : ""}
    ORDER BY s.house_id`).all(...[item_id, house && Number(house)].filter(Boolean));
  if (!latest.length) console.log("  not currently listed");
  for (const r of latest)
    console.log(`  house ${r.house_id} ${r.kind.padEnd(11)} min ${g(r.min_price).padEnd(12)} median ${g(r.median_price).padEnd(12)} qty ${r.total_quantity}  (${r.num_auctions} auctions, ${new Date(r.last_modified).toLocaleString()})`);

  if (house) {
    const hist = db.prepare(`
      SELECT s.last_modified, p.min_price, p.median_price, p.total_quantity
      FROM item_prices p JOIN snapshots s ON s.id = p.snapshot_id
      WHERE p.item_id = ? AND s.house_id = ? ORDER BY s.last_modified DESC LIMIT 24`).all(item_id, Number(house));
    if (hist.length > 1) {
      console.log("  history (newest first):");
      for (const h of hist)
        console.log(`    ${new Date(h.last_modified).toLocaleString().padEnd(24)} min ${g(h.min_price).padEnd(12)} median ${g(h.median_price).padEnd(12)} qty ${h.total_quantity}`);
    }
  }
}
