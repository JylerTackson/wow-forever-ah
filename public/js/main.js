import { api, debounce, esc, itemIcon, itemName, parseHash, store } from "./ui.js";
import { renderMarket } from "./market.js";
import { renderItem } from "./item.js";
import { renderProfessions } from "./professions.js";
import { renderCharacters, renderCharacter } from "./characters.js";

const view = document.getElementById("view");
const houseSelect = document.getElementById("house-select");

export const app = {
  meta: null,
  get house() { return Number(houseSelect.value) || null; },
};

async function init() {
  app.meta = await api("/api/meta");
  const saved = store.get("house", null);
  houseSelect.innerHTML = app.meta.houses
    .map((h) => `<option value="${h.id}">${esc(h.label)}${h.snapshots ? "" : " — no data"}</option>`)
    .join("");
  if (saved && app.meta.houses.some((h) => h.id === saved)) houseSelect.value = saved;
  houseSelect.addEventListener("change", () => {
    store.set("house", app.house);
    route();
  });
  window.addEventListener("hashchange", route);
  setupSearch();
  route();
}

let cleanup = null;
async function route() {
  const { parts, query } = parseHash();
  document.getElementById("search-results").hidden = true;
  const tab = parts[0] === "item" || !parts[0] ? "market" : parts[0] === "character" ? "characters" : parts[0];
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  if (typeof cleanup === "function") cleanup();
  cleanup = null;
  window.scrollTo(0, 0);
  const ctx = { view, query, parts, app };
  try {
    if (!parts[0]) cleanup = await renderMarket(ctx);
    else if (parts[0] === "item") cleanup = await renderItem(ctx, Number(parts[1]));
    else if (parts[0] === "professions") cleanup = await renderProfessions(ctx);
    else if (parts[0] === "characters") cleanup = await renderCharacters(ctx);
    else if (parts[0] === "character") cleanup = await renderCharacter(ctx, parts[1], parts[2]);
    else view.innerHTML = `<div class="empty-state"><h3>Page not found</h3><a class="btn" href="#/">Back to market</a></div>`;
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="notice err">Something went wrong: ${esc(e.message)}</div>`;
  }
}

// ---------- global item search (autocomplete) ----------
function setupSearch() {
  const input = document.getElementById("global-search");
  const box = document.getElementById("search-results");
  let results = [];
  let sel = -1;

  const draw = () => {
    box.hidden = !results.length;
    box.innerHTML = results
      .map((r, i) => `<a href="#/item/${r.id}" class="${i === sel ? "sel" : ""}">${itemIcon(r.id, r.quality, "sm")}${itemName(r)}<span class="sub">${esc(r.item_class || "")}</span></a>`)
      .join("");
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    results = q ? await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []) : [];
    sel = results.length ? 0 : -1;
    draw();
  }, 150);

  input.addEventListener("input", search);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(sel + 1, results.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter") {
      if (results[sel]) location.hash = `#/item/${results[sel].id}`;
      else if (input.value.trim()) location.hash = `#/?q=${encodeURIComponent(input.value.trim())}`;
      close();
    } else if (e.key === "Escape") close();
  });
  box.addEventListener("click", () => close());
  document.addEventListener("click", (e) => { if (!e.target.closest(".global-search")) box.hidden = true; });
  input.addEventListener("focus", () => { if (results.length) box.hidden = false; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
  });
  function close() { box.hidden = true; input.value = ""; results = []; input.blur(); }
}

init().catch((e) => {
  view.innerHTML = `<div class="notice err">Couldn't reach the server: ${esc(e.message)}</div>`;
});
