import { readFileSync } from "node:fs";
import path from "node:path";
import { esc } from "./analyze.js";
import type { DashboardData } from "./dashboard.js";
import { VOLATILITY_VOCAB } from "./trend.js";
import { ROOT } from "./paths.js";

// Brand assets from ui/ embedded as base64 data URIs so the page stays
// self-contained (works opened as a file and when served). Read once at load.
function dataUri(file: string): string | null {
  try {
    return "data:image/png;base64," + readFileSync(path.join(ROOT, "ui", file)).toString("base64");
  } catch {
    return null;
  }
}
const LOGO_URI = dataUri("logo.png");
const FAVICON_URI = dataUri("favicon.png");

// One clean variable sans embedded so typography is identical on every viewer
// (and offline) instead of falling back to whatever the OS happens to have.
function fontUri(file: string): string | null {
  try {
    return "data:font/woff2;base64," + readFileSync(path.join(ROOT, "ui", file)).toString("base64");
  } catch {
    return null;
  }
}
const INTER_URI = fontUri("inter.woff2");
const FONT_FACE = INTER_URI
  ? `@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url(${INTER_URI}) format('woff2')}`
  : "";

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
  return `<section class="card"><header><div class="ct"><h3>${esc(title)}</h3>${sub ? `<span class="card-sub">${esc(sub)}</span>` : ""}</div></header>${body}</section>`;
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
  const casinoNames = [...d.casinos.map((c) => c.name)].sort((a, b) => a.localeCompare(b));
  const casinosKpi = `<div class="kpi kpi-wide">
    <div class="kpi-n">${d.kpis.casinos}</div>
    <div class="kpi-l">Casinos tracked</div>
    <div class="kpi-names">${casinoNames.map((n) => `<span class="chip sm">${esc(n)}</span>`).join("")}</div>
  </div>`;
  const kpis = `<div class="kpis">
    ${casinosKpi}
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

  const overview = `${kpis}<div class="grid">
    ${card("New-release velocity", multiDate ? lineChart(dates, d.casinos.map((c) => ({ name: c.name, color: casinoColors.get(c.name)!, values: d.timeline.map((t) => t.byCasinoNew[c.name] ?? 0) })), (v) => String(Math.round(v))) + legend(d.casinos.map((c) => ({ label: c.name, color: casinoColors.get(c.name)! }))) : `<div class="muted">Needs ≥2 days of snapshots — currently ${dates.length}. Velocity appears once history builds.</div>`)}
    ${card("Theme mix (now)", themeDonut)}
    ${card("Cross-casino hotspots", crossHot.length ? crossBars : `<div class="muted">No game is trending on more than one casino yet.</div>`)}
    ${card("Volatility mix (now)", volBars)}
  </div>
  ${card("What's hot & why", `<div class="hots">${hotCards || '<div class="muted">No data.</div>'}</div>`)}`;

  // ── TRENDS OVER TIME ──
  const trends = multiDate
    ? `<div class="grid">
      ${card("Theme popularity over time", stackedArea(dates, d.series.themes, (dt) => d.timeline.find((t) => t.date === dt)!.themeShare, (l) => themeColors.get(l) || OTHER_COLOR) + legend([...d.series.themes.map((l) => ({ label: l, color: themeColors.get(l)! })), { label: "Other", color: OTHER_COLOR }]))}
      ${card("Volatility over time", stackedArea(dates, d.series.volatility, (dt) => d.timeline.find((t) => t.date === dt)!.volShare, volColor) + legend([...d.series.volatility.map((l) => ({ label: l, color: volColor(l) })), { label: "Other", color: OTHER_COLOR }]))}
      ${card("Mechanic adoption over time", lineChart(dates, d.series.mechanics.map((m) => ({ name: m, color: mechColors.get(m)!, values: d.timeline.map((t) => { const tot = Object.values(t.mechShare).reduce((a, b) => a + b, 0) || 1; return Math.round((1000 * (t.mechShare[m] || 0)) / tot) / 10; }) })), (v) => v + "%") + legend(d.series.mechanics.map((m) => ({ label: m, color: mechColors.get(m)! }))))}
      ${card("Pool size over time", lineChart(dates, [{ name: "Trend pool", color: "#5eead4", values: d.timeline.map((t) => t.poolSize) }], (v) => String(Math.round(v)), true))}
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

  const popular = card("Most popular games — cross-casino", popTable);

  const breakdowns = `<div class="grid">
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
    card(`${casino} — ${gs.length} new`, `<ul class="list">${gs.map((g) => `<li>${glink(g.name, g.url)} ${g.theme ? `<span class="chip sm">${esc(g.theme)}</span>` : ""}${g.volatility ? `<span class="chip sm">${esc(g.volatility)}</span>` : ""}</li>`).join("")}</ul>`,
      gs[0]?.prevDate ? `appeared since ${esc(gs[0].prevDate)}` : undefined),
  ).join("");
  // Movers: spell out the before/after so the comparison is unambiguous.
  const moversBlock = d.current.movers.length
    ? card("Trending movers", `<ul class="list">${d.current.movers.map((m) =>
        `<li><b>${esc(m.name)}</b> <span class="muted">@ ${esc(m.casino)}</span> ${m.from === null
          ? `<span class="pill new">new to top 15</span>`
          : `<span class="pill up">▲ ${m.delta}</span> <span class="muted">now #${m.to + 1} · was #${m.from + 1}</span>`}</li>`).join("")}</ul>`)
    : "";
  const newSection = newBlocks
    ? `<div class="section-head"><h2>New arrivals by casino</h2></div><div class="grid">${newBlocks}</div>`
    : "";
  const newmovers = (newBlocks || moversBlock)
    ? `${moversBlock}${moversBlock && newSection ? `<hr class="sep"/>` : ""}${newSection}`
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

  const o = d.originals;
  const newOrigTop = o.newAcross.length
    ? card(
        `New originals — ${o.newAcross.length}`,
        `<div class="hots">${o.newAcross
          .map(
            (g) => `<div class="hot"><div class="hot-body">
              <div class="hot-top">${glink(g.name, g.url)}<span class="badge">${esc(g.casino)}</span></div>
              ${g.provider ? `<div class="hot-prov">${esc(g.provider)}</div>` : ""}
            </div></div>`,
          )
          .join("")}</div>`,
      )
    : `<div class="empty">🎲 No new originals since the last report.<br/>Added games appear here once a casino ships a new in-house title between snapshots.</div>`;

  const origDelta = (d2: number) =>
    d2 === 0
      ? `<span class="pill" style="background:#1c2536;color:var(--mut)">±0</span>`
      : d2 > 0
        ? `<span class="pill up">▲ ${d2}</span>`
        : `<span class="pill" style="background:#331f1f;color:#f87171">▼ ${Math.abs(d2)}</span>`;

  const origCards = o.byCasino
    .map((c) => {
      const delta = c.prevTotal === null ? null : c.total - c.prevTotal;
      const head = `<div class="counts">
        <span><b>${c.total}</b> originals</span>
        ${c.prevTotal !== null ? `<span class="muted">was ${c.prevTotal}</span>${origDelta(delta!)}` : `<span class="muted">no prior report</span>`}
      </div>`;
      const addedBlock = c.added.length
        ? `<h4>＋ Added (${c.added.length})</h4><ul class="list">${c.added
            .map((g) => `<li>${glink(g.name, g.url)}${g.provider ? ` <span class="chip sm">${esc(g.provider)}</span>` : ""}</li>`)
            .join("")}</ul>`
        : "";
      const removedBlock = c.removed.length
        ? `<h4>－ Removed (${c.removed.length})</h4><ul class="list muted">${c.removed
            .map((g) => `<li>${glink(g.name, g.url)}</li>`)
            .join("")}</ul>`
        : "";
      const noChange =
        c.prevTotal !== null && !c.added.length && !c.removed.length
          ? `<div class="muted" style="margin-top:8px">No change since last report.</div>`
          : "";
      const allBlock = `<h4>All originals (${c.all.length})</h4><div class="hot-chips">${chips(c.all.map((g) => g.name)) || '<span class="muted">—</span>'}</div>`;
      return card(c.casino, `${head}${addedBlock}${removedBlock}${noChange}${allBlock}`, c.prevDate ? `now vs ${esc(c.prevDate)}` : "latest only");
    })
    .join("");

  const originalsTab = `${newOrigTop}<hr class="sep"/><div class="section-head"><h2>Originals by casino</h2></div><div class="grid">${origCards || `<div class="muted">No casino exposes an originals rail yet.</div>`}</div>`;

  const TABS = [
    ["overview", "Overview", overview],
    ["trends", "Trends over time", trends],
    ["popular", "Most popular", popular],
    ["breakdowns", "Breakdowns", breakdowns],
    ["newmovers", "New & movers", newmovers],
    ["originals", "Originals", originalsTab],
    ["casinos", "Casinos", casinosTab],
  ] as const;

  const snap = esc(d.generatedAt.replace("T", " ").slice(0, 16));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Grog · Casino Trend Radar</title>
${FAVICON_URI ? `<link rel="icon" type="image/png" href="${FAVICON_URI}"/>` : ""}
<style>${FONT_FACE}${CSS}</style></head>
<body>
<header class="top">
  <div class="brand">
    ${LOGO_URI ? `<img class="logo" src="${LOGO_URI}" alt="Grog"/>` : `<span class="logo">🏴‍☠️</span>`}
    <div class="brand-tag">
      <span class="bt-main">Casino Trend Radar</span>
    </div>
  </div>
  <div class="log">
    <div class="log-item"><span class="log-k">Last Snapshot</span><span class="log-v">${snap}</span></div>
  </div>
</header>
<nav class="tabs">${TABS.map(([id, label], i) => `<button class="tab${i === 0 ? " active" : ""}" data-tab="${id}">${esc(label)}</button>`).join("")}</nav>
<main>${TABS.map(([id, , html], i) => `<div class="panel${i === 0 ? " active" : ""}" id="panel-${id}">${html}</div>`).join("")}</main>
<footer><b>Originals Games</b></footer>
<div id="modal" class="modal"><div class="modal-inner"><button class="modal-x" id="modal-x" title="Close (Esc)">✕</button><div id="modal-card" class="modal-card"></div></div></div>
<script type="application/json" id="grog-data">${JSON.stringify(d).replace(/</g, "\\u003c")}</script>
<script>${JS}</script>
</body></html>`;
}

const CSS = `
:root{--bg:#0a0e16;--panel:#121b29;--panel2:#0e1622;--bd:#243144;--bd2:#36475f;--tx:#ece4d2;--mut:#8c97ab;--gold:#e8c069;--gold2:#f4d27a;--sea:#5eead4;--ac:#e8c069;--ac2:#f4d27a}
*{box-sizing:border-box}
::selection{background:rgba(232,192,105,.28);color:#fff}
html{scrollbar-color:#2b3a4f transparent}
*::-webkit-scrollbar{height:10px;width:10px}
*::-webkit-scrollbar-thumb{background:#2b3a4f;border-radius:6px}
*::-webkit-scrollbar-thumb:hover{background:var(--bd2)}
*::-webkit-scrollbar-track{background:transparent}
body{margin:0;background:radial-gradient(1100px 520px at 86% -12%,rgba(232,192,105,.10) 0,transparent 56%),radial-gradient(1000px 600px at 6% -6%,rgba(94,234,212,.06) 0,transparent 55%),var(--bg);color:var(--tx);font:14px/1.55 'Inter',ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--sea);text-decoration:none}a:hover{color:var(--gold);text-decoration:underline}
code{background:#0e1422;padding:1px 5px;border-radius:4px;color:#9fb0c9;font-size:12px}

/* ── masthead ── */
.top{display:flex;align-items:center;justify-content:space-between;gap:20px 28px;flex-wrap:wrap;padding:18px 28px 16px;border-bottom:1px solid var(--bd);position:relative}
.top::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent,var(--gold),transparent);opacity:.45}
.brand{display:flex;gap:16px;align-items:center}.logo{font-size:38px}
img.logo{height:50px;width:auto;display:block;filter:drop-shadow(0 2px 8px rgba(0,0,0,.45))}
.brand-tag{display:flex;flex-direction:column;gap:3px;padding-left:16px;border-left:1px solid var(--bd)}
.bt-main{font-weight:700;font-size:16px;letter-spacing:2.5px;text-transform:uppercase;color:var(--gold);line-height:1.1}
.log{display:flex;gap:28px;flex-wrap:wrap}
.log-item{display:flex;flex-direction:column;gap:3px}
.log-k{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mut)}
.log-v{font-size:13px;color:var(--tx);font-weight:600;font-variant-numeric:tabular-nums}

/* ── KPIs ── */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px;align-items:start}
.kpi{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--bd);border-radius:14px;padding:16px 18px;position:relative;overflow:hidden}
.kpi::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--gold),transparent 75%);opacity:.7}
.kpi-n{font-size:30px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums;background:linear-gradient(180deg,#f7f0de,var(--gold));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.kpi-l{color:var(--tx);font-size:12px;margin-top:5px;font-weight:600;letter-spacing:.2px}.kpi-sub{color:var(--mut);font-size:11px;margin-top:2px}
.kpi-wide{grid-column:span 2}
.kpi-names{display:flex;flex-wrap:wrap;gap:5px;margin-top:11px}

/* ── tabs ── */
.tabs{display:flex;gap:2px;padding:0 22px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:rgba(10,14,22,.86);backdrop-filter:blur(10px);z-index:5;overflow-x:auto}
.tab{background:none;border:none;color:var(--mut);font-weight:600;font-size:12.5px;letter-spacing:1px;text-transform:uppercase;padding:14px 16px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;transition:color .15s}
.tab:hover{color:var(--tx)}.tab.active{color:var(--gold);border-bottom-color:var(--gold)}
main{padding:24px 28px;max-width:1500px}
.panel{display:none}.panel.active{display:block;animation:fade .2s ease}

/* ── section dividers ── */
.sep{border:none;border-top:1px solid var(--bd);margin:24px 0 20px;height:0}
.section-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 14px}
.section-head h2{margin:0;font-size:15px;font-weight:700;letter-spacing:.3px;color:var(--tx)}
.section-head .muted{font-size:12px}

/* ── cards ── */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:18px;margin-bottom:18px}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--bd);border-radius:16px;padding:18px;min-width:0;position:relative;transition:border-color .2s,box-shadow .2s}
.card:hover{border-color:var(--bd2);box-shadow:0 0 0 1px rgba(232,192,105,.06)}
.card>header{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:14px}
.ct{min-width:0;display:flex;flex-direction:column;gap:3px}
.card h3{margin:0;font-size:15px;font-weight:700;letter-spacing:.4px;line-height:1.2;color:var(--tx)}
.card-sub{color:var(--mut);font-size:11px;line-height:1.35}
.card h4{margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--gold);opacity:.9;font-weight:600}
.expand{flex:none;width:26px;height:26px;border-radius:8px;border:1px solid var(--bd);background:#0e1626;color:var(--mut);cursor:pointer;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center;transition:all .15s}
.expand:hover{color:var(--gold);border-color:var(--gold);background:#1a2233}

/* ── modal ── */
.modal{position:fixed;inset:0;background:rgba(4,7,12,.8);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;z-index:50;padding:3vh 3vw}
.modal.open{display:flex;animation:fade .15s ease}
@keyframes fade{from{opacity:0}to{opacity:1}}
.modal-inner{position:relative;width:min(1200px,94vw);max-height:94vh;overflow:auto;background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--bd2);border-radius:18px;padding:26px 28px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.modal-x{position:absolute;top:16px;right:16px;width:34px;height:34px;border-radius:10px;border:1px solid var(--bd);background:#0e1626;color:var(--tx);cursor:pointer;font-size:15px;z-index:2}
.modal-x:hover{border-color:var(--gold);background:#1a2233}
.modal-card h3{font-size:20px}.modal-card .chart{max-height:74vh}.modal-card .donut{width:280px;height:280px}
.modal-card .bar-row{grid-template-columns:200px 1fr auto}

/* ── charts ── */
.chart{width:100%;height:auto;display:block}
.grid line{stroke:#1c2738}.ax{fill:#6b7689;font-size:11px;font-family:'Inter',sans-serif}.ax-y{text-anchor:end}.ax-x{text-anchor:middle}
.ln{fill:none;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.ar{opacity:.13}.sa{opacity:.85;stroke:#0a0e16;stroke-width:.5}
.donut{width:180px;height:180px}.donut-n{text-anchor:middle;fill:#fff;font-size:26px;font-weight:800;font-family:'Inter',sans-serif}.donut-l{text-anchor:middle;fill:var(--mut);font-size:11px;letter-spacing:1px}
.donut-wrap{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:12px}
.lg{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--mut)}.lg i{width:11px;height:11px;border-radius:3px;display:inline-block}

/* ── bars ── */
.bars{display:flex;flex-direction:column;gap:8px}
.bar-row{display:grid;grid-template-columns:130px 1fr auto;gap:10px;align-items:center}
.bar-lab{font-size:12px;color:#cdd6e3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{background:#0a121e;border-radius:6px;height:16px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.02)}
.bar-fill{height:100%;border-radius:6px;min-width:2px;transition:width .3s}
.bar-val{font-size:12px;color:#cdd6e3;font-variant-numeric:tabular-nums}.bar-pct{color:var(--mut);margin-left:6px;font-size:11px}

/* ── hot cards ── */
.hots{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.hot{display:flex;gap:12px;background:#0c1421;border:1px solid var(--bd);border-radius:12px;padding:10px;transition:border-color .2s}
.hot:hover{border-color:var(--bd2)}
.hot img,.hot .noimg{width:64px;height:64px;border-radius:10px;object-fit:cover;background:#1a2333;flex:none}
.hot-body{min-width:0}.hot-top{display:flex;align-items:center;gap:8px}.hot-top a,.hot-top .gtxt{font-weight:700}
.hot-prov{color:var(--mut);font-size:12px}.hot-chips{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}
.hot-why{font-size:12px;color:#aab6cb;line-height:1.45}

/* ── chips / badges / pills ── */
.cc{background:linear-gradient(90deg,var(--gold),var(--gold2));color:#2a1d05;font-weight:800;border-radius:20px;padding:1px 9px;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.chip{display:inline-block;border:1px solid var(--bd);background:#10192600;border-radius:20px;padding:2px 9px;font-size:11px;color:#cdd6e3}
.chip.sm{font-size:10px;padding:1px 7px}.badge{display:inline-block;background:transparent;border:1px solid var(--bd);border-radius:6px;padding:1px 6px;font-size:11px;color:var(--mut);margin-left:3px}
.pill{display:inline-block;border-radius:20px;padding:1px 9px;font-size:11px;font-weight:600;white-space:nowrap}
.pill.up{background:#10331f;color:#4ade80}.pill.new{background:#2a1f3a;color:#c084fc}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}

/* ── table ── */
.tbl-wrap{overflow-x:auto;border-radius:10px}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;color:var(--mut);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;padding:9px 10px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:var(--panel);white-space:nowrap}
.tbl td{padding:9px 10px;border-bottom:1px solid #161f2d;vertical-align:top}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:#0e1828}
.tbl .rk{color:var(--gold);font-weight:700;font-variant-numeric:tabular-nums}.tbl .g a,.tbl .g .gtxt{font-weight:600}.tbl .mech{max-width:230px}

/* ── lists ── */
.list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px}
.list.ol{list-style:decimal;padding-left:22px}.list li{font-size:13px}.list.ol li{padding-left:4px}.list.ol li::marker{color:var(--mut)}
.counts{display:flex;gap:16px;color:var(--mut);font-size:13px;flex-wrap:wrap}.counts b{color:var(--tx);font-size:16px}
.empty{text-align:center;color:var(--mut);padding:60px 20px;background:var(--panel2);border:1px dashed var(--bd);border-radius:16px;line-height:1.8}
.gtxt{color:var(--tx)}.muted{color:var(--mut)}

footer{padding:22px 28px;color:var(--mut);font-size:12px;border-top:1px solid var(--bd);margin-top:26px;text-align:center}
footer b{color:var(--gold);letter-spacing:.5px}

/* ── responsive ── */
@media(max-width:680px){
  .top{padding:16px 14px;gap:16px}.brand{gap:12px}img.logo{height:42px}.brand-tag{padding-left:12px}
  .bt-main{font-size:14px;letter-spacing:2px}.log{gap:18px}
  .tabs{padding:0 8px}.tab{padding:13px 11px;font-size:11.5px}
  main{padding:18px 14px}
  .grid{grid-template-columns:1fr;gap:14px}
  .bar-row{grid-template-columns:96px 1fr auto}
}
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
`;
