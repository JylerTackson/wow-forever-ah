import { QUALITIES, api, change, debounce, esc, fmt, itemIcon, itemName, money, setQuery, timeAgo, titleCase } from "./ui.js";

const COLUMNS = [
  { key: "name", label: "Item" },
  { key: "min", label: "Min buyout", r: true },
  { key: "median", label: "Median", r: true },
  { key: "change", label: "Δ 24h", r: true, title: "Change in median price vs. ~24h earlier" },
  { key: "qty", label: "Listed", r: true },
  { key: "auctions", label: "Auctions", r: true },
  { key: "sold", label: "Est. sold 24h", r: true, title: "Units that left the AH too early to have expired (sales + cancellations)" },
  { key: "value", label: "Market value", r: true, title: "Median × quantity listed" },
];
const PAGE = 100;

export async function renderMarket({ view, query, app }) {
  const state = {
    q: query.get("q") || "",
    class: query.get("class") || "",
    quality: query.get("quality") || "",
    sort: query.get("sort") || "value",
    dir: query.get("dir") || "desc",
  };
  let rows = [];
  let total = 0;
  let info = null;
  let reqId = 0;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Market</h1>
        <div class="sub" id="m-sub">Loading…</div>
      </div>
    </div>
    <div class="toolbar">
      <input class="input" type="search" id="m-q" placeholder="Filter by name or item ID" value="${esc(state.q)}">
      <select id="m-class"><option value="">All categories</option>${app.meta.classes.map((c) => `<option ${c === state.class ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <select id="m-quality"><option value="">Any quality</option>${QUALITIES.map((q) => `<option value="${q}" ${q === state.quality ? "selected" : ""}>${titleCase(q)}</option>`).join("")}</select>
    </div>
    <div class="panel"><div class="table-wrap"><table>
      <thead><tr id="m-head"></tr></thead>
      <tbody id="m-body"><tr><td colspan="8" class="loading">Loading…</td></tr></tbody>
    </table></div></div>
    <div class="row" style="justify-content:center;margin-top:14px"><button class="btn" id="m-more" hidden>Load more</button></div>`;

  const $ = (id) => view.querySelector(id);

  const drawHead = () => {
    $("#m-head").innerHTML = COLUMNS.map((c) => {
      const on = state.sort === c.key;
      return `<th class="sortable ${c.r ? "r" : ""} ${on ? "sorted" : ""}" data-key="${c.key}" ${c.title ? `title="${esc(c.title)}"` : ""}>${c.label}${on ? (state.dir === "asc" ? " ▲" : " ▼") : ""}</th>`;
    }).join("");
  };

  const drawRows = () => {
    if (!rows.length) {
      $("#m-body").innerHTML = `<tr><td colspan="8"><div class="empty-state"><h3>No items</h3>${
        info?.last_modified ? "Nothing matches these filters." : "No snapshots for this house yet — run the collector."}</div></td></tr>`;
    } else {
      $("#m-body").innerHTML = rows.map((r) => `
        <tr class="link" data-id="${r.id}">
          <td><div class="item-cell">${itemIcon(r.id, r.quality)}<div class="meta"><span class="name">${itemName(r)}</span><span class="sub">${esc(r.item_class || "Unknown")}</span></div></div></td>
          <td class="r">${money(r.min_price)}</td>
          <td class="r">${money(r.median_price)}</td>
          <td class="r">${change(r.median_price, r.prev_median)}</td>
          <td class="r num">${fmt(r.total_quantity)}</td>
          <td class="r num">${fmt(r.num_auctions)}</td>
          <td class="r num">${info.has_sales ? fmt(r.sold24) : `<span class="faint">—</span>`}</td>
          <td class="r">${money(r.median_price * r.total_quantity, { short: true })}</td>
        </tr>`).join("");
    }
    $("#m-more").hidden = rows.length >= total;
  };

  async function load(append = false) {
    const id = ++reqId;
    const params = new URLSearchParams({ house: app.house, sort: state.sort, dir: state.dir, limit: PAGE, offset: append ? rows.length : 0 });
    for (const k of ["q", "class", "quality"]) if (state[k]) params.set(k, state[k]);
    const data = await api(`/api/market?${params}`);
    if (id !== reqId) return; // a newer request superseded this one
    info = data;
    total = data.total;
    rows = append ? rows.concat(data.rows) : data.rows;
    const house = app.meta.houses.find((h) => h.id === data.house);
    $("#m-sub").innerHTML = data.last_modified
      ? `${fmt(total)} items listed on ${esc(house?.label ?? data.house)} · snapshot ${timeAgo(data.last_modified)}` +
        (data.compare_to ? ` · changes vs. ${new Date(data.compare_to).toLocaleString()}` : ` · <span class="faint">price changes appear after a second snapshot</span>`) +
        (data.has_sales ? "" : ` · <span class="faint">sales estimates appear after the next collector run</span>`)
      : "No data yet";
    drawRows();
  }

  const sync = () => setQuery({ q: state.q, class: state.class, quality: state.quality, sort: state.sort !== "value" && state.sort, dir: state.dir !== "desc" && state.dir });
  const reload = () => { sync(); load().catch(showErr); };
  const showErr = (e) => ($("#m-body").innerHTML = `<tr><td colspan="8"><div class="notice err">${esc(e.message)}</div></td></tr>`);

  $("#m-q").addEventListener("input", debounce((e) => { state.q = e.target.value.trim(); reload(); }, 250));
  $("#m-class").addEventListener("change", (e) => { state.class = e.target.value; reload(); });
  $("#m-quality").addEventListener("change", (e) => { state.quality = e.target.value; reload(); });
  $("#m-head").addEventListener("click", (e) => {
    const key = e.target.closest("th")?.dataset.key;
    if (!key) return;
    if (state.sort === key) state.dir = state.dir === "asc" ? "desc" : "asc";
    else { state.sort = key; state.dir = key === "name" ? "asc" : "desc"; }
    drawHead();
    reload();
  });
  $("#m-body").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) location.hash = `#/item/${tr.dataset.id}`;
  });
  $("#m-more").addEventListener("click", () => load(true).catch(showErr));

  drawHead();
  await load().catch(showErr);
}
