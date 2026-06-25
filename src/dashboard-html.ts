import { esc } from "./analyze.js";
import type { DashboardData } from "./dashboard.js";
import { VOLATILITY_VOCAB } from "./trend.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pure renderer: DashboardData → one self-contained HTML page. All charts are
// server-rendered inline SVG (native <title> hover tooltips, no JS needed to
// view them); the only client JS is tab switching. No external requests.
// ─────────────────────────────────────────────────────────────────────────────

const PALETTE = [
  "#5eead4", "#a78bfa", "#f472b6", "#fbbf24", "#60a5fa", "#34d399",
  "#f87171", "#c084fc", "#fb923c", "#22d3ee", "#a3e635", "#e879f9",
  "#facc15", "#4ade80", "#38bdf8", "#fca5a5",
];
const OTHER_COLOR = "#475569";
// volatility low→high: green → red
const VOL_COLORS = ["#34d399", "#a3e635", "#fbbf24", "#fb923c", "#f87171"];

function colorMap(labels: string[]): Map<string, string> {
  const m = new Map<string, string>();
  labels.forEach((l, i) => m.set(l, PALETTE[i % PALETTE.length]));
  m.set("Other", OTHER_COLOR);
  return m;
}
function volColor(label: string): string {
  const i = VOLATILITY_VOCAB.indexOf(label);
  return i >= 0 ? VOL_COLORS[i] : OTHER_COLOR;
}
function casinoColorMap(names: string[]): Map<string, string> {
  const m = new Map<string, string>();
  [...names].sort().forEach((n, i) => m.set(n, PALETTE[i % PALETTE.length]));
  return m;
}

// ── chart geometry ──
const W = 860, H = 320, PL = 46, PR = 18, PT = 18, PB = 38;
const innerW = W - PL - PR, innerH = H - PT - PB;
const xAt = (i: number, n: number) => (n <= 1 ? PL + innerW / 2 : PL + (innerW * i) / (n - 1));
const yAt = (v: number, max: number) => PT + innerH * (1 - v / (max || 1));

function gridY(max: number, fmt: (v: number) => string): string {
  const steps = 4;
  let out = "";
  for (let s = 0; s <= steps; s++) {
    const v = (max * s) / steps;
    const y = yAt(v, max);
    out += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" class="grid"/>`;
    out += `<text x="${PL - 8}" y="${(y + 3.5).toFixed(1)}" class="ax ax-y">${esc(fmt(Math.round(v * 10) / 10))}</text>`;
  }
  return out;
}
function xLabels(dates: string[]): string {
  const n = dates.length;
  // show at most ~8 labels
  const stride = Math.ceil(n / 8) || 1;
  return dates
    .map((d, i) =>
      i % stride === 0 || i === n - 1
        ? `<text x="${xAt(i, n).toFixed(1)}" y="${H - PB + 18}" class="ax ax-x">${esc(d.slice(5))}</text>`
        : "",
    )
    .join("");
}

interface Series { name: string; color: string; values: (number | null)[] }

function lineChart(dates: string[], series: Series[], fmt: (v: number) => string, area = false): string {
  const n = dates.length;
  let max = 0;
  for (const s of series) for (const v of s.values) if (v != null) max = Math.max(max, v);
  max = max <= 0 ? 1 : max * 1.1;
  const lines = series
    .map((s) => {
      const pts = s.values
        .map((v, i) => (v == null ? null : `${xAt(i, n).toFixed(1)},${yAt(v, max).toFixed(1)}`))
        .filter(Boolean) as string[];
      if (!pts.length) return "";
      const path = `<polyline class="ln" points="${pts.join(" ")}" style="stroke:${s.color}"/>`;
      const fill = area
        ? `<polygon class="ar" points="${PL},${PT + innerH} ${pts.join(" ")} ${(PL + innerW).toFixed(1)},${PT + innerH}" style="fill:${s.color}"/>`
        : "";
      const dots = s.values
        .map((v, i) =>
          v == null
            ? ""
            : `<circle cx="${xAt(i, n).toFixed(1)}" cy="${yAt(v, max).toFixed(1)}" r="3" style="fill:${s.color}"><title>${esc(s.name)} · ${esc(dates[i])}: ${esc(fmt(v))}</title></circle>`,
        )
        .join("");
      return fill + path + dots;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet" role="img">${gridY(max, fmt)}${xLabels(dates)}${lines}</svg>`;
}

/** 100%-stacked area: each date normalized to 100%. `shareFor` returns label→count. */
function stackedArea(
  dates: string[],
  names: string[],
  shareFor: (date: string) => Record<string, number>,
  colorOf: (name: string) => string,
): string {
  const n = dates.length;
  const seriesNames = [...names, "Other"];
  // pct[name][dateIdx]
  const pct: Record<string, number[]> = {};
  for (const name of seriesNames) pct[name] = [];
  dates.forEach((d) => {
    const sh = shareFor(d);
    const total = Object.values(sh).reduce((a, b) => a + b, 0) || 0;
    let selSum = 0;
    for (const name of names) {
      const p = total ? (100 * (sh[name] || 0)) / total : 0;
      pct[name].push(p);
      selSum += p;
    }
    pct["Other"].push(total ? Math.max(0, 100 - selSum) : 0);
  });
  // cumulative from bottom
  const cum = dates.map(() => 0);
  let svg = "";
  for (const name of seriesNames) {
    const lower = cum.slice();
    const upper = cum.map((c, i) => c + pct[name][i]);
    const top = upper.map((v, i) => `${xAt(i, n).toFixed(1)},${yAt(v, 100).toFixed(1)}`);
    const bot = lower.map((v, i) => `${xAt(i, n).toFixed(1)},${yAt(v, 100).toFixed(1)}`).reverse();
    svg += `<polygon class="sa" points="${top.join(" ")} ${bot.join(" ")}" style="fill:${colorOf(name)}"><title>${esc(name)}</title></polygon>`;
    for (let i = 0; i < n; i++) cum[i] = upper[i];
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet" role="img">${gridY(100, (v) => v + "%")}${xLabels(dates)}${svg}</svg>`;
}

function barsH(items: { label: string; count: number; pct: number; color?: string }[], opts: { max?: number; suffix?: string } = {}): string {
  if (!items.length) return `<div class="muted">No data.</div>`;
  const max = opts.max ?? Math.max(...items.map((i) => i.count), 1);
  return `<div class="bars">${items
    .map((it) => {
      const w = Math.max(2, (100 * it.count) / max);
      return `<div class="bar-row"><div class="bar-lab" title="${esc(it.label)}">${esc(it.label)}</div><div class="bar-track"><div class="bar-fill" style="width:${w.toFixed(1)}%;background:${it.color || "#5eead4"}"></div></div><div class="bar-val">${it.count}<span class="bar-pct">${it.pct}%</span></div></div>`;
    })
    .join("")}</div>`;
}

function donut(items: { label: string; count: number }[], colorOf: (l: string) => string): string {
  const total = items.reduce((a, b) => a + b.count, 0) || 1;
  const R = 70, C = 90, sw = 28;
  const circ = 2 * Math.PI * R;
  let off = 0;
  const arcs = items
    .map((it) => {
      const frac = it.count / total;
      const seg = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${colorOf(it.label)}" stroke-width="${sw}" stroke-dasharray="${(circ * frac).toFixed(2)} ${(circ * (1 - frac)).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${C} ${C})"><title>${esc(it.label)}: ${it.count} (${Math.round(100 * frac)}%)</title></circle>`;
      off += circ * frac;
      return seg;
    })
    .join("");
  return `<svg viewBox="0 0 180 180" class="donut" preserveAspectRatio="xMidYMid meet">${arcs}<text x="${C}" y="${C - 4}" class="donut-n">${total}</text><text x="${C}" y="${C + 14}" class="donut-l">games</text></svg>`;
}

function legend(items: { label: string; color: string }[]): string {
  return `<div class="legend">${items
    .map((i) => `<span class="lg"><i style="background:${i.color}"></i>${esc(i.label)}</span>`)
    .join("")}</div>`;
}

function chips(arr: string[] = [], cls = "chip"): string {
  return arr.map((m) => `<span class="${cls}">${esc(m)}</span>`).join("");
}

/** Game link, but degrade to plain text when the snapshot stored no usable URL
 * (e.g. Roobet's slug-less originals → ".../game/undefined"). */
function glink(name: string, url?: string): string {
  const ok = url && !url.includes("/undefined") && !/\/$/.test(url);
  return ok
    ? `<a href="${esc(url!)}" target="_blank" rel="noopener">${esc(name)}</a>`
    : `<span class="gtxt">${esc(name)}</span>`;
}

function card(title: string, body: string, sub?: string): string {
  return `<section class="card"><header><h3>${esc(title)}</h3>${sub ? `<span class="card-sub">${esc(sub)}</span>` : ""}</header>${body}</section>`;
}

export function renderDashboardHtml(d: DashboardData): string {
  const themeColors = colorMap(d.series.themes);
  const mechColors = colorMap(d.series.mechanics);
  const casinoColors = casinoColorMap(d.casinos.map((c) => c.name));
  const dates = d.timeline.map((t) => t.date);
  const multiDate = dates.length >= 2;

  // ── OVERVIEW ──
  const kpi = (n: string | number, l: string, sub = "") =>
    `<div class="kpi"><div class="kpi-n">${esc(String(n))}</div><div class="kpi-l">${esc(l)}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}</div>`;
  const kpis = `<div class="kpis">
    ${kpi(d.kpis.casinos, "Casinos tracked")}
    ${kpi(d.kpis.runs, "Snapshots")}
    ${kpi(d.kpis.newThisRun, "New since last run")}
    ${kpi(d.kpis.providers, "Providers seen")}
    ${kpi(d.kpis.themes, "Themes seen")}
  </div>`;

  const crossHot = d.current.topCrossCasino.filter((g) => g.casinoCount > 1);
  const crossBars = barsH(
    crossHot.slice(0, 12).map((g) => ({ label: g.name, count: g.casinoCount, pct: Math.round((100 * g.casinoCount) / d.kpis.casinos) })),
    { max: d.kpis.casinos, suffix: "" },
  );

  const themeDonut =
    d.current.rankings.themes.length
      ? `<div class="donut-wrap">${donut(d.current.rankings.themes.slice(0, 8), (l) => themeColors.get(l) || OTHER_COLOR)}${legend(d.current.rankings.themes.slice(0, 8).map((r) => ({ label: r.label, color: themeColors.get(r.label) || OTHER_COLOR })))}</div>`
      : `<div class="muted">No classified games yet.</div>`;

  const volBars = barsH(
    d.current.rankings.volatility.map((r) => ({ ...r, color: volColor(r.label) })),
  );

  const hotCards = d.current.topCrossCasino.slice(0, 6)
    .map((g) => `<div class="hot">
        ${g.thumb ? `<img src="${esc(g.thumb)}" alt="" loading="lazy"/>` : `<div class="noimg"></div>`}
        <div class="hot-body">
          <div class="hot-top">${glink(g.name, g.url)}<span class="cc">${g.casinoCount}×</span></div>
          <div class="hot-prov">${esc(g.provider || "—")}</div>
          <div class="hot-chips">${g.theme ? `<span class="chip">${esc(g.theme)}</span>` : ""}${g.volatility ? `<span class="chip" style="border-color:${volColor(g.volatility)}55">${esc(g.volatility)}</span>` : ""}${g.rtp ? `<span class="chip">RTP ${esc(String(g.rtp))}</span>` : ""}</div>
          <div class="hot-why">${esc(g.why)}</div>
        </div>
      </div>`)
    .join("");

  const overview = `<div class="grid">
    ${card("New-release velocity", multiDate ? lineChart(dates, d.casinos.map((c) => ({ name: c.name, color: casinoColors.get(c.name)!, values: d.timeline.map((t) => t.byCasinoNew[c.name] ?? 0) })), (v) => String(Math.round(v))) + legend(d.casinos.map((c) => ({ label: c.name, color: casinoColors.get(c.name)! }))) : `<div class="muted">Needs ≥2 days of snapshots — currently ${dates.length}. Velocity appears once history builds.</div>`, "newly-appeared games per casino, per day")}
    ${card("Theme mix (now)", themeDonut, "share of trending + new pool")}
    ${card("Cross-casino hotspots", crossHot.length ? crossBars : `<div class="muted">No game is trending on more than one casino yet.</div>`, "games trending on multiple casinos")}
    ${card("Volatility mix (now)", volBars, "share of classified pool")}
  </div>
  ${card("What's hot & why", `<div class="hots">${hotCards || '<div class="muted">No data.</div>'}</div>`, "top cross-casino games + a data-derived reason")}`;

  // ── TRENDS OVER TIME ──
  const trends = multiDate
    ? `<div class="grid">
      ${card("Theme popularity over time", stackedArea(dates, d.series.themes, (dt) => d.timeline.find((t) => t.date === dt)!.themeShare, (l) => themeColors.get(l) || OTHER_COLOR) + legend([...d.series.themes.map((l) => ({ label: l, color: themeColors.get(l)! })), { label: "Other", color: OTHER_COLOR }]), "100% stacked share by day")}
      ${card("Volatility over time", stackedArea(dates, d.series.volatility, (dt) => d.timeline.find((t) => t.date === dt)!.volShare, volColor) + legend([...d.series.volatility.map((l) => ({ label: l, color: volColor(l) })), { label: "Other", color: OTHER_COLOR }]), "100% stacked share by day")}
      ${card("Mechanic adoption over time", lineChart(dates, d.series.mechanics.map((m) => ({ name: m, color: mechColors.get(m)!, values: d.timeline.map((t) => { const tot = Object.values(t.mechShare).reduce((a, b) => a + b, 0) || 1; return Math.round((1000 * (t.mechShare[m] || 0)) / tot) / 10; }) })), (v) => v + "%") + legend(d.series.mechanics.map((m) => ({ label: m, color: mechColors.get(m)! }))), "% of pool carrying each mechanic")}
      ${card("Pool size over time", lineChart(dates, [{ name: "Trend pool", color: "#5eead4", values: d.timeline.map((t) => t.poolSize) }], (v) => String(Math.round(v)), true), "distinct trending + new games tracked")}
    </div>`
    : `<div class="empty">📈 Time-series charts unlock with ≥2 days of snapshots.<br/>You currently have <b>${dates.length}</b> (${esc(d.kpis.dateFrom)}). Run the pipeline daily and this fills in automatically — no AI needed to redraw, it just re-reads the snapshots.</div>`;

  // ── WHAT'S POPULAR ──
  const popTable = `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>#</th><th>Game</th><th>Provider</th><th>Theme</th><th>Vol.</th><th>RTP</th><th>Mechanics</th><th>Casinos</th></tr></thead>
    <tbody>${d.current.topCrossCasino.map((g, i) => `<tr>
      <td class="rk">${i + 1}</td>
      <td class="g">${glink(g.name, g.url)}</td>
      <td>${esc(g.provider || "—")}</td>
      <td>${g.theme ? `<span class="dot" style="background:${themeColors.get(g.theme) || OTHER_COLOR}"></span>${esc(g.theme)}` : "—"}</td>
      <td>${g.volatility ? `<span class="pill" style="background:${volColor(g.volatility)}22;color:${volColor(g.volatility)}">${esc(g.volatility)}</span>` : "—"}</td>
      <td>${esc(g.rtp ? String(g.rtp) : "—")}</td>
      <td class="mech">${chips((g.mechanics || []).slice(0, 4))}</td>
      <td><span class="cc">${g.casinoCount}×</span> ${chips(g.casinos, "badge")}</td>
    </tr>`).join("")}</tbody></table></div>`;

  const rankCard = (title: string, rows: { label: string; count: number; pct: number }[], colorOf: (l: string) => string) =>
    card(title, barsH(rows.slice(0, 12).map((r) => ({ ...r, color: colorOf(r.label) }))));

  const popular = `${card("Most popular games — cross-casino", popTable, `ranked by how many of ${d.kpis.casinos} casinos run it · ${esc(d.current.dateFrom)} → ${esc(d.current.dateTo)}`)}
    <div class="grid">
      ${rankCard("Themes", d.current.rankings.themes, (l) => themeColors.get(l) || OTHER_COLOR)}
      ${rankCard("Volatility", d.current.rankings.volatility, volColor)}
      ${rankCard("RTP bands", d.current.rankings.rtp, () => "#60a5fa")}
      ${rankCard("Mechanics", d.current.rankings.mechanics, (l) => mechColors.get(l) || "#a78bfa")}
      ${rankCard("Providers", d.current.rankings.providers, () => "#fbbf24")}
    </div>`;

  // ── NEW & MOVERS ──
  const newByCasino = new Map<string, typeof d.current.newThisRun>();
  for (const g of d.current.newThisRun) {
    if (!newByCasino.has(g.casino)) newByCasino.set(g.casino, []);
    newByCasino.get(g.casino)!.push(g);
  }
  const newBlocks = [...newByCasino.entries()].map(([casino, gs]) =>
    card(`${casino} — ${gs.length} new`, `<ul class="list">${gs.map((g) => `<li>${glink(g.name, g.url)} ${g.theme ? `<span class="chip sm">${esc(g.theme)}</span>` : ""}${g.volatility ? `<span class="chip sm">${esc(g.volatility)}</span>` : ""}</li>`).join("")}</ul>`),
  ).join("");
  const moversBlock = d.current.movers.length
    ? card("Trending movers", `<ul class="list">${d.current.movers.map((m) => `<li><b>${esc(m.name)}</b> <span class="muted">@ ${esc(m.casino)}</span> ${m.from === null ? `<span class="pill new">NEW to top</span>` : `<span class="pill up">▲ ${m.delta} (#${m.from + 1}→#${m.to + 1})</span>`}</li>`).join("")}</ul>`, "rank climbs vs. the previous snapshot")
    : "";
  const newmovers = (newBlocks || moversBlock)
    ? `${moversBlock}<div class="grid">${newBlocks}</div>`
    : `<div class="empty">No prior snapshot to diff against yet — run again tomorrow and new arrivals + movers show here.</div>`;

  // ── CASINOS ──
  const casinoCards = d.current.byCasino.map((c) => {
    const cc = d.casinos.find((x) => x.key === c.key)!;
    return card(c.casino, `
      <div class="counts">
        <span><b>${cc.counts.new}</b> new</span>
        <span><b>${cc.counts.trending}</b> trending</span>
        <span><b>${cc.counts.originals}</b> originals</span>
      </div>
      <h4>Top trending</h4>
      <ol class="list ol">${c.trending.slice(0, 10).map((g) => `<li>${glink(g.name, g.url)}${g.theme ? ` <span class="chip sm">${esc(g.theme)}</span>` : ""}</li>`).join("") || '<li class="muted">—</li>'}</ol>
      ${c.originals.length ? `<h4>Originals</h4><div class="hot-chips">${chips(c.originals.map((o) => o.name))}</div>` : ""}
    `, `latest ${esc(cc.latest.slice(0, 10))}`);
  }).join("");
  const casinosTab = `<div class="grid">${casinoCards}</div>`;

  const TABS = [
    ["overview", "Overview", overview],
    ["trends", "Trends over time", trends],
    ["popular", "What's popular", popular],
    ["newmovers", "New & movers", newmovers],
    ["casinos", "Casinos", casinosTab],
  ] as const;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>GROG — Slot Intelligence Dashboard</title>
<style>${CSS}</style></head>
<body>
<header class="top">
  <div class="brand"><span class="logo">🎰</span><div><h1>GROG <span>Slot Intelligence</span></h1>
  <div class="meta">${d.kpis.casinos} casinos · ${d.kpis.runs} snapshots · ${esc(d.kpis.dateFrom)} → ${esc(d.kpis.dateTo)} · generated ${esc(d.generatedAt.replace("T", " ").slice(0, 16))}</div></div></div>
  <button id="run-now" class="run-now" title="Scrape all casinos, run the AI review, and refresh — now"><span class="rn-ico">▶</span><span class="rn-txt">Run now</span></button>
</header>
${kpis}
<nav class="tabs">${TABS.map(([id, label], i) => `<button class="tab${i === 0 ? " active" : ""}" data-tab="${id}">${esc(label)}</button>`).join("")}</nav>
<main>${TABS.map(([id, , html], i) => `<div class="panel${i === 0 ? " active" : ""}" id="panel-${id}">${html}</div>`).join("")}</main>
<footer>Read-only daily view · built from <code>data/snapshots</code> + the report step's classifications · no AI runs here.</footer>
<div id="modal" class="modal"><div class="modal-inner"><button class="modal-x" id="modal-x" title="Close (Esc)">✕</button><div id="modal-card" class="modal-card"></div></div></div>
<script type="application/json" id="grog-data">${JSON.stringify(d).replace(/</g, "\\u003c")}</script>
<script>${JS}</script>
</body></html>`;
}

const CSS = `
:root{--bg:#0a0d14;--panel:#121826;--panel2:#0f1420;--bd:#1f2838;--tx:#e7ebf3;--mut:#8893a7;--ac:#5eead4;--ac2:#a78bfa}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,#16223a 0,transparent 60%),var(--bg);color:var(--tx);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}
code{background:#0e1422;padding:1px 5px;border-radius:4px;color:#9fb0c9;font-size:12px}
.top{display:flex;align-items:center;justify-content:space-between;padding:20px 28px;border-bottom:1px solid var(--bd)}
.brand{display:flex;gap:14px;align-items:center}.logo{font-size:34px}
h1{margin:0;font-size:20px;font-weight:700;letter-spacing:.3px}h1 span{background:linear-gradient(90deg,var(--ac),var(--ac2));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;font-weight:700}
.meta{color:var(--mut);font-size:12px;margin-top:3px}
.run-now{flex:none;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font:inherit;font-weight:700;font-size:13px;color:#06231f;background:linear-gradient(90deg,var(--ac),var(--ac2));border:none;border-radius:10px;padding:10px 16px;box-shadow:0 4px 16px rgba(94,234,212,.18);transition:transform .12s,box-shadow .12s,opacity .12s}
.run-now:hover{transform:translateY(-1px);box-shadow:0 6px 22px rgba(94,234,212,.28)}
.run-now:active{transform:translateY(0)}
.run-now[disabled]{cursor:default;color:var(--tx);background:#16203a;border:1px solid var(--bd);box-shadow:none}
.run-now.busy .rn-ico{animation:spin 1s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:20px 28px}
.kpi{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--bd);border-radius:14px;padding:16px 18px}
.kpi-n{font-size:30px;font-weight:800;background:linear-gradient(90deg,#fff,#b9c6df);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.kpi-l{color:var(--tx);font-size:13px;margin-top:2px;font-weight:600}.kpi-sub{color:var(--mut);font-size:11px;margin-top:2px}
.tabs{display:flex;gap:4px;padding:0 28px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:rgba(10,13,20,.85);backdrop-filter:blur(8px);z-index:5;overflow-x:auto}
.tab{background:none;border:none;color:var(--mut);font:inherit;font-weight:600;padding:14px 16px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
.tab:hover{color:var(--tx)}.tab.active{color:var(--tx);border-bottom-color:var(--ac)}
main{padding:24px 28px;max-width:1500px}
.panel{display:none}.panel.active{display:block}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:18px;margin-bottom:18px}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--bd);border-radius:16px;padding:18px;min-width:0;position:relative;transition:border-color .2s}
.card:hover{border-color:#2b3850}
.card>header{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.card h3{margin:0;font-size:15px;font-weight:700;flex:1;min-width:0}.card-sub{color:var(--mut);font-size:11px;text-align:right}
.expand{flex:none;width:26px;height:26px;border-radius:8px;border:1px solid var(--bd);background:#0e1626;color:var(--mut);cursor:pointer;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;transition:all .15s}
.expand:hover{color:var(--tx);border-color:var(--ac);background:#13203a}
.modal{position:fixed;inset:0;background:rgba(4,7,12,.78);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;z-index:50;padding:3vh 3vw}
.modal.open{display:flex;animation:fade .15s ease}
@keyframes fade{from{opacity:0}to{opacity:1}}
.modal-inner{position:relative;width:min(1200px,94vw);max-height:94vh;overflow:auto;background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--bd);border-radius:18px;padding:26px 28px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.modal-x{position:absolute;top:16px;right:16px;width:34px;height:34px;border-radius:10px;border:1px solid var(--bd);background:#0e1626;color:var(--tx);cursor:pointer;font-size:15px;z-index:2}
.modal-x:hover{border-color:var(--ac);background:#13203a}
.modal-card h3{font-size:20px}.modal-card .chart{max-height:74vh}.modal-card .donut{width:280px;height:280px}
.modal-card .bar-row{grid-template-columns:200px 1fr auto}
.card h4{margin:16px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--mut)}
.chart{width:100%;height:auto;display:block}
.grid line{stroke:#1c2536}.ax{fill:#6b7689;font-size:11px}.ax-y{text-anchor:end}.ax-x{text-anchor:middle}
.ln{fill:none;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.ar{opacity:.12}.sa{opacity:.82;stroke:#0a0d14;stroke-width:.5}
.donut{width:180px;height:180px}.donut-n{text-anchor:middle;fill:#fff;font-size:26px;font-weight:800}.donut-l{text-anchor:middle;fill:var(--mut);font-size:11px}
.donut-wrap{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:12px}
.lg{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--mut)}.lg i{width:11px;height:11px;border-radius:3px;display:inline-block}
.bars{display:flex;flex-direction:column;gap:8px}
.bar-row{display:grid;grid-template-columns:130px 1fr auto;gap:10px;align-items:center}
.bar-lab{font-size:12px;color:#c4cde0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{background:#0c1220;border-radius:6px;height:16px;overflow:hidden}
.bar-fill{height:100%;border-radius:6px;min-width:2px;transition:width .3s}
.bar-val{font-size:12px;color:#c4cde0;font-variant-numeric:tabular-nums}.bar-pct{color:var(--mut);margin-left:6px;font-size:11px}
.hots{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.hot{display:flex;gap:12px;background:#0d1422;border:1px solid var(--bd);border-radius:12px;padding:10px}
.hot img,.hot .noimg{width:64px;height:64px;border-radius:10px;object-fit:cover;background:#1a2333;flex:none}
.hot-body{min-width:0}.hot-top{display:flex;align-items:center;gap:8px}.hot-top a{font-weight:700}
.hot-prov{color:var(--mut);font-size:12px}.hot-chips{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}
.hot-why{font-size:12px;color:#aab6cb;line-height:1.4}
.cc{background:linear-gradient(90deg,var(--ac),var(--ac2));color:#06231f;font-weight:800;border-radius:20px;padding:1px 9px;font-size:11px}
.chip{display:inline-block;border:1px solid var(--bd);background:#0e1626;border-radius:20px;padding:2px 9px;font-size:11px;color:#c4cde0}
.chip.sm{font-size:10px;padding:1px 7px}.badge{display:inline-block;background:#16203200;border:1px solid var(--bd);border-radius:6px;padding:1px 6px;font-size:11px;color:var(--mut);margin-left:3px}
.tbl-wrap{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:8px 10px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:var(--panel)}
.tbl td{padding:9px 10px;border-bottom:1px solid #161e2c;vertical-align:top}
.tbl tr:hover td{background:#0e1626}
.tbl .rk{color:var(--mut);font-weight:700}.tbl .g a{font-weight:600}.tbl .mech{max-width:230px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
.pill{display:inline-block;border-radius:20px;padding:1px 9px;font-size:11px;font-weight:600}
.pill.up{background:#10331f;color:#4ade80}.pill.new{background:#2a1f3a;color:#c084fc}
.list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px}
.list.ol{list-style:decimal;padding-left:22px}.list li{font-size:13px}.list.ol li{padding-left:4px}
.counts{display:flex;gap:16px;color:var(--mut);font-size:13px}.counts b{color:var(--tx);font-size:16px}
.empty{text-align:center;color:var(--mut);padding:60px 20px;background:var(--panel2);border:1px dashed var(--bd);border-radius:16px;line-height:1.8}
.gtxt{color:var(--tx)}
.muted{color:var(--mut)}
footer{padding:24px 28px;color:var(--mut);font-size:12px;border-top:1px solid var(--bd);margin-top:20px}
`;

const JS = `
// Tab navigation.
document.querySelectorAll(".tab").forEach(function(btn){
  btn.addEventListener("click",function(){
    var id=btn.getAttribute("data-tab");
    document.querySelectorAll(".tab").forEach(function(b){b.classList.toggle("active",b===btn);});
    document.querySelectorAll(".panel").forEach(function(p){p.classList.toggle("active",p.id==="panel-"+id);});
    window.scrollTo({top:0,behavior:"smooth"});
  });
});

// Expand any card/chart to a fullscreen modal.
var modal=document.getElementById("modal");
var modalCard=document.getElementById("modal-card");
function openModal(card){
  var clone=card.cloneNode(true);
  var ex=clone.querySelector(".expand"); if(ex) ex.remove();
  clone.style.background="none"; clone.style.border="none"; clone.style.padding="0";
  modalCard.innerHTML="";
  modalCard.appendChild(clone);
  modal.classList.add("open");
  document.body.style.overflow="hidden";
}
function closeModal(){ modal.classList.remove("open"); document.body.style.overflow=""; }
document.querySelectorAll(".card > header").forEach(function(h){
  var b=document.createElement("button");
  b.className="expand"; b.title="Expand"; b.setAttribute("aria-label","Expand"); b.textContent="⤢";
  b.addEventListener("click",function(e){ e.stopPropagation(); openModal(h.parentElement); });
  h.appendChild(b);
});
document.getElementById("modal-x").addEventListener("click",closeModal);
modal.addEventListener("click",function(e){ if(e.target===modal) closeModal(); });
document.addEventListener("keydown",function(e){ if(e.key==="Escape") closeModal(); });

// "Run now" — manually trigger the scrape + AI review, then reload when done.
var runBtn=document.getElementById("run-now");
var rnIco=runBtn?runBtn.querySelector(".rn-ico"):null;
var rnTxt=runBtn?runBtn.querySelector(".rn-txt"):null;
function rnSet(busy,ico,txt){ if(!runBtn)return; runBtn.disabled=busy; runBtn.classList.toggle("busy",busy); if(rnIco)rnIco.textContent=ico; if(rnTxt)rnTxt.textContent=txt; }
function rnPoll(){
  fetch("/run/status").then(function(r){return r.json();}).then(function(s){
    if(s.running){ var secs=Math.round((s.elapsedMs||0)/1000); rnSet(true,"⟳","Running… "+secs+"s"); setTimeout(rnPoll,2000); }
    else if(s.exitCode && s.exitCode!==0){ rnSet(false,"▶","Failed — retry"); }
    else { rnSet(true,"✓","Done — reloading"); setTimeout(function(){location.reload();},700); }
  }).catch(function(){ setTimeout(rnPoll,2500); });
}
if(runBtn){
  runBtn.addEventListener("click",function(){
    rnSet(true,"⟳","Starting…");
    fetch("/run",{method:"POST"}).then(function(r){
      if(r.status===409){ rnPoll(); return; }
      if(!r.ok) throw new Error("HTTP "+r.status);
      rnPoll();
    }).catch(function(){
      rnSet(false,"▶","Run now");
      alert("Couldn't start a run. The Run button only works on the served dashboard — start it with: npm run serve");
    });
  });
}
`;
