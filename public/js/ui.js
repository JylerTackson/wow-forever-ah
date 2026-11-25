// Small shared helpers for rendering.
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// copper -> "12g 34s 56c" with colored unit letters
export function money(copper, { short = false } = {}) {
  if (copper == null || Number.isNaN(copper)) return `<span class="faint">—</span>`;
  const neg = copper < 0;
  let c = Math.round(Math.abs(copper));
  const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100;
  c = c % 100;
  const parts = [];
  if (g) parts.push(`<span class="g">${g.toLocaleString()}</span>`);
  if ((g || s) && !(short && g >= 100)) parts.push(`<span class="s">${g ? String(s).padStart(2, "0") : s}</span>`);
  if (!(short && g) || (!g && !s)) parts.push(`<span class="c">${g || s ? String(c).padStart(2, "0") : c}</span>`);
  return `<span class="money${neg ? " down" : ""}">${neg ? "−" : ""}${parts.join("")}</span>`;
}
export function moneyText(copper) {
  if (copper == null) return "—";
  const c = Math.round(Math.abs(copper));
  const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, cp = c % 100;
  return (copper < 0 ? "-" : "") + [g && `${g.toLocaleString()}g`, (g || s) && `${s}s`, `${cp}c`].filter(Boolean).join(" ");
}

export const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());
export const pct = (x) => (x == null ? "—" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(x !== 0 && Math.abs(x) < 0.1 ? 1 : 0)}%`);

export function change(cur, prev) {
  if (cur == null || !prev) return `<span class="chg flat">—</span>`;
  const d = (cur - prev) / prev;
  const cls = Math.abs(d) < 0.005 ? "flat" : d > 0 ? "up" : "down";
  return `<span class="chg ${cls}">${cls === "flat" ? "0%" : pct(d)}</span>`;
}

export function itemIcon(id, quality, size = "") {
  return `<img class="icon ${size} q-${esc(quality)}" loading="lazy" src="/api/icon/item/${Number(id)}" alt="">`;
}
export function itemName(it) {
  return `<span class="q-${esc(it.quality)}">${esc(it.name || `Item #${it.id}`)}</span>`;
}

export function timeAgo(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export const CLASS_COLORS = {
  "Warrior": "#C69B6D", "Paladin": "#F48CBA", "Hunter": "#AAD372", "Rogue": "#FFF468", "Priest": "#FFFFFF",
  "Shaman": "#0070DD", "Mage": "#3FC7EB", "Warlock": "#8788EE", "Druid": "#FF7C0A", "Death Knight": "#C41E3A",
};
export const QUALITIES = ["POOR", "COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"];
export const titleCase = (s) => (s ? s[0] + s.slice(1).toLowerCase() : "");

// Hash routing: "#/item/123?x=1" -> { parts: ["item","123"], query: URLSearchParams }
export function parseHash() {
  const [path, qs] = (location.hash.slice(1) || "/").split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs || "") };
}
export function setQuery(params, { replace = true } = {}) {
  const { parts } = parseHash();
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "" && v !== false) q.set(k, v);
  const hash = `#/${parts.map(encodeURIComponent).join("/")}${q.toString() ? "?" + q : ""}`;
  if (replace) history.replaceState(null, "", hash);
  else location.hash = hash;
}
