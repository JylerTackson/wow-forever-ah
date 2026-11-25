import { CLASS_COLORS, api, esc, fmt, itemIcon, timeAgo } from "./ui.js";

const SLOT_ORDER = ["HEAD", "NECK", "SHOULDER", "BACK", "CHEST", "SHIRT", "TABARD", "WRIST", "HANDS", "WAIST", "LEGS", "FEET",
  "FINGER_1", "FINGER_2", "TRINKET_1", "TRINKET_2", "MAIN_HAND", "OFF_HAND", "RANGED"];

const classColor = (c) => CLASS_COLORS[c] ?? "var(--text)";
const initials = (n) => esc((n || "?")[0].toUpperCase());
const avatar = (c, size = "") =>
  c.avatar ? `<img class="avatar ${size}" src="${esc(c.avatar)}" alt="">` : `<div class="avatar ${size}">${initials(c.name)}</div>`;
const faction = (f) => (f ? `<span class="badge ${f.toLowerCase()}">${esc(f[0] + f.slice(1).toLowerCase())}</span>` : "");

export async function renderCharacters({ view, query, app }) {
  view.innerHTML = `<div class="loading">Loading characters…</div>`;
  const chars = await api("/api/characters");
  const imported = query.get("imported");
  const error = query.get("error");

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Characters</h1><div class="sub">Gear and professions from the Blizzard profile API.</div></div>
      <a class="btn bnet" href="/auth/login">Log in with Battle.net</a>
    </div>
    ${imported != null ? `<div class="notice ok" style="margin-bottom:14px">Imported ${esc(imported)} character${imported === "1" ? "" : "s"} from your Battle.net account.</div>` : ""}
    ${error ? `<div class="notice err" style="margin-bottom:14px">Battle.net login failed: ${esc(error)}<br>
      Make sure <code>${esc(app.meta.redirectUri)}</code> is listed under <b>Redirect URLs</b> for your client at develop.battle.net.</div>` : ""}
    <div class="panel" style="margin-bottom:18px"><div class="panel-body">
      <form class="form-row" id="c-add">
        <input class="input" name="name" placeholder="Character name" required>
        <input class="input" name="realm" placeholder="Realm (slug, e.g. whitemane)" required>
        <button class="btn primary">Add character</button>
        <span class="muted small" style="align-self:center">…or log in with Battle.net to import every character on your account.</span>
      </form>
      <div id="c-msg" style="margin-top:10px" hidden></div>
    </div></div>
    ${chars.length ? `<div class="char-grid">${chars.map(card).join("")}</div>` : `<div class="panel"><div class="empty-state">
      <h3>No characters yet</h3>
      <p>Log in with Battle.net to pull in all of your characters, or add one by name and realm.</p>
      <p class="small faint">Battle.net login needs <code>${esc(app.meta.redirectUri)}</code> added as a Redirect URL on your API client at develop.battle.net.</p>
    </div></div>`}`;

  view.querySelector("#c-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const msg = view.querySelector("#c-msg");
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    msg.hidden = false;
    msg.className = "notice";
    msg.textContent = "Looking up character…";
    try {
      const c = await api("/api/characters", { method: "POST", body: { name: f.get("name"), realm: f.get("realm") } });
      location.hash = `#/character/${encodeURIComponent(c.realm)}/${encodeURIComponent(c.name.toLowerCase())}`;
    } catch (err) {
      msg.className = "notice err";
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

function card(c) {
  return `<a class="panel char-card" href="#/character/${encodeURIComponent(c.realm)}/${encodeURIComponent(c.name.toLowerCase())}">
    ${avatar(c)}
    <div style="min-width:0;flex:1">
      <div class="char-name" style="color:${classColor(c.class)}">${esc(c.name)}</div>
      <div class="muted small">${[c.level && `Level ${c.level}`, c.race, c.class].filter(Boolean).map(esc).join(" ")}</div>
      <div class="muted small">${esc(c.realm_name)}${c.guild ? ` · &lt;${esc(c.guild)}&gt;` : ""}</div>
      <div class="row" style="margin-top:6px;gap:6px">${faction(c.faction)}${c.item_level ? `<span class="badge">ilvl ${c.item_level}</span>` : ""}${c.error ? `<span class="badge err" title="${esc(c.error)}">profile unavailable</span>` : ""}</div>
      ${c.professions.length ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">${c.professions.map((p) => `
        <div class="mini-prof"><span style="width:96px">${esc(p.name)}</span><div class="bar"><span style="width:${p.max ? (100 * p.skill) / p.max : 0}%"></span></div><span class="num">${p.skill}/${p.max}</span></div>`).join("")}</div>` : ""}
    </div>
  </a>`;
}

export async function renderCharacter({ view, app }, realm, name, refresh = false) {
  view.innerHTML = `<div class="loading">${refresh ? "Refreshing from Blizzard…" : "Loading character…"}</div>`;
  let data;
  try {
    data = await api(`/api/characters/${encodeURIComponent(realm)}/${encodeURIComponent(name)}${refresh ? "?refresh=1" : ""}`);
  } catch (e) {
    view.innerHTML = `<div class="notice err">${esc(e.message)}</div><p><a class="btn" href="#/characters">← Characters</a></p>`;
    return;
  }
  const c = data.card;
  const bySlot = new Map(data.equipment.map((e) => [e.slot_type, e]));
  const slots = [...SLOT_ORDER.filter((s) => bySlot.has(s)), ...data.equipment.map((e) => e.slot_type).filter((s) => !SLOT_ORDER.includes(s))];
  const avgIlvl = data.equipment.length ? Math.round(data.equipment.reduce((n, e) => n + (e.level || 0), 0) / data.equipment.length) : null;

  view.innerHTML = `
    <p style="margin:0 0 14px"><a class="muted" href="#/characters">← Characters</a></p>
    <div class="item-header">
      ${avatar(c, "xl")}
      <div>
        <h1 style="color:${classColor(c.class)}">${esc(c.name)}</h1>
        <div class="sub">${[c.level && `Level ${c.level}`, c.race, c.class].filter(Boolean).map(esc).join(" ")} · ${esc(c.realm_name)}${c.guild ? ` · &lt;${esc(c.guild)}&gt;` : ""}</div>
        <div class="row" style="margin-top:8px;gap:6px">${faction(c.faction)}
          ${c.item_level || avgIlvl ? `<span class="badge">item level ${c.item_level ?? avgIlvl}</span>` : ""}
          <span class="badge">updated ${timeAgo(c.fetched_at)}</span></div>
      </div>
      <div class="price-big row">
        <button class="btn" id="c-refresh">↻ Refresh</button>
        <button class="btn danger" id="c-delete">Remove</button>
      </div>
    </div>
    ${c.error ? `<div class="notice err" style="margin-bottom:16px">${esc(c.error)}</div>` : ""}
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>Equipment</h2><span class="faint small">${data.equipment.length} items</span></div>
        <div class="panel-body">
          ${data.equipment.length ? `<div class="equip-grid">${slots.map((s) => equip(bySlot.get(s))).join("")}</div>`
            : `<div class="faint">${data.raw_available.equipment ? "Nothing equipped." : "Blizzard didn't return equipment for this character."}</div>`}
        </div>
      </div>
      <div class="stack">
        ${data.professions.length ? data.professions.map((p) => profession(p, realm, name)).join("")
          : `<div class="panel"><div class="panel-head"><h2>Professions</h2></div><div class="panel-body faint">${data.raw_available.professions ? "No professions learned." : "Blizzard didn't return professions for this character."}</div></div>`}
      </div>
    </div>`;

  view.querySelector("#c-refresh").addEventListener("click", () => renderCharacter({ view, app }, realm, name, true));
  view.querySelector("#c-delete").addEventListener("click", async () => {
    await api(`/api/characters/${encodeURIComponent(realm)}/${encodeURIComponent(name)}`, { method: "DELETE" });
    location.hash = "#/characters";
  });
  view.querySelectorAll("[data-filter]").forEach((input) =>
    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      input.closest(".panel").querySelectorAll(".known-list > div").forEach((d) => (d.hidden = !d.textContent.toLowerCase().includes(q)));
    })
  );
}

function equip(e) {
  const lines = e.tooltip.filter((l) => l.cls === "stat-green" || /Armor|Damage|per second|Strength|Agility|Stamina|Intellect|Spirit/.test(l.text) && l.cls !== "flavor").slice(0, 4);
  return `<div class="equip">
    <a href="#/item/${e.id}">${itemIcon(e.id, e.quality)}</a>
    <div style="min-width:0">
      <div class="slot">${esc(e.slot)}${e.level ? ` · ilvl ${e.level}` : ""}</div>
      <a href="#/item/${e.id}" class="q-${esc(e.quality)}" style="font-weight:500">${esc(e.name)}</a>
      ${e.enchantments.map((x) => `<div class="ench">${esc(x)}</div>`).join("")}
      ${lines.length ? `<div class="lines">${lines.map((l) => esc(l.text)).join(" · ")}</div>` : ""}
    </div>
  </div>`;
}

function profession(p, realm, name) {
  const pct = p.max ? (100 * p.skill) / p.max : 0;
  const known = `${encodeURIComponent(realm)}/${encodeURIComponent(name)}`;
  return `<div class="panel">
    <div class="panel-head"><h2>${esc(p.name)}</h2><span class="faint small">${p.type === "PRIMARY" ? "Primary" : "Secondary"}</span></div>
    <div class="panel-body">
      <div class="mini-prof" style="font-size:13px"><div class="bar" style="height:8px"><span style="width:${pct}%"></span></div><span class="num">${fmt(p.skill)} / ${fmt(p.max)}</span></div>
      ${p.known.length ? `
        <div class="row" style="margin:14px 0 8px">
          <span class="muted small">${p.known.length} known recipes</span><span class="spacer"></span>
          <a class="btn" href="#/professions?p=${p.id}&known=${known}&sort=profit">Profit view →</a>
        </div>
        <input class="input" data-filter placeholder="Filter known recipes…" style="width:100%;margin-bottom:8px">
        <div class="known-list">${p.known.sort((a, b) => a.name.localeCompare(b.name)).map((r) => `<div>${esc(r.name)}</div>`).join("")}</div>`
        : `<div class="faint small" style="margin-top:10px">Blizzard didn't list known recipes for this profession.</div>`}
    </div>
  </div>`;
}
