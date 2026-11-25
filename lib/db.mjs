// Database schema shared by collector, server and sync scripts.
import { DatabaseSync } from "node:sqlite";

export function openDb(path = process.env.DB_PATH || "auctions.db") {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;

    -- ---------- auction data (collector) ----------
    CREATE TABLE IF NOT EXISTS snapshots (
      id            INTEGER PRIMARY KEY,
      house_id      INTEGER NOT NULL,
      kind          TEXT    NOT NULL,          -- 'main' | 'commodities'
      last_modified INTEGER NOT NULL,          -- unix ms, from Blizzard's Last-Modified header
      fetched_at    INTEGER NOT NULL,          -- unix ms
      auction_count INTEGER NOT NULL,
      UNIQUE (house_id, kind, last_modified)
    );
    CREATE TABLE IF NOT EXISTS item_prices (
      snapshot_id    INTEGER NOT NULL REFERENCES snapshots(id),
      item_id        INTEGER NOT NULL,
      min_price      INTEGER NOT NULL,         -- copper per unit
      median_price   INTEGER NOT NULL,         -- quantity-weighted, copper per unit
      mean_price     INTEGER NOT NULL,         -- quantity-weighted, copper per unit
      total_quantity INTEGER NOT NULL,
      num_auctions   INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_prices_item ON item_prices(item_id);

    -- Auctions in the most recent snapshot of each house/kind, so the next snapshot can be diffed.
    CREATE TABLE IF NOT EXISTS live_auctions (
      house_id   INTEGER NOT NULL,
      kind       TEXT    NOT NULL,
      auction_id INTEGER NOT NULL,
      item_id    INTEGER NOT NULL,
      quantity   INTEGER NOT NULL,
      unit_price INTEGER,                      -- NULL for bid-only auctions
      time_left  TEXT,
      PRIMARY KEY (house_id, kind, auction_id)
    ) WITHOUT ROWID;

    -- Estimated sales between the previous snapshot and this one (see collector.mjs).
    CREATE TABLE IF NOT EXISTS item_sales (
      snapshot_id      INTEGER NOT NULL REFERENCES snapshots(id),
      item_id          INTEGER NOT NULL,
      sold_quantity    INTEGER NOT NULL,       -- units that vanished too early to have expired, or partial buys
      sold_auctions    INTEGER NOT NULL,
      sold_value       INTEGER NOT NULL,       -- copper
      removed_quantity INTEGER NOT NULL,       -- every unit that left the AH (sold + expired + cancelled)
      PRIMARY KEY (snapshot_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_sales_item ON item_sales(item_id);

    CREATE TABLE IF NOT EXISTS items (
      item_id    INTEGER PRIMARY KEY,
      name       TEXT,                         -- NULL = not found in any namespace yet
      quality    TEXT,
      item_class TEXT,
      source     TEXT,                         -- which namespace resolved it
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS houses (
      house_id INTEGER PRIMARY KEY,
      name     TEXT
    );

    -- ---------- professions (sync-professions.mjs) ----------
    CREATE TABLE IF NOT EXISTS professions (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT,                        -- 'PRIMARY' | 'SECONDARY'
      description TEXT,
      icon        TEXT,
      min_skill   INTEGER,
      max_skill   INTEGER,
      synced_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS recipes (
      id              INTEGER PRIMARY KEY,
      profession_id   INTEGER NOT NULL,
      skill_tier      TEXT,
      category        TEXT,
      sort_order      INTEGER,
      name            TEXT NOT NULL,
      description     TEXT,
      icon            TEXT,
      crafted_item_id INTEGER,
      crafted_name    TEXT,
      crafted_qty     REAL
    );
    CREATE INDEX IF NOT EXISTS idx_recipes_prof ON recipes(profession_id);
    CREATE INDEX IF NOT EXISTS idx_recipes_crafted ON recipes(crafted_item_id);
    CREATE TABLE IF NOT EXISTS recipe_reagents (
      recipe_id INTEGER NOT NULL,
      item_id   INTEGER NOT NULL,
      name      TEXT,
      quantity  INTEGER NOT NULL,
      PRIMARY KEY (recipe_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reagents_item ON recipe_reagents(item_id);

    -- ---------- characters (server) ----------
    CREATE TABLE IF NOT EXISTS characters (
      realm      TEXT NOT NULL,                -- realm slug
      name       TEXT NOT NULL,                -- lowercase
      data       TEXT,                         -- JSON: { summary, equipment, professions, media }
      error      TEXT,
      fetched_at INTEGER,
      source     TEXT,                         -- 'manual' | 'battlenet'
      PRIMARY KEY (realm, name)
    );
  `);
  // Columns added after the first version of the schema.
  addColumn(db, "items", "icon", "TEXT");          // '' = looked up, none found
  addColumn(db, "items", "details", "TEXT");       // JSON from /data/wow/item/{id}
  addColumn(db, "items", "details_at", "INTEGER");
  return db;
}

function addColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function transaction(db, fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
