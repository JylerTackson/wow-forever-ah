// Web UI + JSON API over auctions.db.
//   node --env-file=.env server.mjs        -> http://localhost:3000
// Run the collector alongside it (collector.mjs --loop) to keep prices and sales history growing.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import {
  API, HOUSES, NS, REGION, apiGet, authorizeUrl, exchangeCode, hrefGet, iconFor, pool, requireCredentials, staticGet,
} from "./lib/blizzard.mjs";
import { openDb } from "./lib/db.mjs";
import { syncProfessions } from "./lib/professions.mjs";

requireCredentials();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const PUBLIC = resolve("public");
const AH_CUT = 0.05; // auction house fee taken from the seller
const DAY = 24 * 3600_000;

const db = openDb();
await mkdir("out", { recursive: true });
// Characters saved before realm-less (Forever) support used an empty realm key, which breaks URLs.
db.exec("UPDATE OR REPLACE characters SET realm = '_' WHERE realm = ''");

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const ids = (rows) => rows.map((r) => Number(r.id)).join(",") || "NULL"; // integers only -> safe to inline
const num = (v, d) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

function limiter(n) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active >= n) await new Promise((r) => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
}
const blizzardSlot = limiter(6);

// Latest snapshot per kind for a house, and the snapshot closest to `ms` before the latest.
function latestSnapshots(house) {
  return db.prepare(`
    SELECT id, kind, last_modified FROM snapshots s WHERE house_id = ?
      AND last_modified = (SELECT MAX(last_modified) FROM snapshots WHERE house_id = s.house_id AND kind = s.kind)`
  ).all(house);
}
function snapshotsBefore(house, latest, ms) {
  // For each kind: newest snapshot at least `ms` older than the latest; else the oldest one that isn't the latest.
  const out = [];
  for (const l of latest) {
    const r =
      db.prepare("SELECT id, last_modified FROM snapshots WHERE house_id=? AND kind=? AND last_modified <= ? ORDER BY last_modified DESC LIMIT 1")
        .get(house, l.kind, l.last_modified - ms) ??
      db.prepare("SELECT id, last_modified FROM snapshots WHERE house_id=? AND kind=? AND id <> ? ORDER BY last_modified LIMIT 1")
        .get(house, l.kind, l.id);
    if (r) out.push(r);
  }
  return out;
}
function snapshotsSince(house, ms) {
  return db.prepare("SELECT id FROM snapshots WHERE house_id = ? AND last_modified > ?").all(house, ms);
}
function housesWithData() {
  const rows = db.prepare(`
    SELECT s.house_id AS id, h.name, COUNT(*) AS snapshots, MAX(s.last_modified) AS last_modified, MIN(s.last_modified) AS first
    FROM snapshots s LEFT JOIN houses h USING (house_id) GROUP BY s.house_id`).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const h of HOUSES) if (!byId.has(h)) byId.set(h, { id: h, name: null, snapshots: 0 });
  return [...byId.values()].map((h) => ({
    ...h,
    label: `${(h.name || "Auction House").replace(/ Auction House$/, "")} (${h.id})`,
  }));
}
function pickHouse(q) {
  const h = num(q.get("house"), null);
  if (h != null) return h;
  return housesWithData()[0]?.id ?? HOUSES[0];
}

// item_id -> { min, median, qty, auctions } for a house's latest snapshot
function priceMap(house) {
  const latest = latestSnapshots(house);
  const rows = db.prepare(`SELECT item_id, min_price, median_price, total_quantity, num_auctions FROM item_prices
    WHERE snapshot_id IN (${ids(latest)})`).all();
  return new Map(rows.map((r) => [r.item_id, { min: r.min_price, median: r.median_price, qty: r.total_quantity, auctions: r.num_auctions }]));
}
function soldMap(house, sinceMs) {
  const rows = db.prepare(`SELECT item_id, SUM(sold_quantity) AS sold FROM item_sales
    WHERE snapshot_id IN (${ids(snapshotsSince(house, sinceMs))}) GROUP BY item_id`).all();
  return new Map(rows.map((r) => [r.item_id, r.sold]));
}

// ---------------------------------------------------------------- item metadata (lazy)
const inflight = new Map();
function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function ensureItemIcon(id) {
  const row = db.prepare("SELECT icon FROM items WHERE item_id = ?").get(id);
  if (row?.icon != null) return row.icon;
  return once(`icon:${id}`, () =>
    blizzardSlot(async () => {
      const icon = (await iconFor("item", id).catch(() => null)) ?? "";
      db.prepare(`INSERT INTO items (item_id, icon, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET icon = excluded.icon`).run(id, icon, Date.now());
      return icon;
    })
  );
}

async function ensureItemDetails(id) {
  const row = db.prepare("SELECT details, details_at FROM items WHERE item_id = ?").get(id);
  if (row?.details_at && Date.now() - row.details_at < 30 * DAY) return row.details ? JSON.parse(row.details) : null;
  return once(`details:${id}`, () =>
    blizzardSlot(async () => {
      const { json, namespace } = await staticGet(`/data/wow/item/${id}`);
      const d = json && {
        level: json.level, required_level: json.required_level,
        item_class: json.item_class?.name, item_subclass: json.item_subclass?.name,
        inventory_type: json.inventory_type?.name, binding: json.preview_item?.binding?.name ?? null,
        sell_price: json.sell_price, purchase_price: json.purchase_price, max_stack: json.max_count,
        is_stackable: json.is_stackable, namespace,
        tooltip: tooltipLines(json.preview_item),
      };
      db.prepare(`INSERT INTO items (item_id, name, quality, item_class, source, fetched_at, details, details_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET name = COALESCE(excluded.name, items.name),
          quality = COALESCE(excluded.quality, items.quality), item_class = COALESCE(excluded.item_class, items.item_class),
          details = excluded.details, details_at = excluded.details_at`)
        .run(id, json?.name ?? null, json?.quality?.type ?? null, json?.item_class?.name ?? null, namespace,
          Date.now(), d ? JSON.stringify(d) : null, Date.now());
      return d;
    })
  );
}

// Flatten Blizzard's preview_item into tooltip-ish lines.
function tooltipLines(p) {
  if (!p) return [];
  const lines = [];
  const add = (text, cls) => text && lines.push({ text, cls });
  add(p.binding?.name);
  add(p.unique_equipped);
  if (p.inventory_type?.name && p.is_equippable !== false) add([p.inventory_type.name, p.item_subclass?.name].filter(Boolean).join(" · "));
  add(p.armor?.display?.display_string);
  add(p.weapon?.damage?.display_string);
  add(p.weapon?.attack_speed?.display_string);
  add(p.weapon?.dps?.display_string);
  for (const s of p.stats ?? []) add(s.display?.display_string, s.is_negated ? "neg" : s.display?.color ? "stat-green" : "");
  for (const s of p.spells ?? []) add(s.description, "spell");
  add(p.requirements?.level?.display_string);
  add(p.requirements?.skill?.display_string);
  add(p.set?.display_string, "set");
  add(p.description, "flavor");
  return lines;
}

// ---------------------------------------------------------------- characters
// Forever characters have no realm (the account listing returns an empty slug), so they're keyed under NO_REALM
// and fetched through the profile links Blizzard includes in the account listing.
const NO_REALM = "_";
const userAuth = { token: null, expires: 0 }; // most recent Battle.net login, kept in memory only
const userToken = () => (userAuth.token && Date.now() < userAuth.expires - 60_000 ? userAuth.token : null);
const debugLog = {}; // "realm/name" -> attempts, written to out/character-debug.json

function withSuffix(href, suffix) {
  const u = new URL(href);
  u.pathname = u.pathname.replace(/\/$/, "") + suffix;
  return u.toString();
}

async function fetchCharacter(realm, name, stub) {
  const user = userToken();
  const candidates = [];
  if (stub?.character?.href) {
    candidates.push(["account link", stub.character.href, undefined]);
    if (user) candidates.push(["account link + user token", stub.character.href, user]);
  }
  if (realm && realm !== NO_REALM) {
    const path = `${API}/profile/wow/character/${encodeURIComponent(realm)}/${encodeURIComponent(name.toLowerCase())}?namespace=${NS.profile}`;
    candidates.push(["realm/name path", path, undefined]);
    if (user) candidates.push(["realm/name path + user token", path, user]);
  }
  if (stub?.protected_character?.href && user) candidates.push(["protected character", stub.protected_character.href, user]);

  const attempts = [];
  let summary = null, summaryHref = null, bearer;
  for (const [label, href, b] of candidates) {
    const r = await hrefGet(href, { bearer: b });
    attempts.push({ label, href: href.replace(/\?.*/, ""), status: r.status, keys: r.json ? Object.keys(r.json) : null });
    if (r.json) { summary = r.json; summaryHref = href; bearer = b; break; }
  }
  // A protected-character payload wraps the public profile link; follow it once.
  if (summary && !summary.name && summary.character?.href) {
    const r = await hrefGet(summary.character.href, { bearer });
    attempts.push({ label: "protected -> character link", href: summary.character.href.replace(/\?.*/, ""), status: r.status, keys: r.json ? Object.keys(r.json) : null });
    if (r.json) { summary = { ...r.json, protected: summary }; summaryHref = summary.character?.href ?? r.json._links?.self?.href ?? summaryHref; }
  }

  let parts = {};
  if (summary) {
    const base = summary._links?.self?.href ?? summaryHref;
    const sub = async (key, suffix) => {
      const href = summary[key]?.href ?? withSuffix(base, suffix);
      const r = await hrefGet(href, { bearer });
      attempts.push({ label: key, href: href.replace(/\?.*/, ""), status: r.status });
      return r.json;
    };
    const [equipment, professions, media] = await Promise.all([
      sub("equipment", "/equipment"), sub("professions", "/professions"), sub("media", "/character-media"),
    ]);
    parts = { equipment, professions, media };
  }
  debugLog[`${realm}/${name}`] = { at: new Date().toISOString(), hadUserToken: !!user, stubLinks: { character: stub?.character?.href, protected: stub?.protected_character?.href }, attempts };
  writeFile("out/character-debug.json", JSON.stringify(debugLog, null, 2)).catch(() => {});

  if (!summary) {
    const last = attempts.at(-1);
    throw new HttpError(last?.status === 404 ? 404 : 502,
      !candidates.length
        ? `No way to look up "${name}": it has no realm. Log in with Battle.net to import it.`
        : !user && stub?.protected_character
          ? `Blizzard didn't return a public profile for ${name}. Log in with Battle.net again to load it with your account.`
          : `Blizzard didn't return a profile for ${name} (HTTP ${attempts.map((a) => a.status).join(", ")}). Characters only appear after logging in to the game recently.`);
  }
  return { summary, ...parts };
}

async function saveCharacter(realm, name, source, stub) {
  realm = realm.toLowerCase().trim() || NO_REALM;
  name = name.toLowerCase().trim();
  try {
    const data = await fetchCharacter(realm, name, stub);
    if (stub) data.stub = stub;
    db.prepare(`INSERT INTO characters (realm, name, data, error, fetched_at, source) VALUES (?, ?, ?, NULL, ?, ?)
      ON CONFLICT(realm, name) DO UPDATE SET data = excluded.data, error = NULL, fetched_at = excluded.fetched_at`)
      .run(realm, name, JSON.stringify(data), Date.now(), source);
    return data;
  } catch (e) {
    if (stub) {
      // Keep account-listed characters even if their full profile isn't available.
      db.prepare(`INSERT INTO characters (realm, name, data, error, fetched_at, source) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(realm, name) DO UPDATE SET error = excluded.error, fetched_at = excluded.fetched_at`)
        .run(realm, name, JSON.stringify({ stub }), e.message, Date.now(), source);
    }
    throw e;
  }
}

function characterCard(row) {
  const d = row.data ? JSON.parse(row.data) : {};
  const s = d.summary ?? {};
  const st = d.stub ?? {};
  const avatar = d.media?.assets?.find((a) => a.key === "avatar")?.value ?? d.media?.avatar_url ?? null;
  return {
    realm: row.realm, name: s.name ?? st.name ?? row.name, source: row.source, error: row.error, fetched_at: row.fetched_at,
    level: s.level ?? st.level ?? null,
    class: s.character_class?.name ?? st.playable_class?.name ?? null,
    race: s.race?.name ?? st.playable_race?.name ?? null,
    faction: s.faction?.type ?? st.faction?.type ?? null,
    realm_name: s.realm?.name ?? st.realm?.name ?? (row.realm === NO_REALM ? "" : row.realm),
    guild: s.guild?.name ?? null,
    item_level: s.equipped_item_level ?? s.average_item_level ?? null,
    avatar,
    professions: professionSummary(d.professions).map((p) => ({ name: p.name, skill: p.skill, max: p.max })),
  };
}

// Normalize the /professions payload (retail-style tiers or classic-style flat) to a common shape.
function professionSummary(p) {
  if (!p) return [];
  const out = [];
  for (const group of ["primaries", "secondaries"]) {
    for (const e of p[group] ?? []) {
      const tiers = e.tiers ?? [];
      const skill = e.skill_points ?? tiers.reduce((m, t) => Math.max(m, t.skill_points ?? 0), 0);
      const max = e.max_skill_points ?? tiers.reduce((m, t) => Math.max(m, t.max_skill_points ?? 0), 0);
      const known = [...(e.known_recipes ?? []), ...tiers.flatMap((t) => t.known_recipes ?? [])];
      out.push({ id: e.profession?.id, name: e.profession?.name, type: group === "primaries" ? "PRIMARY" : "SECONDARY", skill, max, known: known.map((r) => ({ id: r.id, name: r.name })) });
    }
  }
  return out;
}

function knownRecipeIds(realm, name) {
  const row = db.prepare("SELECT data FROM characters WHERE realm = ? AND name = ?").get(realm, name);
  if (!row?.data) return new Set();
  return new Set(professionSummary(JSON.parse(row.data).professions).flatMap((p) => p.known.map((r) => r.id)));
}

// ---------------------------------------------------------------- API routes
const oauthStates = new Map(); // state -> expires
let professionSync = { running: false, log: [], error: null };

const routes = [
  ["GET", /^\/api\/meta$/, () => {
    const classes = db.prepare("SELECT item_class AS name, COUNT(*) n FROM items WHERE item_class IS NOT NULL GROUP BY 1 ORDER BY 2 DESC").all();
    return {
      region: REGION,
      houses: housesWithData(),
      classes: classes.map((c) => c.name),
      professions: db.prepare("SELECT COUNT(*) n FROM recipes").get().n,
      salesSnapshots: db.prepare("SELECT COUNT(DISTINCT snapshot_id) n FROM item_sales").get().n,
      redirectUri: REDIRECT_URI,
    };
  }],

  ["GET", /^\/api\/search$/, (q) => {
    const term = (q.get("q") || "").trim();
    if (!term) return [];
    const limit = Math.min(num(q.get("limit"), 12), 50);
    if (/^\d+$/.test(term))
      return db.prepare("SELECT item_id AS id, name, quality, item_class FROM items WHERE item_id = ?").all(Number(term));
    return db.prepare(`SELECT item_id AS id, name, quality, item_class FROM items WHERE name LIKE ?
      ORDER BY (name LIKE ?) DESC, length(name) LIMIT ?`).all(`%${term}%`, `${term}%`, limit);
  }],

  ["GET", /^\/api\/market$/, (q) => {
    const house = pickHouse(q);
    const latest = latestSnapshots(house);
    if (!latest.length) return { house, rows: [], total: 0 };
    const latestLm = Math.max(...latest.map((l) => l.last_modified));
    const old = snapshotsBefore(house, latest, DAY);
    const recent = snapshotsSince(house, latestLm - DAY);

    const where = [`p.snapshot_id IN (${ids(latest)})`];
    const args = [];
    const term = (q.get("q") || "").trim();
    if (term) {
      if (/^\d+$/.test(term)) { where.push("p.item_id = ?"); args.push(Number(term)); }
      else { where.push("i.name LIKE ?"); args.push(`%${term}%`); }
    }
    if (q.get("class")) { where.push("i.item_class = ?"); args.push(q.get("class")); }
    if (q.get("quality")) { where.push("i.quality = ?"); args.push(q.get("quality")); }

    const SORTS = {
      name: "i.name", min: "p.min_price", median: "p.median_price", qty: "p.total_quantity", auctions: "p.num_auctions",
      value: "p.median_price * p.total_quantity", sold: "sold24", sold_value: "sold_value24",
      change: "CASE WHEN o.median_price > 0 THEN (p.median_price - o.median_price) * 1.0 / o.median_price END",
    };
    const sort = SORTS[q.get("sort")] ?? SORTS.value;
    const dir = q.get("dir") === "asc" ? "ASC" : "DESC";
    const limit = Math.min(num(q.get("limit"), 100), 500);
    const offset = num(q.get("offset"), 0);
    const from = `
      FROM item_prices p
      LEFT JOIN items i ON i.item_id = p.item_id
      LEFT JOIN item_prices o ON o.item_id = p.item_id AND o.snapshot_id IN (${ids(old)})
      LEFT JOIN (SELECT item_id, SUM(sold_quantity) AS sold, SUM(sold_value) AS sold_value FROM item_sales
                 WHERE snapshot_id IN (${ids(recent)}) GROUP BY item_id) sl ON sl.item_id = p.item_id
      WHERE ${where.join(" AND ")}`;
    const rows = db.prepare(`
      SELECT p.item_id AS id, i.name, i.quality, i.item_class, i.icon, p.min_price, p.median_price, p.mean_price,
        p.total_quantity, p.num_auctions, o.median_price AS prev_median, o.min_price AS prev_min,
        COALESCE(sl.sold, 0) AS sold24, COALESCE(sl.sold_value, 0) AS sold_value24
      ${from} ORDER BY ${sort} ${dir} NULLS LAST, p.item_id LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) n ${from}`).get(...args).n;
    const prevLm = old.length ? Math.max(...old.map((o) => o.last_modified)) : null;
    return { house, rows, total, last_modified: latestLm, compare_to: prevLm, has_sales: recent.length > 0 && db.prepare(`SELECT 1 FROM item_sales WHERE snapshot_id IN (${ids(recent)}) LIMIT 1`).get() != null };
  }],

  ["GET", /^\/api\/item\/(\d+)$/, async (q, [, idStr]) => {
    const id = Number(idStr);
    const details = await ensureItemDetails(id).catch(() => null);
    ensureItemIcon(id).catch(() => {});
    const item = db.prepare("SELECT item_id AS id, name, quality, item_class, icon FROM items WHERE item_id = ?").get(id);
    if (!item) throw new HttpError(404, `Unknown item ${id}`);

    const houses = housesWithData().map((h) => {
      const latest = latestSnapshots(h.id);
      const cur = db.prepare(`SELECT p.*, s.last_modified, s.kind FROM item_prices p JOIN snapshots s ON s.id = p.snapshot_id
        WHERE p.item_id = ? AND p.snapshot_id IN (${ids(latest)})`).get(id);
      const latestLm = latest.length ? Math.max(...latest.map((l) => l.last_modified)) : Date.now();
      const old = snapshotsBefore(h.id, latest, DAY);
      const prev = cur && db.prepare(`SELECT median_price, min_price FROM item_prices WHERE item_id = ? AND snapshot_id IN (${ids(old)})`).get(id);
      const sales = (ms) => db.prepare(`SELECT COALESCE(SUM(sold_quantity),0) q, COALESCE(SUM(sold_value),0) v FROM item_sales
        WHERE item_id = ? AND snapshot_id IN (${ids(snapshotsSince(h.id, latestLm - ms))})`).get(id);
      const lastSeen = cur ? null : db.prepare(`SELECT MAX(s.last_modified) t FROM item_prices p JOIN snapshots s ON s.id = p.snapshot_id
        WHERE p.item_id = ? AND s.house_id = ?`).get(id, h.id).t;
      return {
        id: h.id, label: h.label, listed: !!cur, last_seen: lastSeen,
        min_price: cur?.min_price ?? null, median_price: cur?.median_price ?? null, mean_price: cur?.mean_price ?? null,
        total_quantity: cur?.total_quantity ?? 0, num_auctions: cur?.num_auctions ?? 0,
        prev_median: prev?.median_price ?? null, prev_min: prev?.min_price ?? null,
        sold24: sales(DAY), sold7d: sales(7 * DAY), last_modified: cur?.last_modified ?? null,
      };
    });

    const recipeRows = (sql, arg) => db.prepare(`SELECT r.id, r.name, r.icon, r.category, r.crafted_item_id, r.crafted_name, r.crafted_qty,
        p.name AS profession, p.id AS profession_id FROM recipes r JOIN professions p ON p.id = r.profession_id ${sql}`).all(arg);
    const craftedBy = recipeRows("WHERE r.crafted_item_id = ?", id);
    const usedIn = recipeRows("WHERE r.id IN (SELECT recipe_id FROM recipe_reagents WHERE item_id = ?) ORDER BY p.name, r.sort_order", id);
    const reagents = db.prepare("SELECT recipe_id, item_id AS id, name, quantity FROM recipe_reagents WHERE recipe_id = ?");
    for (const r of craftedBy) r.reagents = reagents.all(r.id);
    for (const r of usedIn) r.quantity = db.prepare("SELECT quantity FROM recipe_reagents WHERE recipe_id = ? AND item_id = ?").get(r.id, id).quantity;
    return { ...item, details, houses, craftedBy, usedIn };
  }],

  ["GET", /^\/api\/item\/(\d+)\/history$/, (q, [, idStr]) => {
    const id = Number(idStr);
    const house = pickHouse(q);
    const days = num(q.get("days"), 7);
    const kindRow = db.prepare(`SELECT s.kind FROM item_prices p JOIN snapshots s ON s.id = p.snapshot_id
      WHERE p.item_id = ? AND s.house_id = ? ORDER BY s.last_modified DESC LIMIT 1`).get(id, house);
    if (!kindRow) return { house, points: [] };
    const since = days > 0 ? Date.now() - days * DAY : 0;
    // Every snapshot of the house is a point; a NULL price means the item wasn't listed then.
    const points = db.prepare(`
      SELECT s.last_modified AS t, p.min_price, p.median_price, p.mean_price,
        COALESCE(p.total_quantity, 0) AS qty, COALESCE(p.num_auctions, 0) AS auctions,
        sa.sold_quantity AS sold, sa.sold_value, sa.removed_quantity AS removed
      FROM snapshots s
      LEFT JOIN item_prices p ON p.snapshot_id = s.id AND p.item_id = ?
      LEFT JOIN item_sales sa ON sa.snapshot_id = s.id AND sa.item_id = ?
      WHERE s.house_id = ? AND s.kind = ? AND s.last_modified >= ?
      ORDER BY s.last_modified`).all(id, id, house, kindRow.kind, since);
    return { house, kind: kindRow.kind, points };
  }],

  ["GET", /^\/api\/icon\/item\/(\d+)$/, async (q, [, id]) => {
    const icon = await ensureItemIcon(Number(id));
    return { redirect: icon || "/placeholder.svg", cache: icon ? 86400 : 600 };
  }],

  // ---- professions
  ["GET", /^\/api\/professions$/, () => ({
    sync: professionSync,
    professions: db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM recipes r WHERE r.profession_id = p.id) AS recipes
      FROM professions p ORDER BY p.type, p.name`).all(),
  })],

  ["POST", /^\/api\/professions\/sync$/, () => {
    if (!professionSync.running) {
      professionSync = { running: true, log: [], error: null };
      syncProfessions(db, (line) => professionSync.log.push(line))
        .catch((e) => (professionSync.error = e.message))
        .finally(() => (professionSync.running = false));
    }
    return professionSync;
  }],

  ["GET", /^\/api\/recipes$/, (q) => {
    const house = pickHouse(q);
    const where = [];
    const args = [];
    if (q.get("profession")) { where.push("r.profession_id = ?"); args.push(Number(q.get("profession"))); }
    if (q.get("category")) { where.push("r.category = ?"); args.push(q.get("category")); }
    const term = (q.get("q") || "").trim();
    if (term) {
      where.push(`(r.name LIKE ? OR r.crafted_name LIKE ? OR EXISTS (SELECT 1 FROM recipe_reagents x WHERE x.recipe_id = r.id AND x.name LIKE ?))`);
      args.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }
    let recipes = db.prepare(`SELECT r.*, p.name AS profession FROM recipes r JOIN professions p ON p.id = r.profession_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY p.name, r.sort_order`).all(...args);

    const known = q.get("known"); // "realm/name"
    if (known) {
      const [realm, name] = known.split("/");
      const set = knownRecipeIds(realm, name);
      recipes = recipes.filter((r) => set.has(r.id));
    }

    const prices = priceMap(house);
    const sold = soldMap(house, Date.now() - DAY);
    const basis = q.get("price") === "median" ? "median" : "min";
    const items = new Map(db.prepare("SELECT item_id, quality FROM items").all().map((i) => [i.item_id, i.quality]));
    const reagentsOf = db.prepare("SELECT item_id AS id, name, quantity FROM recipe_reagents WHERE recipe_id = ?");

    let out = recipes.map((r) => {
      const reagents = reagentsOf.all(r.id).map((g) => {
        const p = prices.get(g.id);
        const unit = p ? p[basis] : null;
        return { ...g, quality: items.get(g.id) ?? null, unit, total: unit != null ? unit * g.quantity : null, listed: p?.qty ?? 0 };
      });
      const missing = reagents.filter((g) => g.unit == null).length;
      const cost = reagents.reduce((s, g) => s + (g.total ?? 0), 0);
      const cp = r.crafted_item_id ? prices.get(r.crafted_item_id) : null;
      const unitSell = cp ? cp[basis] : null;
      const value = unitSell != null ? Math.round(unitSell * (r.crafted_qty || 1)) : null;
      const profit = value != null && !missing ? Math.round(value * (1 - AH_CUT) - cost) : null;
      return {
        id: r.id, name: r.name, icon: r.icon, profession: r.profession, profession_id: r.profession_id, category: r.category,
        crafted_item_id: r.crafted_item_id, crafted_name: r.crafted_name, crafted_qty: r.crafted_qty,
        crafted_quality: items.get(r.crafted_item_id) ?? null,
        reagents, cost, missing, value, profit,
        margin: profit != null && cost > 0 ? profit / cost : null,
        listed: cp?.qty ?? 0, sold24: sold.get(r.crafted_item_id) ?? 0,
      };
    });
    if (q.get("profitable") === "1") out = out.filter((r) => r.profit > 0);
    const SORTS = {
      profit: (r) => r.profit, margin: (r) => r.margin, cost: (r) => (r.missing ? null : r.cost), value: (r) => r.value,
      sold: (r) => r.sold24, name: null,
    };
    const key = SORTS[q.get("sort")];
    if (key) {
      const dir = q.get("dir") === "asc" ? 1 : -1;
      out.sort((a, b) => {
        const x = key(a), y = key(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x - y) * dir;
      });
    } else if (q.get("sort") === "name") out.sort((a, b) => a.name.localeCompare(b.name) * (q.get("dir") === "desc" ? -1 : 1));
    const categories = q.get("profession")
      ? db.prepare("SELECT category, COUNT(*) n, MIN(sort_order) o FROM recipes WHERE profession_id = ? GROUP BY 1 ORDER BY o").all(Number(q.get("profession")))
      : [];
    return { house, basis, total: out.length, recipes: out.slice(0, num(q.get("limit"), 400)), categories };
  }],

  // ---- characters
  ["GET", /^\/api\/characters$/, () =>
    db.prepare("SELECT * FROM characters ORDER BY source, name").all().map(characterCard)],

  ["POST", /^\/api\/characters$/, async (q, m, body) => {
    const realm = String(body?.realm || "").trim().toLowerCase().replace(/[\s']+/g, "-");
    const name = String(body?.name || "").trim();
    if (!realm || !name) throw new HttpError(400, "Realm and character name are required");
    await saveCharacter(realm, name, "manual");
    return characterCard(db.prepare("SELECT * FROM characters WHERE realm = ? AND name = ?").get(realm, name.toLowerCase()));
  }],

  ["GET", /^\/api\/characters\/([^/]+)\/([^/]+)$/, async (q, [, realm, name]) => {
    realm = decodeURIComponent(realm); name = decodeURIComponent(name).toLowerCase();
    let row = db.prepare("SELECT * FROM characters WHERE realm = ? AND name = ?").get(realm, name);
    if (!row) throw new HttpError(404, "Character not saved");
    if (q.get("refresh") === "1") {
      await saveCharacter(realm, name, row.source, row.data ? JSON.parse(row.data).stub : undefined);
      row = db.prepare("SELECT * FROM characters WHERE realm = ? AND name = ?").get(realm, name);
    }
    const d = row.data ? JSON.parse(row.data) : {};
    return {
      card: characterCard(row),
      equipment: (d.equipment?.equipped_items ?? []).map((e) => ({
        slot: e.slot?.name ?? e.slot?.type, slot_type: e.slot?.type, id: e.item?.id, name: e.name, quality: e.quality?.type,
        level: e.level?.value ?? null, binding: e.binding?.name ?? null,
        tooltip: tooltipLines(e),
        enchantments: (e.enchantments ?? []).map((x) => x.display_string).filter(Boolean),
      })),
      professions: professionSummary(d.professions),
      raw_available: { summary: !!d.summary, equipment: !!d.equipment, professions: !!d.professions, media: !!d.media },
    };
  }],

  ["DELETE", /^\/api\/characters\/([^/]+)\/([^/]+)$/, (q, [, realm, name]) => {
    db.prepare("DELETE FROM characters WHERE realm = ? AND name = ?").run(decodeURIComponent(realm), decodeURIComponent(name).toLowerCase());
    return { ok: true };
  }],

  // ---- Battle.net login (imports every character on the account)
  ["GET", /^\/auth\/login$/, () => {
    const state = randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now() + 10 * 60_000);
    return { redirect: authorizeUrl(REDIRECT_URI, state) };
  }],

  ["GET", /^\/auth\/callback$/, async (q) => {
    const fail = (msg) => ({ redirect: `/#/characters?error=${encodeURIComponent(msg)}` });
    if (q.get("error")) return fail(q.get("error_description") || q.get("error"));
    const exp = oauthStates.get(q.get("state"));
    oauthStates.delete(q.get("state"));
    if (!exp || exp < Date.now()) return fail("Login expired, please try again");
    Object.assign(userAuth, await exchangeCode(q.get("code"), REDIRECT_URI));
    const profile = await apiGet("/profile/user/wow", NS.profile, { bearer: userAuth.token });
    if (!profile.json) return fail(`Blizzard returned HTTP ${profile.status} for your account profile`);
    await writeFile("out/account-profile.json", JSON.stringify(profile.json, null, 2)).catch(() => {});
    const chars = (profile.json.wow_accounts ?? []).flatMap((a) => a.characters ?? []);
    // Keep the whole listing entry: its character / protected_character links are how Forever profiles are reached.
    await pool(chars, 4, (c) => saveCharacter(c.realm?.slug ?? "", c.name, "battlenet", c).catch(() => null));
    return { redirect: `/#/characters?imported=${chars.length}` };
  }],
];

// ---------------------------------------------------------------- HTTP plumbing
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

async function serveStatic(pathname, res) {
  const file = resolve(join(PUBLIC, pathname === "/" ? "index.html" : decodeURIComponent(pathname)));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) throw new HttpError(403, "Forbidden");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    throw new HttpError(404, "Not found");
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  try {
    for (const [method, re, handler] of routes) {
      const m = url.pathname.match(re);
      if (!m || method !== req.method) continue;
      const body = req.method === "POST" ? await readBody(req) : null;
      const out = await handler(url.searchParams, m, body);
      if (out && typeof out === "object" && "redirect" in out && Object.keys(out).every((k) => k === "redirect" || k === "cache")) {
        res.writeHead(302, { Location: out.redirect, "Cache-Control": out.cache ? `max-age=${out.cache}` : "no-store" });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(out));
    }
    if (url.pathname.startsWith("/api/")) throw new HttpError(404, "No such endpoint");
    await serveStatic(url.pathname, res);
  } catch (e) {
    const status = e.status ?? 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Forever AH running at ${BASE_URL}`);
  console.log(`(Battle.net login needs this redirect URL registered on your API client: ${REDIRECT_URI})`);
});
