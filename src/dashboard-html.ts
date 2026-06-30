import { readFileSync, readdirSync } from "node:fs";
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

// Per-casino brand marks (ui/casinos/<key>.png), embedded as data URIs keyed by
// the casino's snapshot key. The whole dir is read once, so dropping in a new
// casino's logo needs no code change.
const CASINO_LOGOS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  try {
    for (const f of readdirSync(path.join(ROOT, "ui", "casinos"))) {
      const m = f.match(/^(.+)\.png$/i);
      if (m) out[m[1]] = "data:image/png;base64," + readFileSync(path.join(ROOT, "ui", "casinos", f)).toString("base64");
    }
  } catch {
    /* no casinos/ logo dir — icons just won't render */
  }
  return out;
})();

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
// view them); the only client JS is section switching + expand-to-modal. No
// external requests. Layout: fixed left rail + topbar + a strict 12-column
// bento grid so every tile lands in a predictable slot at a predictable size.
// Palette is the warm carbon/graphite base with a tuscan-sun (gold) accent.
// ─────────────────────────────────────────────────────────────────────────────

// Categorical series palette — gold-led, moderately desaturated "editorial"
// hues that stay distinct on the warm-dark surface (≥14 for casinos/themes).
const PALETTE = [
  "#f5cb5c", "#6bc6b4", "#9b8fe3", "#e98aa9", "#7fb0e8", "#9ec985",
  "#edaa6b", "#c98fd8", "#6fc9d8", "#c7cf7d", "#e88f7a", "#8aa1e2",
  "#dba0d8", "#7ac0a0",
];
const OTHER_COLOR = "#54574e";
// volatility low→high: warm green → amber → red
const VOL_COLORS = ["#86b27a", "#acc06a", "#f5cb5c", "#e89a5c", "#df6f5f"];

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

// Unique ids for per-chart <defs> gradients so multiple charts don't collide.
let _uid = 0;
const nextId = () => `gx${++_uid}`;

// ── chart geometry ──
const W = 860, H = 300, PL = 44, PR = 16, PT = 16, PB = 34;
const innerW = W - PL - PR, innerH = H - PT - PB;
const baseline = PT + innerH;
const xAt = (i: number, n: number) => (n <= 1 ? PL + innerW / 2 : PL + (innerW * i) / (n - 1));
const yAt = (v: number, max: number) => PT + innerH * (1 - v / (max || 1));

function gridY(max: number, fmt: (v: number) => string): string {
  const steps = 4;
  let out = "";
  for (let s = 0; s <= steps; s++) {
    const v = (max * s) / steps;
    const y = yAt(v, max);
    out += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" class="grid"/>`;
    out += `<text x="${PL - 10}" y="${(y + 3.5).toFixed(1)}" class="ax ax-y">${esc(fmt(Math.round(v * 10) / 10))}</text>`;
  }
  return out;
}
function xLabels(dates: string[]): string {
  const n = dates.length;
  const stride = Math.ceil(n / 8) || 1;
  return dates
    .map((d, i) =>
      i % stride === 0 || i === n - 1
        ? `<text x="${xAt(i, n).toFixed(1)}" y="${H - PB + 19}" class="ax ax-x">${esc(d.slice(5))}</text>`
        : "",
    )
    .join("");
}

/** Catmull-Rom → cubic Bézier so multi-day series read as smooth trend curves
 * (the "real app" look) rather than jagged polylines. Straight for ≤2 points. */
function smoothPath(pts: [number, number][]): string {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  if (pts.length === 2)
    return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)} L${pts[1][0].toFixed(1)},${pts[1][1].toFixed(1)}`;
  const t = 0.16;
  // A cubic Bézier stays within the convex hull of its control points, so
  // clamping control-point Y to the chart band kills Catmull-Rom overshoot
  // (e.g. a 0→17→0 series dipping below the zero line into "negative" land).
  const clampY = (y: number) => Math.max(PT, Math.min(baseline, y));
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) * t, c1y = clampY(p1[1] + (p2[1] - p0[1]) * t);
    const c2x = p2[0] - (p3[0] - p1[0]) * t, c2y = clampY(p2[1] - (p3[1] - p1[1]) * t);
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

interface Series { name: string; color: string; values: (number | null)[] }

function lineChart(dates: string[], series: Series[], fmt: (v: number) => string, area = false): string {
  const n = dates.length;
  let max = 0;
  for (const s of series) for (const v of s.values) if (v != null) max = Math.max(max, v);
  max = max <= 0 ? 1 : max * 1.12;
  const cid = nextId();
  let defs = "";
  const body = series
    .map((s, si) => {
      const pts = s.values
        .map((v, i) => (v == null ? null : [xAt(i, n), yAt(v, max)] as [number, number]))
        .filter(Boolean) as [number, number][];
      if (!pts.length) return "";
      const line = smoothPath(pts);
      const gid = `${cid}-${si}`;
      let fill = "";
      if (area) {
        defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".30"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
        const lastX = pts[pts.length - 1][0].toFixed(1);
        const firstX = pts[0][0].toFixed(1);
        fill = `<path class="ar" d="${line} L${lastX},${baseline.toFixed(1)} L${firstX},${baseline.toFixed(1)} Z" fill="url(#${gid})"/>`;
      }
      const path = `<path class="ln" d="${line}" style="stroke:${s.color}"/>`;
      const dots = s.values
        .map((v, i) =>
          v == null
            ? ""
            : `<circle cx="${xAt(i, n).toFixed(1)}" cy="${yAt(v, max).toFixed(1)}" r="2.6" class="dot" style="fill:${s.color}"><title>${esc(s.name)} · ${esc(dates[i])}: ${esc(fmt(v))}</title></circle>`,
        )
        .join("");
      return fill + path + dots;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet" role="img"><defs>${defs}</defs>${gridY(max, fmt)}${xLabels(dates)}${body}</svg>`;
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
  const cum = dates.map(() => 0);
  let svg = "";
  for (const name of seriesNames) {
    const lower = cum.slice();
    const upper = cum.map((c, i) => c + pct[name][i]);
    const top = upper.map((v, i) => [xAt(i, n), yAt(v, 100)] as [number, number]);
    const bot = lower.map((v, i) => [xAt(i, n), yAt(v, 100)] as [number, number]).reverse();
    const topPath = smoothPath(top);
    const botPath = smoothPath(bot).replace(/^M/, "L");
    svg += `<path class="sa" d="${topPath} ${botPath} Z" style="fill:${colorOf(name)}"><title>${esc(name)}</title></path>`;
    for (let i = 0; i < n; i++) cum[i] = upper[i];
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet" role="img">${gridY(100, (v) => v + "%")}${xLabels(dates)}${svg}</svg>`;
}

function barsH(items: { label: string; count: number; pct: number; color?: string }[], opts: { max?: number } = {}): string {
  if (!items.length) return `<div class="muted">No data.</div>`;
  const max = opts.max ?? Math.max(...items.map((i) => i.count), 1);
  return `<div class="bars">${items
    .map((it) => {
      const w = Math.max(2, (100 * it.count) / max);
      // Note: hex (not var(--gold)) so the `${c}cc` alpha suffix is valid CSS.
      const c = it.color || "#f5cb5c";
      return `<div class="bar-row"><div class="bar-lab" title="${esc(it.label)}">${esc(it.label)}</div><div class="bar-track"><div class="bar-fill" style="width:${w.toFixed(1)}%;background:linear-gradient(90deg,${c}cc,${c})"></div></div><div class="bar-val">${it.count}<span class="bar-pct">${it.pct}%</span></div></div>`;
    })
    .join("")}</div>`;
}

function donut(items: { label: string; count: number }[], colorOf: (l: string) => string): string {
  const total = items.reduce((a, b) => a + b.count, 0) || 1;
  const R = 66, C = 90, sw = 22;
  const circ = 2 * Math.PI * R;
  const gap = 0.012; // small visual separator between segments
  let off = 0;
  const arcs = items
    .map((it) => {
      const frac = it.count / total;
      const dash = Math.max(0, circ * (frac - gap));
      const seg = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${colorOf(it.label)}" stroke-width="${sw}" stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${C} ${C})"><title>${esc(it.label)}: ${it.count} (${Math.round(100 * frac)}%)</title></circle>`;
      off += circ * frac;
      return seg;
    })
    .join("");
  return `<svg viewBox="0 0 180 180" class="donut" preserveAspectRatio="xMidYMid meet"><circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="var(--track)" stroke-width="${sw}"/>${arcs}<text x="${C}" y="${C - 3}" class="donut-n">${total}</text><text x="${C}" y="${C + 15}" class="donut-l">games</text></svg>`;
}

function legend(items: { label: string; color: string }[]): string {
  return `<div class="legend">${items
    .map((i) => `<span class="lg"><i style="background:${i.color}"></i>${esc(i.label)}</span>`)
    .join("")}</div>`;
}

function chips(arr: string[] = [], cls = "chip"): string {
  return arr.map((m) => `<span class="${cls}">${esc(m)}</span>`).join("");
}

/** A snapshot URL is usable unless it's a slug-less placeholder
 * (e.g. Roobet's originals → ".../game/undefined") or a bare path. */
function usableUrl(url?: string): url is string {
  return !!url && !url.includes("/undefined") && !/\/$/.test(url);
}

/** Game link, but degrade to plain text when there's no usable URL. */
function glink(name: string, url?: string): string {
  return usableUrl(url)
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>`
    : `<span class="gtxt">${esc(name)}</span>`;
}

/** Like chips(), but each game is a clickable chip when it has a usable URL. */
function gameChips(items: { name: string; url?: string }[] = []): string {
  return items
    .map((g) =>
      usableUrl(g.url)
        ? `<a class="chip chip-link" href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.name)}</a>`
        : `<span class="chip">${esc(g.name)}</span>`,
    )
    .join("");
}

// Lucide-style inline stroke icons (self-contained, currentColor).
const ICONS: Record<string, string> = {
  overview: `<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/>`,
  trends: `<polyline points="3 16.5 9 10.5 13 14.5 21 6.5"/><polyline points="15 6.5 21 6.5 21 12.5"/>`,
  popular: `<polygon points="12 3 14.6 8.6 20.8 9.3 16.2 13.5 17.6 19.6 12 16.4 6.4 19.6 7.8 13.5 3.2 9.3 9.4 8.6"/>`,
  breakdowns: `<circle cx="12" cy="12" r="9"/><path d="M12 12V3"/><path d="M12 12l7.8 4.5"/>`,
  newmovers: `<line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/>`,
  originals: `<path d="M6 3h12l3 6-9 12-9-12z"/><path d="M3 9h18"/><path d="M9.5 3 7.5 9l4.5 11 4.5-11-2-6"/>`,
  casinos: `<polygon points="12 3 21 8 12 13 3 8"/><polyline points="3 13 12 18 21 13"/><polyline points="3 17 12 21.5 21 17"/>`,
  expand: `<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>`,
  close: `<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>`,
  menu: `<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>`,
};
function icon(name: string, cls = "ic"): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

interface CardOpts { sub?: string; span?: number; tall?: boolean; center?: boolean; logo?: string }
function card(title: string, body: string, opts: CardOpts = {}): string {
  const cls = ["card", opts.span ? `span-${opts.span}` : "", opts.tall ? "tall" : ""]
    .filter(Boolean)
    .join(" ");
  const lead = opts.logo ? `<img class="card-logo" src="${opts.logo}" alt=""/>` : "";
  return `<section class="${cls}" aria-label="${esc(title)}"><header><div class="ct"><h3>${lead}<span>${esc(title)}</span></h3>${opts.sub ? `<span class="card-sub">${esc(opts.sub)}</span>` : ""}</div><button class="expand" title="Expand" aria-label="Expand ${esc(title)}">${icon("expand")}</button></header><div class="card-body${opts.center ? " center" : ""}">${body}</div></section>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(d: string): string {
  const m = +d.slice(5, 7), day = +d.slice(8, 10);
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${day}` : d;
}

export function renderDashboardHtml(d: DashboardData): string {
  const themeColors = colorMap(d.series.themes);
  const mechColors = colorMap(d.series.mechanics);
  const casinoColors = casinoColorMap(d.casinos.map((c) => c.name));
  const dates = d.timeline.map((t) => t.date);
  const multiDate = dates.length >= 2;

  // Casino brand-mark helpers (logos keyed by snapshot key; callers have names).
  const keyByName = new Map(d.casinos.map((c) => [c.name, c.key]));
  const logoUriFor = (name: string): string | undefined => {
    const k = keyByName.get(name);
    return k ? CASINO_LOGOS[k] : undefined;
  };
  const clogo = (name: string): string => {
    const u = logoUriFor(name);
    return u ? `<img class="clogo" src="${u}" alt="" title="${esc(name)}" loading="lazy"/>` : "";
  };
  // name + its logo, as an inline unit (used in lists/tables/chips).
  const cName = (name: string): string => `<span class="cas">${clogo(name)}<span>${esc(name)}</span></span>`;

  // ── KPI strip ──
  const kpi = (n: string | number, l: string, sub = "", accent = false) =>
    `<div class="kpi${accent ? " kpi-ac" : ""}"><div class="kpi-n">${esc(String(n))}</div><div class="kpi-l">${esc(l)}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}</div>`;
  // NOTE: no "games tracked / in pool" KPI by design — Filip removed it
  // deliberately so the dashboard doesn't read like we re-scan the same games
  // each run. Originals total is a distinct, real catalog metric instead.
  const kpis = `<div class="kpis">
    ${kpi(d.kpis.casinos, "Casinos tracked", "competitor sites")}
    ${kpi(d.kpis.newThisRun, "New since last run", "fresh arrivals", true)}
    ${kpi(d.originals.totalNow, "Originals tracked", "in-house titles")}
    ${kpi(d.kpis.providers, "Providers seen", "studios")}
    ${kpi(d.kpis.themes, "Themes seen", "distinct genres")}
    ${kpi(d.kpis.runs, "Snapshots", "captured runs")}
  </div>`;

  const crossHot = d.current.topCrossCasino.filter((g) => g.casinoCount > 1);
  const crossBars = barsH(
    crossHot.slice(0, 11).map((g) => ({ label: g.name, count: g.casinoCount, pct: Math.round((100 * g.casinoCount) / d.kpis.casinos) })),
    { max: d.kpis.casinos },
  );

  const themeDonut =
    d.current.rankings.themes.length
      ? `<div class="donut-wrap">${donut(d.current.rankings.themes.slice(0, 8), (l) => themeColors.get(l) || OTHER_COLOR)}${legend(d.current.rankings.themes.slice(0, 8).map((r) => ({ label: r.label, color: themeColors.get(r.label) || OTHER_COLOR })))}</div>`
      : `<div class="muted">No classified games yet.</div>`;

  const volBars = barsH(d.current.rankings.volatility.map((r) => ({ ...r, color: volColor(r.label) })));

  const hotCards = d.current.topCrossCasino.slice(0, 8)
    .map((g) => `<div class="hot">
        ${g.thumb ? `<img src="${esc(g.thumb)}" alt="" loading="lazy"/>` : `<div class="noimg">${icon("originals", "ic-lg")}</div>`}
        <div class="hot-body">
          <div class="hot-top">${glink(g.name, g.url)}<span class="cc">${g.casinoCount}×</span></div>
          <div class="hot-prov">${esc(g.provider || "—")}</div>
          <div class="hot-chips">${g.theme ? `<span class="chip">${esc(g.theme)}</span>` : ""}${g.volatility ? `<span class="chip vol" style="--vc:${volColor(g.volatility)}">${esc(g.volatility)}</span>` : ""}${g.rtp ? `<span class="chip">RTP ${esc(String(g.rtp))}</span>` : ""}</div>
          <div class="hot-why">${esc(g.why)}</div>
        </div>
      </div>`)
    .join("");

  const velocityBody = multiDate
    ? lineChart(dates, d.casinos.map((c) => ({ name: c.name, color: casinoColors.get(c.name)!, values: d.timeline.map((t) => t.byCasinoNew[c.name] ?? 0) })), (v) => String(Math.round(v))) +
      legend(d.casinos.map((c) => ({ label: c.name, color: casinoColors.get(c.name)! })))
    : `<div class="empty sm">Needs ≥2 days of snapshots — currently ${dates.length}. New-release velocity appears once history builds.</div>`;

  const overview = `${kpis}<div class="bento">
    ${card("New-release velocity", velocityBody, { span: 8, tall: true, sub: "fresh games per day, by casino" })}
    ${card("Theme mix", themeDonut, { span: 4, tall: true, center: true, sub: "current pool" })}
    ${card("Cross-casino hotspots", crossHot.length ? crossBars : `<div class="empty sm">No game is trending on more than one casino yet.</div>`, { span: 6, sub: "games trending on multiple sites" })}
    ${card("Volatility mix", volBars, { span: 6, sub: "current pool" })}
    ${card("What's hot & why", `<div class="hots">${hotCards || '<div class="muted">No data.</div>'}</div>`, { span: 12, sub: "top cross-casino games + the evidence behind them" })}
  </div>`;

  // ── TRENDS OVER TIME ──
  const trends = multiDate
    ? `<div class="bento">
      ${card("Theme popularity over time", stackedArea(dates, d.series.themes, (dt) => d.timeline.find((t) => t.date === dt)!.themeShare, (l) => themeColors.get(l) || OTHER_COLOR) + legend([...d.series.themes.map((l) => ({ label: l, color: themeColors.get(l)! })), { label: "Other", color: OTHER_COLOR }]), { span: 6, tall: true, sub: "share of pool" })}
      ${card("Volatility over time", stackedArea(dates, d.series.volatility, (dt) => d.timeline.find((t) => t.date === dt)!.volShare, volColor) + legend([...d.series.volatility.map((l) => ({ label: l, color: volColor(l) })), { label: "Other", color: OTHER_COLOR }]), { span: 6, tall: true, sub: "share of pool" })}
      ${card("Mechanic adoption over time", lineChart(dates, d.series.mechanics.map((m) => ({ name: m, color: mechColors.get(m)!, values: d.timeline.map((t) => { const tot = Object.values(t.mechShare).reduce((a, b) => a + b, 0) || 1; return Math.round((1000 * (t.mechShare[m] || 0)) / tot) / 10; }) })), (v) => v + "%") + legend(d.series.mechanics.map((m) => ({ label: m, color: mechColors.get(m)! }))), { span: 6, tall: true, sub: "% of classified pool" })}
      ${card("Trend pool size over time", lineChart(dates, [{ name: "Trend pool", color: "#f5cb5c", values: d.timeline.map((t) => t.poolSize) }], (v) => String(Math.round(v)), true), { span: 6, tall: true, sub: "deduped new + trending games" })}
    </div>`
    : `<div class="empty">${icon("trends", "ic-empty")}<div><b>Time-series charts unlock with ≥2 days of snapshots.</b><br/>You currently have ${dates.length} (${esc(fmtDate(d.kpis.dateFrom))}). Run the pipeline daily and these fill in automatically — no AI needed to redraw, it just re-reads the snapshots.</div></div>`;

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
      <td><div class="cas-logos"><span class="cc">${g.casinoCount}×</span>${g.casinos.map((c) => clogo(c)).join("")}</div></td>
    </tr>`).join("")}</tbody></table></div>`;

  const popular = `<div class="bento">${card("Most popular games — cross-casino", popTable, { span: 12, sub: "ranked by how many tracked casinos feature each game" })}</div>`;

  const rankCard = (title: string, rows: { label: string; count: number; pct: number }[], colorOf: (l: string) => string, span: number) =>
    card(title, barsH(rows.slice(0, 12).map((r) => ({ ...r, color: colorOf(r.label) }))), { span, sub: "current pool" });

  // Grouped so the three long (≈12-bar) cards share a row at identical height,
  // and the two short ones pair up — no stretched-out dead space.
  const breakdowns = `<div class="bento">
      ${rankCard("Themes", d.current.rankings.themes, (l) => themeColors.get(l) || OTHER_COLOR, 4)}
      ${rankCard("Mechanics", d.current.rankings.mechanics, (l) => mechColors.get(l) || "#9b8fe3", 4)}
      ${rankCard("Providers", d.current.rankings.providers, () => "#f5cb5c", 4)}
      ${rankCard("Volatility", d.current.rankings.volatility, volColor, 6)}
      ${rankCard("RTP bands", d.current.rankings.rtp, () => "#7fb0e8", 6)}
    </div>`;

  // ── NEW & MOVERS ──
  const newByCasino = new Map<string, typeof d.current.newThisRun>();
  for (const g of d.current.newThisRun) {
    if (!newByCasino.has(g.casino)) newByCasino.set(g.casino, []);
    newByCasino.get(g.casino)!.push(g);
  }
  const newBlocks = [...newByCasino.entries()].map(([casino, gs]) =>
    card(`${casino}`, `<ul class="list">${gs.map((g) => `<li>${glink(g.name, g.url)} ${g.theme ? `<span class="chip sm">${esc(g.theme)}</span>` : ""}${g.volatility ? `<span class="chip sm vol" style="--vc:${volColor(g.volatility)}">${esc(g.volatility)}</span>` : ""}</li>`).join("")}</ul>`,
      { logo: logoUriFor(casino), sub: `${gs.length} new${gs[0]?.prevDate ? ` · since ${esc(fmtDate(gs[0].prevDate))}` : ""}` }),
  ).join("");
  // Aligned table (was a sparse space-between list with floating pills): a
  // movement pill, the game, its casino w/ logo, and now/was rank columns.
  const moversBlock = d.current.movers.length
    ? card("Trending movers", `<div class="tbl-wrap"><table class="tbl movers-tbl">
        <thead><tr><th>Move</th><th>Game</th><th>Casino</th><th>Now</th><th>Was</th></tr></thead>
        <tbody>${d.current.movers.map((m) => `<tr>
          <td class="mv-move">${m.from === null ? `<span class="pill new">NEW</span>` : `<span class="pill up">▲ ${m.delta}</span>`}</td>
          <td class="g">${glink(m.name, m.url)}</td>
          <td>${cName(m.casino)}</td>
          <td class="rk">#${m.to + 1}</td>
          <td class="mv-was">${m.from === null ? `<span class="muted">—</span>` : `#${m.from + 1}`}</td>
        </tr>`).join("")}</tbody></table></div>`, { span: 12, sub: "biggest trending-rank jumps since the previous snapshot" })
    : "";
  const newSection = newBlocks
    ? `<div class="section-head"><h2>${icon("newmovers", "ic-sm")}New arrivals by casino</h2></div><div class="masonry">${newBlocks}</div>`
    : "";
  const newmovers = (newBlocks || moversBlock)
    ? `<div class="bento">${moversBlock}</div>${newSection}`
    : `<div class="empty">${icon("newmovers", "ic-empty")}<div><b>No prior snapshot to diff against yet.</b><br/>Run again tomorrow and new arrivals + movers show here.</div></div>`;

  // ── ORIGINALS ──
  const o = d.originals;
  const newOrigTop = o.newAcross.length
    ? card(
        `New originals`,
        `<div class="hots">${o.newAcross
          .map(
            (g) => `<div class="hot compact"><div class="hot-body">
              <div class="hot-top">${glink(g.name, g.url)}${cName(g.casino)}</div>
              ${g.provider ? `<div class="hot-prov">${esc(g.provider)}</div>` : ""}
            </div></div>`,
          )
          .join("")}</div>`,
        { span: 12, sub: `${o.newAcross.length} in-house titles added since the last report` },
      )
    : card("New originals", `<div class="empty sm">No new originals since the last report. Added games appear here once a casino ships a new in-house title between snapshots.</div>`, { span: 12 });

  const origDelta = (d2: number) =>
    d2 === 0
      ? `<span class="pill flat">±0</span>`
      : d2 > 0
        ? `<span class="pill up">▲ ${d2}</span>`
        : `<span class="pill down">▼ ${Math.abs(d2)}</span>`;

  const origCards = o.byCasino
    .map((c) => {
      const delta = c.prevTotal === null ? null : c.total - c.prevTotal;
      const head = `<div class="counts">
        <span><b>${c.total}</b> originals</span>
        ${c.prevTotal !== null ? `<span class="muted">was ${c.prevTotal}</span>${origDelta(delta!)}` : `<span class="muted">no prior report</span>`}
      </div>`;
      const addedBlock = c.added.length
        ? `<h4 class="add">＋ Added (${c.added.length})</h4><ul class="list">${c.added
            .map((g) => `<li>${glink(g.name, g.url)}${g.provider ? ` <span class="chip sm">${esc(g.provider)}</span>` : ""}</li>`)
            .join("")}</ul>`
        : "";
      const removedBlock = c.removed.length
        ? `<h4 class="rem">－ Removed (${c.removed.length})</h4><ul class="list muted">${c.removed
            .map((g) => `<li>${glink(g.name, g.url)}</li>`)
            .join("")}</ul>`
        : "";
      const noChange =
        c.prevTotal !== null && !c.added.length && !c.removed.length
          ? `<div class="muted mt">No change since last report.</div>`
          : "";
      const allBlock = `<h4>All originals (${c.all.length})</h4><div class="hot-chips">${gameChips(c.all) || '<span class="muted">—</span>'}</div>`;
      return card(c.casino, `${head}${addedBlock}${removedBlock}${noChange}${allBlock}`, { logo: logoUriFor(c.casino), sub: c.prevDate ? `now vs ${esc(fmtDate(c.prevDate))}` : "latest only" });
    })
    .join("");

  const originalsTab = `<div class="bento">${newOrigTop}</div><div class="section-head"><h2>${icon("originals", "ic-sm")}Originals by casino</h2></div><div class="masonry">${origCards || `<div class="empty sm">No casino exposes an originals rail yet.</div>`}</div>`;

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
      ${c.originals.length ? `<h4>Originals</h4><div class="hot-chips">${gameChips(c.originals)}</div>` : ""}
    `, { logo: logoUriFor(c.casino), sub: `latest ${esc(cc.latest.slice(0, 10))}` });
  }).join("");
  const casinosTab = `<div class="masonry">${casinoCards}</div>`;

  const TABS = [
    ["overview", "Overview", "At-a-glance command center", overview],
    ["trends", "Trends over time", "How the market is shifting", trends],
    ["popular", "Most popular", "Cross-casino game leaderboard", popular],
    ["breakdowns", "Breakdowns", "Distribution of the current pool", breakdowns],
    ["newmovers", "New & movers", "What changed since last snapshot", newmovers],
    ["originals", "Originals", "In-house titles by casino", originalsTab],
    ["casinos", "Casinos", "Per-competitor detail", casinosTab],
  ] as const;

  const snap = esc(d.generatedAt.replace("T", " ").slice(0, 16));
  const range = `${fmtDate(d.current.dateFrom)} – ${fmtDate(d.current.dateTo)}, ${d.current.dateTo.slice(0, 4)}`;
  const casinoNames = [...d.casinos.map((c) => c.name)].sort((a, b) => a.localeCompare(b));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Grog · Casino Trend Radar</title>
${FAVICON_URI ? `<link rel="icon" type="image/png" href="${FAVICON_URI}"/>` : ""}
<style>${FONT_FACE}${CSS}</style></head>
<body>
<div class="shell">
  <aside class="side" id="side">
    <div class="side-top">
      <div class="brand">
        ${LOGO_URI ? `<img class="logo" src="${LOGO_URI}" alt="Grog"/>` : `<span class="logo">🏴‍☠️</span>`}
        <div class="brand-tag"><span class="bt-main">GROG</span><span class="bt-sub">Trend Radar</span></div>
      </div>
      <button class="hamburger" id="hamburger" aria-label="Toggle menu" aria-expanded="false">${icon("menu", "ic ic-menu")}${icon("close", "ic ic-x")}</button>
    </div>
    <nav class="nav" id="nav" aria-label="Sections">
      ${TABS.map(([id, label], i) => `<button class="nav-item${i === 0 ? " active" : ""}" data-tab="${id}" data-label="${esc(label)}" data-desc="${esc(TABS[i][2])}">${icon(id)}<span>${esc(label)}</span></button>`).join("")}
    </nav>
    <div class="side-foot">
      <div class="sf-row"><span class="sf-k">Casinos</span><span class="sf-v">${d.kpis.casinos}</span></div>
      <div class="sf-row"><span class="sf-k">Snapshots</span><span class="sf-v">${d.kpis.runs}</span></div>
      <div class="sf-casinos">${casinoNames.map((n) => `<span class="chip sm logo-chip">${clogo(n)}${esc(n)}</span>`).join("")}</div>
    </div>
  </aside>
  <div class="main-col">
    <header class="topbar">
      <div class="tb-title">
        <h1 id="page-title">Overview</h1>
        <p id="page-desc">At-a-glance command center</p>
      </div>
      <div class="tb-meta">
        <div class="meta-i"><span class="k">Tracking window</span><span class="v">${esc(range)}</span></div>
        <div class="meta-i"><span class="k">Last snapshot</span><span class="v">${snap}</span></div>
        <span class="live"><i></i>Live</span>
      </div>
    </header>
    <main>${TABS.map(([id, , , html], i) => `<div class="panel${i === 0 ? " active" : ""}" id="panel-${id}">${html}</div>`).join("")}</main>
  </div>
</div>
<div id="modal" class="modal"><div class="modal-inner"><button class="modal-x" id="modal-x" title="Close (Esc)" aria-label="Close">${icon("close")}</button><div id="modal-card" class="modal-card"></div></div></div>
<script>${JS}</script>
</body></html>`;
}

const CSS = `
:root{
  --bg:#1b1b1a;--surface:#242423;--card:#2a2c29;--card-2:#313330;
  --track:#34352f;--bd:rgba(207,219,213,.10);--bd-2:rgba(207,219,213,.20);
  --tx:#e8eddf;--tx-2:#cfdbd5;--mut:#969c93;
  --gold:#f5cb5c;--gold-2:#ffd97a;--gold-deep:#caa43f;
  --green:#86b27a;--red:#df6f5f;
  --r:16px;--r-sm:10px;
}
*{box-sizing:border-box}
::selection{background:rgba(245,203,92,.28);color:#fff}
html{scrollbar-color:#3a3c39 transparent}
*::-webkit-scrollbar{height:10px;width:10px}
*::-webkit-scrollbar-thumb{background:#3a3c39;border-radius:6px}
*::-webkit-scrollbar-thumb:hover{background:#4a4c47}
*::-webkit-scrollbar-track{background:transparent}
body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.55 'Inter',ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--gold);text-decoration:none}a:hover{color:var(--gold-2);text-decoration:underline}
h1,h2,h3,h4{margin:0}

/* ── shell ── */
.shell{display:flex;min-height:100vh}
.main-col{flex:1;min-width:0;display:flex;flex-direction:column}

/* ── sidebar ── */
.side{width:250px;flex:none;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--surface);border-right:1px solid var(--bd);padding:20px 14px;gap:8px;overflow-y:auto}
.side-top{display:flex;align-items:center;justify-content:space-between;padding:6px 8px 18px;border-bottom:1px solid var(--bd);margin-bottom:8px}
.brand{display:flex;align-items:center;gap:12px}
.hamburger{display:none;width:42px;height:42px;border-radius:11px;border:1px solid var(--bd);background:rgba(207,219,213,.04);color:var(--tx);cursor:pointer;align-items:center;justify-content:center;flex:none}
.hamburger .ic{width:21px;height:21px}
.hamburger .ic-x{display:none}
.hamburger:hover{border-color:var(--gold);color:var(--gold)}
.side.open .hamburger .ic-menu{display:none}
.side.open .hamburger .ic-x{display:inline}
.logo{font-size:34px}img.logo{height:42px;width:auto;display:block;filter:drop-shadow(0 2px 8px rgba(0,0,0,.45))}
.brand-tag{display:flex;flex-direction:column;gap:1px;line-height:1.05}
.bt-main{font-weight:800;font-size:18px;letter-spacing:3px;color:var(--gold)}
.bt-sub{font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:var(--mut)}
.nav{display:flex;flex-direction:column;gap:3px;flex:1}
.nav-item{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:none;border:none;color:var(--tx-2);font-family:inherit;font-size:13.5px;font-weight:600;letter-spacing:.2px;padding:10px 12px;border-radius:10px;cursor:pointer;transition:background .15s,color .15s;position:relative}
.nav-item .ic{width:19px;height:19px;flex:none;color:var(--mut);transition:color .15s}
.nav-item:hover{background:rgba(207,219,213,.06);color:var(--tx)}
.nav-item:hover .ic{color:var(--tx-2)}
.nav-item.active{background:linear-gradient(90deg,rgba(245,203,92,.16),rgba(245,203,92,.04));color:var(--gold-2)}
.nav-item.active .ic{color:var(--gold)}
.nav-item.active::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:3px;background:var(--gold)}
.side-foot{border-top:1px solid var(--bd);padding-top:14px;margin-top:6px;display:flex;flex-direction:column;gap:8px}
.sf-row{display:flex;justify-content:space-between;align-items:center;font-size:12px}
.sf-k{color:var(--mut);text-transform:uppercase;letter-spacing:1px;font-size:10px}
.sf-v{color:var(--tx);font-weight:700;font-variant-numeric:tabular-nums}
.sf-casinos{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}

/* ── topbar ── */
.topbar{position:sticky;top:0;z-index:6;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;padding:18px 30px;background:rgba(36,36,35,.82);backdrop-filter:blur(12px);border-bottom:1px solid var(--bd)}
.tb-title h1{font-size:21px;font-weight:800;letter-spacing:.2px;color:var(--tx)}
.tb-title p{margin:3px 0 0;font-size:12.5px;color:var(--mut)}
.tb-meta{display:flex;align-items:center;gap:26px;flex-wrap:wrap}
.meta-i{display:flex;flex-direction:column;gap:2px}
.meta-i .k{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--mut)}
.meta-i .v{font-size:13px;color:var(--tx);font-weight:600;font-variant-numeric:tabular-nums}
.live{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--green);background:rgba(134,178,122,.12);border:1px solid rgba(134,178,122,.3);padding:5px 11px;border-radius:20px}
.live i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(134,178,122,.6);animation:pulse 2.4s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(134,178,122,.5)}70%{box-shadow:0 0 0 7px rgba(134,178,122,0)}100%{box-shadow:0 0 0 0 rgba(134,178,122,0)}}

main{padding:26px 30px 48px;max-width:1640px;width:100%}
.panel{display:none}.panel.active{display:block;animation:fade .22s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

/* ── KPI strip ── */
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:16px;margin-bottom:20px}
.kpi{background:linear-gradient(180deg,var(--card),var(--surface));border:1px solid var(--bd);border-radius:14px;padding:16px 18px;position:relative;overflow:hidden}
.kpi::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--gold),transparent 80%);opacity:.55}
.kpi-ac::before{opacity:1}
.kpi-ac{border-color:rgba(245,203,92,.28)}
.kpi-n{font-size:30px;font-weight:800;line-height:1.05;font-variant-numeric:tabular-nums;color:var(--tx)}
.kpi-ac .kpi-n{color:var(--gold-2)}
.kpi-l{color:var(--tx);font-size:12.5px;margin-top:6px;font-weight:600}
.kpi-sub{color:var(--mut);font-size:11px;margin-top:1px}

/* ── bento grid ── */
.bento{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:18px;margin-bottom:18px;align-items:stretch}
/* Variable-length card lists (per-casino blocks): column-packed masonry so a
   1-item card never gets stretched to a 19-item card's height. */
.masonry{column-width:330px;column-gap:18px;margin-bottom:18px}
.masonry>.card{display:block;break-inside:avoid;margin-bottom:18px;width:100%}
.span-3{grid-column:span 3}.span-4{grid-column:span 4}.span-5{grid-column:span 5}
.span-6{grid-column:span 6}.span-7{grid-column:span 7}.span-8{grid-column:span 8}
.span-9{grid-column:span 9}.span-12{grid-column:span 12}

/* ── cards ── */
.card{background:linear-gradient(180deg,var(--card),var(--surface));border:1px solid var(--bd);border-radius:var(--r);padding:18px 20px;min-width:0;display:flex;flex-direction:column;position:relative;transition:border-color .2s,box-shadow .2s,transform .2s}
.card:hover{border-color:var(--bd-2);box-shadow:0 8px 30px rgba(0,0,0,.28)}
.card.tall{min-height:380px}
.card>header{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:16px}
.ct{min-width:0;display:flex;flex-direction:column;gap:3px}
.card h3{font-size:14.5px;font-weight:700;letter-spacing:.2px;line-height:1.25;color:var(--tx);display:flex;align-items:center;gap:9px;min-width:0}
.card h3 span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-logo{width:24px;height:24px;border-radius:7px;object-fit:contain;background:#ffffff10;padding:2px;flex:none}
.card-sub{color:var(--mut);font-size:11.5px;line-height:1.35}

/* ── casino brand marks ── */
.clogo{width:18px;height:18px;border-radius:5px;object-fit:contain;background:#ffffff10;padding:1px;flex:none;vertical-align:middle}
.cas{display:inline-flex;align-items:center;gap:7px;min-width:0}
.cas>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cas-logos{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.cas-logos .clogo{width:20px;height:20px}
.logo-chip{display:inline-flex;align-items:center;gap:5px;padding-left:4px}
.logo-chip .clogo{width:15px;height:15px;border-radius:4px}
.card-body{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-start}
.card-body.center{justify-content:center}
.card h4{margin:16px 0 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:var(--gold);opacity:.92;font-weight:700}
.card h4.add{color:var(--green)}.card h4.rem{color:var(--red)}
.mt{margin-top:8px}

.expand{flex:none;width:30px;height:30px;border-radius:9px;border:1px solid var(--bd);background:rgba(207,219,213,.03);color:var(--mut);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:all .15s}
.expand .ic{width:15px;height:15px}
.expand:hover{color:var(--gold);border-color:rgba(245,203,92,.4);background:rgba(245,203,92,.08)}

/* ── section heads ── */
.section-head{display:flex;align-items:center;gap:9px;margin:26px 0 14px}
.section-head h2{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:700;letter-spacing:.2px;color:var(--tx)}
.section-head .ic-sm{width:18px;height:18px;color:var(--gold)}

/* ── charts ── */
.chart{width:100%;height:auto;display:block;flex:1}
.grid{stroke:#33352f}
.ax{fill:var(--mut);font-size:11px;font-family:'Inter',sans-serif}.ax-y{text-anchor:end}.ax-x{text-anchor:middle}
.ln{fill:none;stroke-width:2.4;stroke-linejoin:round;stroke-linecap:round}
.ar{stroke:none}
.dot{stroke:var(--card);stroke-width:1.5}
.sa{opacity:.9;stroke:var(--surface);stroke-width:.6}
.donut{width:170px;height:170px;flex:none}
.donut-n{text-anchor:middle;fill:var(--tx);font-size:25px;font-weight:800;font-family:'Inter',sans-serif}
.donut-l{text-anchor:middle;fill:var(--mut);font-size:11px;letter-spacing:1px}
.donut-wrap{display:flex;gap:20px;align-items:center;flex-wrap:wrap;justify-content:center}
.legend{display:flex;flex-wrap:wrap;gap:7px 14px;margin-top:14px}
.lg{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--tx-2)}
.lg i{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}

/* ── horizontal bars ── */
/* flex:1 + space-between: a short list (e.g. 5 volatility bands) spreads to
   fill a tile sized by a taller neighbour instead of leaving a bottom gap;
   a full list (12 bars) already fills, so spacing is unchanged. */
.bars{display:flex;flex-direction:column;gap:10px;width:100%;flex:1;justify-content:space-between;min-height:0}
.masonry .bars{flex:none;justify-content:flex-start}
.bar-row{display:grid;grid-template-columns:120px 1fr auto;gap:12px;align-items:center}
.bar-lab{font-size:12px;color:var(--tx-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{background:var(--track);border-radius:7px;height:16px;overflow:hidden}
.bar-fill{height:100%;border-radius:7px;min-width:3px;transition:width .4s ease}
.bar-val{font-size:12px;color:var(--tx);font-variant-numeric:tabular-nums;font-weight:600}
.bar-pct{color:var(--mut);margin-left:6px;font-size:11px;font-weight:400}

/* ── hot game cards ── */
.hots{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:14px;width:100%}
.hot{display:flex;gap:12px;background:var(--surface);border:1px solid var(--bd);border-radius:12px;padding:11px;transition:border-color .2s,transform .2s}
.hot:hover{border-color:var(--bd-2);transform:translateY(-2px)}
.hot.compact{padding:12px 14px}
.hot img,.hot .noimg{width:62px;height:62px;border-radius:10px;object-fit:cover;background:var(--card-2);flex:none}
.hot .noimg{display:flex;align-items:center;justify-content:center;color:var(--mut)}
.hot .noimg .ic-lg{width:26px;height:26px}
.hot-body{min-width:0;flex:1}
.hot-top{display:flex;align-items:center;gap:8px;justify-content:space-between}
.hot-top a,.hot-top .gtxt{font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hot-prov{color:var(--mut);font-size:11.5px;margin-top:2px}
.hot-chips{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 0}
.hot-why{font-size:11.5px;color:var(--tx-2);line-height:1.45;margin-top:8px}

/* ── chips / badges / pills ── */
.cc{background:linear-gradient(90deg,var(--gold-deep),var(--gold));color:#241c08;font-weight:800;border-radius:20px;padding:2px 9px;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}
.chip{display:inline-block;border:1px solid var(--bd-2);border-radius:20px;padding:2px 9px;font-size:11px;color:var(--tx-2);white-space:nowrap}
a.chip{cursor:pointer;transition:border-color .15s,color .15s}
a.chip:hover{border-color:var(--gold);color:var(--gold-2);text-decoration:none}
.chip.sm{font-size:10px;padding:1px 7px}
.chip.vol{border-color:color-mix(in srgb,var(--vc) 55%,transparent);color:var(--vc)}
.badge{display:inline-block;background:transparent;border:1px solid var(--bd);border-radius:6px;padding:1px 7px;font-size:10.5px;color:var(--mut);margin-left:3px}
.pill{display:inline-block;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:600;white-space:nowrap}
.pill.up{background:rgba(134,178,122,.16);color:#9ed18c}
.pill.down{background:rgba(223,111,95,.16);color:#ec8a7c}
.pill.flat{background:rgba(207,219,213,.08);color:var(--mut)}
.pill.new{background:rgba(155,143,227,.16);color:#b6a9ec}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}

/* ── table ── */
.tbl-wrap{overflow-x:auto;border-radius:10px;width:100%}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;color:var(--mut);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;padding:10px 12px;border-bottom:1px solid var(--bd-2);position:sticky;top:0;background:var(--card);white-space:nowrap}
.tbl td{padding:10px 12px;border-bottom:1px solid var(--bd);vertical-align:middle}
.tbl tr:last-child td{border-bottom:none}
.tbl tbody tr{transition:background .12s}
.tbl tbody tr:hover td{background:rgba(207,219,213,.04)}
.tbl .rk{color:var(--gold);font-weight:800;font-variant-numeric:tabular-nums}
.tbl .g{font-weight:600;color:var(--tx)}.tbl .g a,.tbl .g .gtxt{font-weight:600}.tbl .mech{max-width:230px}
/* movers table: tight move/rank columns, right-aligned ranks */
.movers-tbl .mv-move{width:74px}.movers-tbl .mv-move .pill{min-width:48px;text-align:center}
.movers-tbl th:nth-child(4),.movers-tbl th:nth-child(5),.movers-tbl .rk,.movers-tbl .mv-was{text-align:right;width:64px;font-variant-numeric:tabular-nums}
.movers-tbl .mv-was{color:var(--mut)}

/* ── lists ── */
.list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:7px}
.list.ol{list-style:decimal;padding-left:22px}
.list li{font-size:13px;line-height:1.5}.list.ol li{padding-left:4px}.list.ol li::marker{color:var(--mut)}
.counts{display:flex;gap:18px;color:var(--mut);font-size:13px;flex-wrap:wrap;align-items:center}
.counts b{color:var(--tx);font-size:17px;font-weight:800}

/* ── empty states ── */
.empty{display:flex;align-items:center;gap:18px;justify-content:center;text-align:left;color:var(--mut);padding:48px 28px;background:rgba(207,219,213,.02);border:1px dashed var(--bd-2);border-radius:var(--r);line-height:1.7}
.empty.sm{padding:30px 20px;font-size:13px}
.empty b{color:var(--tx-2)}
.empty .ic-empty{width:42px;height:42px;color:var(--gold);opacity:.7;flex:none}
.gtxt{color:var(--tx)}.muted{color:var(--mut)}

/* ── modal ── */
.modal{position:fixed;inset:0;background:rgba(12,12,11,.78);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;z-index:50;padding:3vh 3vw}
.modal.open{display:flex;animation:fade .15s ease}
.modal-inner{position:relative;width:min(1240px,95vw);max-height:94vh;overflow:auto;background:linear-gradient(180deg,var(--card),var(--surface));border:1px solid var(--bd-2);border-radius:18px;padding:26px 28px;box-shadow:0 40px 90px rgba(0,0,0,.6)}
.modal-x{position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:10px;border:1px solid var(--bd);background:var(--surface);color:var(--tx);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;z-index:2}
.modal-x .ic{width:17px;height:17px}
.modal-x:hover{border-color:var(--gold);color:var(--gold)}
.modal-card h3{font-size:20px}
.modal-card .chart{max-height:74vh}
.modal-card .donut{width:280px;height:280px}
.modal-card .bar-row{grid-template-columns:200px 1fr auto}
.modal-card .hots{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}

/* ── responsive ── */
@media(max-width:1280px){
  .kpis{grid-template-columns:repeat(3,1fr)}
  .span-8,.span-9,.span-7{grid-column:span 12}
  .span-4,.span-5{grid-column:span 6}
  .span-3{grid-column:span 6}
}
@media(max-width:900px){
  .shell{flex-direction:column}
  /* sidebar becomes a top bar; nav collapses behind a hamburger (a real tap
     target, not a discover-by-scrolling row) and drops down when opened. */
  .side{width:auto;height:auto;position:sticky;top:0;z-index:8;flex-direction:column;gap:0;padding:0;overflow:visible}
  .side-top{padding:10px 16px;margin:0;background:var(--surface);border-bottom:1px solid var(--bd)}
  .hamburger{display:inline-flex}
  .nav{display:none;position:absolute;top:100%;left:0;right:0;flex-direction:column;gap:3px;padding:10px;background:var(--surface);border-bottom:1px solid var(--bd);box-shadow:0 24px 48px rgba(0,0,0,.5)}
  .side.open .nav{display:flex}
  .nav-item{padding:12px 14px;font-size:14.5px}
  .nav-item .ic{width:20px;height:20px}
  .side-foot{display:none}
  .topbar{padding:14px 16px}
}
@media(max-width:760px){
  .kpis{grid-template-columns:repeat(2,1fr);gap:12px}
  .bento{grid-template-columns:1fr;gap:14px}
  [class*=span-]{grid-column:span 1}
  main{padding:18px 14px 40px}
  .tb-meta{gap:16px}
  .card.tall{min-height:0}
}
`;

const JS = `
// Mobile hamburger: toggle the nav dropdown.
var side=document.getElementById("side");
var ham=document.getElementById("hamburger");
if(ham){ham.addEventListener("click",function(){
  var open=side.classList.toggle("open");
  ham.setAttribute("aria-expanded",open?"true":"false");
});}

// Section switching (sidebar nav <-> panels) + topbar title sync.
var title=document.getElementById("page-title");
var desc=document.getElementById("page-desc");
document.querySelectorAll(".nav-item").forEach(function(btn){
  btn.addEventListener("click",function(){
    var id=btn.getAttribute("data-tab");
    document.querySelectorAll(".nav-item").forEach(function(b){b.classList.toggle("active",b===btn);});
    document.querySelectorAll(".panel").forEach(function(p){p.classList.toggle("active",p.id==="panel-"+id);});
    if(title) title.textContent=btn.getAttribute("data-label");
    if(desc) desc.textContent=btn.getAttribute("data-desc")||"";
    if(side) side.classList.remove("open");            // close the mobile menu after picking
    if(ham) ham.setAttribute("aria-expanded","false");
    window.scrollTo({top:0,behavior:"smooth"});
  });
});

// Expand any card to a fullscreen modal.
var modal=document.getElementById("modal");
var modalCard=document.getElementById("modal-card");
function openModal(card){
  var clone=card.cloneNode(true);
  var ex=clone.querySelector(".expand"); if(ex) ex.remove();
  clone.style.background="none"; clone.style.border="none"; clone.style.padding="0"; clone.style.boxShadow="none";
  modalCard.innerHTML="";
  modalCard.appendChild(clone);
  modal.classList.add("open");
  document.body.style.overflow="hidden";
}
function closeModal(){ modal.classList.remove("open"); document.body.style.overflow=""; }
document.querySelectorAll(".expand").forEach(function(b){
  b.addEventListener("click",function(e){ e.stopPropagation(); openModal(b.closest(".card")); });
});
document.getElementById("modal-x").addEventListener("click",closeModal);
modal.addEventListener("click",function(e){ if(e.target===modal) closeModal(); });
document.addEventListener("keydown",function(e){ if(e.key==="Escape") closeModal(); });
`;
