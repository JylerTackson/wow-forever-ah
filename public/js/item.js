import { api, change, esc, fmt, itemIcon, itemName, money, moneyText, setQuery, store, timeAgo, titleCase } from "./ui.js";

const RANGES = [
  { days: 1, label: "24H" },
  { days: 7, label: "7D" },
  { days: 30, label: "30D" },
  { days: 0, label: "All" },
];
const SERIES = [
  { key: "min", label: "Min buyout", color: "#e8b64c", on: true },
  { key: "median", label: "Median", color: "#58a6ff", on: true },
  { key: "mean", label: "Mean", color: "#a371f7", on: false },
  { key: "qty", label: "Listed qty", color: "rgba(139,147,167,.45)", on: true },
  { key: "sold", label: "Est. sold", color: "#3fb950", on: true },
];

export async function renderItem({ view, query, app }, id) {
  view.innerHTML = `<div class="loading">Loading item…</div>`;
  const item = await api(`/api/item/${id}`);
  const house = app.house;
  const here = item.houses.find((h) => h.id === house) ?? item.houses[0];
  const d = item.details ?? {};
  let days = Number(query.get("range") ?? store.get("range", 7));
  const visible = store.get("series", Object.fromEntries(SERIES.map((s) => [s.key, s.on])));

  const subtitle = [d.item_subclass && d.item_subclass !== item.item_class ? `${item.item_class} · ${d.item_subclass}` : item.item_class,
    d.inventory_type && d.inventory_type !== "Non-equippable" ? d.inventory_type : null,
    d.level ? `Item level ${d.level}` : null, d.required_level ? `Requires level ${d.required_level}` : null]
    .filter(Boolean).join(" · ");

  const sales = (h) => (h.sold24.q || h.sold7d.q ? h : null);
  view.innerHTML = `
    <div class="item-header">
      ${itemIcon(item.id, item.quality, "lg")}
      <div>
        <h1>${itemName(item)}</h1>
        <div class="sub">${esc(subtitle || "Unknown item")} · <span class="faint">ID ${item.id}</span></div>
      </div>
      <div class="price-big">
        <div class="label">${esc(here?.label ?? "")} · min buyout</div>
        <div class="value">${here?.listed ? money(here.min_price) : `<span class="faint">Not listed</span>`}</div>
        <div>${here?.listed ? change(here.min_price, here.prev_min) + ` <span class="faint small">24h</span>` : here?.last_seen ? `<span class="faint small">last seen ${timeAgo(here.last_seen)}</span>` : ""}</div>
      </div>
    </div>

    <div class="stats">
      ${stat("Median price", money(here?.median_price), here?.listed ? change(here.median_price, here.prev_median) : "")}
      ${stat("Mean price", money(here?.mean_price))}
      ${stat("Listed quantity", `<span class="num">${fmt(here?.total_quantity)}</span>`)}
      ${stat("Auctions", `<span class="num">${fmt(here?.num_auctions)}</span>`)}
      ${stat("Est. sold 24h", sales(here) ? `<span class="num">${fmt(here.sold24.q)}</span>` : `<span class="faint">—</span>`, sales(here) ? money(here.sold24.v, { short: true }) : "")}
      ${stat("Est. sold 7d", sales(here) ? `<span class="num">${fmt(here.sold7d.q)}</span>` : `<span class="faint">—</span>`, sales(here) ? money(here.sold7d.v, { short: true }) : "")}
      ${stat("Market value", here?.listed ? money(here.median_price * here.total_quantity, { short: true }) : `<span class="faint">—</span>`)}
      ${stat("Vendor sell", d.sell_price ? money(d.sell_price) : `<span class="faint">—</span>`)}
    </div>

    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head">
        <div class="legend" id="i-legend">${SERIES.map((s) => `<label><input type="checkbox" data-key="${s.key}" ${visible[s.key] ? "checked" : ""} hidden><span class="sw" style="background:${s.color};${visible[s.key] ? "" : "opacity:.25"}"></span>${s.label}</label>`).join("")}</div>
        <div class="seg" id="i-range">${RANGES.map((r) => `<button data-days="${r.days}" class="${r.days === days ? "on" : ""}">${r.label}</button>`).join("")}</div>
      </div>
      <div class="chart-box" id="i-chart"><div class="chart-tip" id="i-tip" hidden></div><div class="chart-empty" id="i-empty" hidden></div></div>
    </div>

    <div class="grid-2">
      <div class="stack">
        <div class="panel">
          <div class="panel-head"><h2>Across auction houses</h2><span class="faint small">click a row to switch house</span></div>
          <div class="table-wrap"><table>
            <thead><tr><th>House</th><th class="r">Min</th><th class="r">Median</th><th class="r">Δ 24h</th><th class="r">Listed</th><th class="r">Sold 24h</th><th class="r">Sold 7d</th></tr></thead>
            <tbody id="i-houses">${item.houses.map((h) => `
              <tr class="link" data-house="${h.id}" ${h.id === house ? `style="background:var(--accent-soft)"` : ""}>
                <td>${esc(h.label)}</td>
                <td class="r">${h.listed ? money(h.min_price) : `<span class="faint">${h.last_seen ? "seen " + timeAgo(h.last_seen) : "not listed"}</span>`}</td>
                <td class="r">${h.listed ? money(h.median_price) : ""}</td>
                <td class="r">${h.listed ? change(h.median_price, h.prev_median) : ""}</td>
                <td class="r num">${fmt(h.total_quantity)}</td>
                <td class="r num">${sales(h) ? fmt(h.sold24.q) : "—"}</td>
                <td class="r num">${sales(h) ? fmt(h.sold7d.q) : "—"}</td>
              </tr>`).join("")}
            </tbody>
          </table></div>
        </div>
        ${recipeSection("Crafted by", item.craftedBy, true)}
        ${recipeSection("Used in", item.usedIn, false)}
        <div class="panel">
          <div class="panel-head"><h2>Snapshot history</h2><span class="faint small" id="i-hist-sub"></span></div>
          <div class="table-wrap" style="max-height:360px;overflow-y:auto"><table>
            <thead><tr><th>Snapshot</th><th class="r">Min</th><th class="r">Median</th><th class="r">Listed</th><th class="r">Auctions</th><th class="r">Est. sold</th></tr></thead>
            <tbody id="i-hist"></tbody>
          </table></div>
        </div>
      </div>
      <div class="stack">
        <div class="panel">
          <div class="panel-head"><h2>Item</h2></div>
          <div class="panel-body tooltip-card">
            <div class="q-${esc(item.quality)}" style="font-weight:600;font-size:15px">${esc(item.name || `Item #${item.id}`)}</div>
            ${(d.tooltip ?? []).map((l) => `<div class="${esc(l.cls)}">${esc(l.text)}</div>`).join("") || `<div class="faint">No tooltip data</div>`}
          </div>
          <div class="panel-body" style="border-top:1px solid var(--border)">
            <dl class="kv-list">
              <dt>Quality</dt><dd class="q-${esc(item.quality)}">${esc(titleCase(item.quality) || "—")}</dd>
              <dt>Category</dt><dd>${esc([item.item_class, d.item_subclass].filter(Boolean).join(" / ") || "—")}</dd>
              ${d.max_stack ? `<dt>Stack size</dt><dd class="num">${d.max_stack}</dd>` : ""}
              <dt>Vendor buy</dt><dd>${d.purchase_price ? money(d.purchase_price) : "—"}</dd>
              <dt>Vendor sell</dt><dd>${d.sell_price ? money(d.sell_price) : "—"}</dd>
              ${here?.listed && d.sell_price ? `<dt>AH / vendor</dt><dd class="num">${(here.min_price / d.sell_price).toFixed(1)}×</dd>` : ""}
            </dl>
          </div>
        </div>
      </div>
    </div>`;

  const $ = (s) => view.querySelector(s);

  // ---------- chart ----------
  const LC = window.LightweightCharts;
  let chart = null;
  const series = {};
  let byTime = new Map();
  if (LC) {
    chart = LC.createChart($("#i-chart"), {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: "#8b93a7", fontFamily: "Inter, system-ui, sans-serif" },
      grid: { vertLines: { color: "#191e2b" }, horzLines: { color: "#191e2b" } },
      rightPriceScale: { borderColor: "#262d3f", scaleMargins: { top: 0.08, bottom: 0.28 } },
      timeScale: { borderColor: "#262d3f", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LC.CrosshairMode.Normal },
    });
    // Axis labels: drop copper once there is gold, and silver past 100g.
    const axis = (p) => { const c = Math.round(p), g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100; return g >= 100 ? `${g.toLocaleString()}g` : g ? `${g}g ${s}s` : moneyText(c); };
    const priceFormat = { type: "custom", formatter: axis, minMove: 1 };
    series.qty = chart.addHistogramSeries({ priceScaleId: "vol", color: SERIES[3].color, priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    series.sold = chart.addHistogramSeries({ priceScaleId: "vol", color: SERIES[4].color, priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.76, bottom: 0 } });
    series.mean = chart.addLineSeries({ color: SERIES[2].color, lineWidth: 1, lineStyle: 2, priceFormat, priceLineVisible: false });
    series.median = chart.addLineSeries({ color: SERIES[1].color, lineWidth: 2, priceFormat, priceLineVisible: false });
    series.min = chart.addLineSeries({ color: SERIES[0].color, lineWidth: 2, priceFormat });
    for (const s of SERIES) series[s.key].applyOptions({ visible: !!visible[s.key] });

    const tip = $("#i-tip");
    chart.subscribeCrosshairMove((param) => {
      const p = param.time != null && byTime.get(param.time);
      if (!p) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.innerHTML = `<div class="t">${new Date(p.t).toLocaleString()}</div>
        ${p.min_price != null ? `<div class="kv"><span style="color:${SERIES[0].color}">Min</span>${money(p.min_price)}</div>
        <div class="kv"><span style="color:${SERIES[1].color}">Median</span>${money(p.median_price)}</div>
        <div class="kv"><span style="color:${SERIES[2].color}">Mean</span>${money(p.mean_price)}</div>` : `<div class="faint">Not listed</div>`}
        <div class="kv"><span class="muted">Listed</span><span class="num">${fmt(p.qty)}</span></div>
        ${p.sold != null ? `<div class="kv"><span style="color:${SERIES[4].color}">Est. sold</span><span class="num">${fmt(p.sold)}</span></div>` : ""}`;
    });
  } else {
    $("#i-empty").hidden = false;
    $("#i-empty").textContent = "Chart library failed to load (needs internet access to unpkg.com).";
  }

  async function loadHistory() {
    const data = await api(`/api/item/${id}/history?house=${house}&days=${days}`);
    const pts = data.points;
    // lightweight-charts renders in UTC, so shift timestamps into local time.
    const t = (ms) => Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60;
    byTime = new Map(pts.map((p) => [t(p.t), p]));
    if (chart) {
      const line = (k) => pts.map((p) => (p[k] != null ? { time: t(p.t), value: p[k] } : { time: t(p.t) }));
      series.min.setData(line("min_price"));
      series.median.setData(line("median_price"));
      series.mean.setData(line("mean_price"));
      series.qty.setData(pts.map((p) => ({ time: t(p.t), value: p.qty })));
      series.sold.setData(pts.map((p) => (p.sold != null ? { time: t(p.t), value: p.sold } : { time: t(p.t) })));
      const sparse = pts.length < 40;
      for (const k of ["min", "median", "mean"]) series[k].applyOptions({ pointMarkersVisible: sparse });
      chart.timeScale().fitContent();
      const empty = $("#i-empty");
      const priced = pts.filter((p) => p.min_price != null).length;
      empty.hidden = priced > 1;
      empty.innerHTML = !pts.length
        ? `This item has never been listed on ${esc(here?.label ?? "this house")}.`
        : priced <= 1
          ? `Only ${priced} snapshot with this item so far.<br><span class="faint small">The chart fills in as <code>collector.mjs --loop</code> keeps running.</span>`
          : "";
    }
    // snapshot table (newest first)
    $("#i-hist-sub").textContent = `${pts.length} snapshots${data.kind ? ` · ${data.kind}` : ""}`;
    $("#i-hist").innerHTML = pts.length
      ? pts.slice().reverse().slice(0, 200).map((p) => `<tr>
          <td>${new Date(p.t).toLocaleString()}</td>
          <td class="r">${money(p.min_price)}</td><td class="r">${money(p.median_price)}</td>
          <td class="r num">${fmt(p.qty)}</td><td class="r num">${fmt(p.auctions)}</td>
          <td class="r num">${p.sold != null ? fmt(p.sold) : "—"}</td></tr>`).join("")
      : `<tr><td colspan="6" class="faint">No snapshots in this range</td></tr>`;
  }

  $("#i-range").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    days = Number(b.dataset.days);
    store.set("range", days);
    setQuery({ range: days });
    view.querySelectorAll("#i-range button").forEach((x) => x.classList.toggle("on", x === b));
    loadHistory();
  });
  $("#i-legend").addEventListener("change", (e) => {
    const key = e.target.dataset.key;
    visible[key] = e.target.checked;
    e.target.nextElementSibling.style.opacity = e.target.checked ? "" : ".25";
    series[key]?.applyOptions({ visible: e.target.checked });
    store.set("series", visible);
  });
  $("#i-houses").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-house]");
    if (!tr) return;
    const sel = document.getElementById("house-select");
    sel.value = tr.dataset.house;
    sel.dispatchEvent(new Event("change"));
  });

  await loadHistory();
  return () => chart?.remove();
}

function stat(label, value, extra = "") {
  return `<div class="stat"><div class="label"><span>${label}</span>${extra ? `<span>${extra}</span>` : ""}</div><div class="value">${value}</div></div>`;
}

function recipeSection(title, recipes, showReagents) {
  if (!recipes?.length) return "";
  return `<div class="panel">
    <div class="panel-head"><h2>${title}</h2><span class="faint small">${recipes.length} recipe${recipes.length === 1 ? "" : "s"}</span></div>
    <div class="table-wrap"><table><tbody>
      ${recipes.map((r) => `<tr>
        <td><div class="item-cell">${r.icon ? `<img class="icon sm" src="${esc(r.icon)}" alt="">` : ""}
          <div class="meta"><a class="name" href="#/professions?p=${r.profession_id}&q=${encodeURIComponent(r.name)}">${esc(r.name)}</a>
          <span class="sub">${esc(r.profession)} · ${esc(r.category || "")}</span></div></div></td>
        <td class="wrap">${showReagents
          ? `<div class="reagents">${r.reagents.map((g) => `<a class="reagent" href="#/item/${g.id}">${itemIcon(g.id, null, "sm")}${esc(g.name)} <span class="x">×${g.quantity}</span></a>`).join("")}</div>`
          : `<span class="muted">needs ×${r.quantity}</span> ${r.crafted_item_id ? `→ <a href="#/item/${r.crafted_item_id}">${esc(r.crafted_name)}</a>` : ""}`}
        </td></tr>`).join("")}
    </tbody></table></div></div>`;
}
