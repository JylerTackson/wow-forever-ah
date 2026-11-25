import { api, debounce, esc, fmt, itemIcon, money, pct, setQuery } from "./ui.js";

const SORTS = [
  ["", "Recipe order"], ["profit", "Profit"], ["margin", "Margin %"], ["value", "Sell value"],
  ["cost", "Craft cost"], ["sold", "Sold 24h"], ["name", "Name"],
];

export async function renderProfessions({ view, query, app }) {
  const state = {
    p: query.get("p") || "",
    q: query.get("q") || "",
    category: query.get("category") || "",
    sort: query.get("sort") || "",
    price: query.get("price") || "min",
    profitable: query.get("profitable") === "1",
    known: query.get("known") || "",
  };
  view.innerHTML = `<div class="loading">Loading professions…</div>`;
  const [{ professions, sync }, characters] = await Promise.all([api("/api/professions"), api("/api/characters").catch(() => [])]);

  if (!professions.length) return renderSyncPrompt(view, sync);

  const withProfs = characters.filter((c) => c.professions?.length);
  const groups = { PRIMARY: "Primary", SECONDARY: "Secondary" };
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Professions</h1><div class="sub" id="p-sub">Craft costs use live prices from the selected house.</div></div>
      <button class="btn" id="p-resync" title="Re-download recipes from Blizzard (after a patch)">↻ Re-sync recipes</button>
    </div>
    <div class="prof-layout">
      <nav class="panel prof-list" id="p-list">
        <a href="#" data-p="" class="${state.p ? "" : "active"}"><span>All professions</span><span class="count">${fmt(professions.reduce((n, p) => n + p.recipes, 0))}</span></a>
        ${Object.entries(groups).map(([type, label]) => {
          const list = professions.filter((p) => (p.type || "PRIMARY") === type);
          return list.length ? `<div class="group">${label}</div>` + list.map((p) => `
            <a href="#" data-p="${p.id}" class="${String(p.id) === state.p ? "active" : ""}">
              ${p.icon ? `<img class="icon sm" src="${esc(p.icon)}" alt="">` : ""}<span>${esc(p.name)}</span><span class="count">${p.recipes}</span>
            </a>`).join("") : "";
        }).join("")}
      </nav>
      <section>
        <div class="toolbar">
          <input class="input" type="search" id="p-q" placeholder="Search recipes, crafted items or reagents…" value="${esc(state.q)}">
          <select id="p-sort">${SORTS.map(([k, l]) => `<option value="${k}" ${k === state.sort ? "selected" : ""}>Sort: ${l}</option>`).join("")}</select>
          <div class="seg" id="p-price" title="Which AH price to use for reagents and crafted items">
            <button data-v="min" class="${state.price === "min" ? "on" : ""}">Min buyout</button>
            <button data-v="median" class="${state.price === "median" ? "on" : ""}">Median</button>
          </div>
          <label class="check"><input type="checkbox" id="p-profit" ${state.profitable ? "checked" : ""}> Profitable only</label>
          ${withProfs.length ? `<select id="p-known"><option value="">Any recipe</option>${withProfs.map((c) => `<option value="${esc(c.realm)}/${esc(c.name.toLowerCase())}" ${state.known === `${c.realm}/${c.name.toLowerCase()}` ? "selected" : ""}>Known by ${esc(c.name)}</option>`).join("")}</select>` : ""}
        </div>
        <div class="chips" id="p-cats"></div>
        <div class="panel"><div class="table-wrap"><table>
          <thead><tr><th>Recipe</th><th>Reagents</th><th class="r">Craft cost</th><th class="r">Sells for</th><th class="r" title="Sell value minus 5% AH cut minus reagent cost">Profit</th><th class="r">Margin</th></tr></thead>
          <tbody id="p-body"><tr><td colspan="6" class="loading">Loading…</td></tr></tbody>
        </table></div></div>
        <div class="faint small" style="margin-top:10px">Dashed reagents have no AH listing on this house (often vendor-bought); recipes with them show cost without those reagents and no profit.</div>
      </section>
    </div>`;

  const $ = (s) => view.querySelector(s);
  let reqId = 0;

  async function load() {
    const id = ++reqId;
    setQuery({ p: state.p, q: state.q, category: state.category, sort: state.sort, price: state.price !== "min" && state.price, profitable: state.profitable && "1", known: state.known });
    const params = new URLSearchParams({ house: app.house, price: state.price });
    for (const k of ["q", "category", "sort", "known"]) if (state[k]) params.set(k, state[k]);
    if (state.p) params.set("profession", state.p);
    if (state.profitable) params.set("profitable", "1");
    const data = await api(`/api/recipes?${params}`);
    if (id !== reqId) return;

    $("#p-cats").innerHTML = data.categories.length > 1
      ? [`<button class="chip ${state.category ? "" : "on"}" data-c="">All</button>`,
         ...data.categories.map((c) => `<button class="chip ${c.category === state.category ? "on" : ""}" data-c="${esc(c.category)}">${esc(c.category)} <span class="faint">${c.n}</span></button>`)].join("")
      : "";
    const house = app.meta.houses.find((h) => h.id === data.house);
    $("#p-sub").innerHTML = `${fmt(data.total)} recipes · prices from ${esc(house?.label ?? data.house)} (${state.price === "min" ? "min buyout" : "median"})`;
    $("#p-body").innerHTML = data.recipes.length
      ? data.recipes.map(row).join("") + (data.total > data.recipes.length ? `<tr><td colspan="6" class="faint">Showing ${data.recipes.length} of ${fmt(data.total)} — narrow the search to see more.</td></tr>` : "")
      : `<tr><td colspan="6"><div class="empty-state"><h3>No recipes</h3>Nothing matches these filters.</div></td></tr>`;
  }
  const reload = () => load().catch((e) => ($("#p-body").innerHTML = `<tr><td colspan="6"><div class="notice err">${esc(e.message)}</div></td></tr>`));

  $("#p-list").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-p]");
    if (!a) return;
    e.preventDefault();
    state.p = a.dataset.p;
    state.category = "";
    view.querySelectorAll("#p-list a").forEach((x) => x.classList.toggle("active", x === a));
    reload();
  });
  $("#p-cats").addEventListener("click", (e) => {
    const c = e.target.closest("[data-c]");
    if (!c) return;
    state.category = c.dataset.c;
    reload();
  });
  $("#p-q").addEventListener("input", debounce((e) => { state.q = e.target.value.trim(); reload(); }, 250));
  $("#p-sort").addEventListener("change", (e) => { state.sort = e.target.value; reload(); });
  $("#p-profit").addEventListener("change", (e) => { state.profitable = e.target.checked; reload(); });
  $("#p-known")?.addEventListener("change", (e) => { state.known = e.target.value; reload(); });
  $("#p-price").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.price = b.dataset.v;
    view.querySelectorAll("#p-price button").forEach((x) => x.classList.toggle("on", x === b));
    reload();
  });
  $("#p-resync").addEventListener("click", async () => {
    await api("/api/professions/sync", { method: "POST" });
    renderSyncPrompt(view, { running: true, log: [] });
  });

  await reload();
}

function row(r) {
  const crafted = r.crafted_item_id
    ? `<a href="#/item/${r.crafted_item_id}">${itemIcon(r.crafted_item_id, r.crafted_quality)}</a>`
    : r.icon ? `<img class="icon" src="${esc(r.icon)}" alt="">` : "";
  const qty = r.crafted_qty && r.crafted_qty !== 1 ? ` <span class="faint">×${r.crafted_qty}</span>` : "";
  return `<tr>
    <td><div class="item-cell">${crafted}<div class="meta">
      ${r.crafted_item_id ? `<a class="name q-${esc(r.crafted_quality)}" href="#/item/${r.crafted_item_id}">${esc(r.name)}</a>` : `<span class="name">${esc(r.name)}</span>`}
      <span class="sub">${esc(r.profession)} · ${esc(r.category || "")}${qty}</span></div></div></td>
    <td class="wrap"><div class="reagents">${r.reagents.map((g) => `
      <a class="reagent ${g.unit == null ? "missing" : ""}" href="#/item/${g.id}" title="${esc(g.name)} ×${g.quantity}${g.unit != null ? ` — ${esc(moneyPlain(g.unit))} each, ${fmt(g.listed)} listed` : " — not on AH"}">
        ${itemIcon(g.id, g.quality, "sm")}<span class="x">${g.quantity}</span></a>`).join("")}</div></td>
    <td class="r">${r.reagents.length ? money(r.cost) + (r.missing ? `<div class="faint small">+${r.missing} unpriced</div>` : "") : `<span class="faint">—</span>`}</td>
    <td class="r">${money(r.value)}${r.crafted_item_id ? `<div class="faint small">${fmt(r.listed)} listed · ${fmt(r.sold24)} sold 24h</div>` : ""}</td>
    <td class="r">${r.profit != null ? `<span class="${r.profit >= 0 ? "up" : "down"}">${money(r.profit)}</span>` : `<span class="faint">—</span>`}</td>
    <td class="r num ${r.margin > 0 ? "up" : r.margin < 0 ? "down" : ""}">${r.margin != null ? pct(r.margin) : "—"}</td>
  </tr>`;
}
const moneyPlain = (c) => {
  const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, cp = c % 100;
  return [g && `${g}g`, (g || s) && `${s}s`, `${cp}c`].filter(Boolean).join(" ");
};

function renderSyncPrompt(view, sync) {
  view.innerHTML = `<div class="panel"><div class="empty-state">
    <h3>${sync.running ? "Downloading professions…" : "No profession data yet"}</h3>
    <p>${sync.running ? "Fetching every recipe and its reagents from Blizzard. This takes about two minutes." : "Download all professions, recipes and reagents from the Blizzard API (about two minutes)."}</p>
    ${sync.running ? "" : `<button class="btn primary" id="p-sync">Sync professions</button>`}
    ${sync.error ? `<div class="notice err" style="margin-top:12px">${esc(sync.error)}</div>` : ""}
    <div class="log" id="p-log">${esc((sync.log || []).join("\n"))}</div>
  </div></div>`;
  view.querySelector("#p-sync")?.addEventListener("click", async () => {
    await api("/api/professions/sync", { method: "POST" });
    renderSyncPrompt(view, { running: true, log: [] });
  });
  if (!sync.running) return;
  const timer = setInterval(async () => {
    const { sync: s } = await api("/api/professions").catch(() => ({ sync: {} }));
    const log = view.querySelector("#p-log");
    if (!log) return clearInterval(timer);
    log.textContent = (s.log || []).join("\n");
    if (!s.running) {
      clearInterval(timer);
      if (s.error) renderSyncPrompt(view, s);
      else window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  }, 1500);
  return () => clearInterval(timer);
}
