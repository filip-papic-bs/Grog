import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, SNAPSHOTS_DIR } from "./paths.js";
import { normName, THEME_VOCAB, VOLATILITY_VOCAB, RTP_BANDS, MECHANIC_VOCAB } from "./trend.js";
import { loadClassifications, type Cache, type CachedGame } from "./classify-cache.js";
import { renderDashboardHtml } from "./dashboard-html.js";

export const DASHBOARD_DATA_PATH = path.join(DATA_DIR, "dashboard-data.json");
export const DASHBOARD_PATH = path.join(DATA_DIR, "dashboard.html");

// ─────────────────────────────────────────────────────────────────────────────
// The dashboard is a PURE FUNCTION of the snapshots on disk + the classification
// cache. No AI runs here (classification is cached, done once per title). Rebuild
// it any time — it just re-reads the timestamped snapshots and recomputes the
// time-series. That's the whole point: data production (AI, once) is decoupled
// from presentation (deterministic, free, repeatable).
// ─────────────────────────────────────────────────────────────────────────────

type Rail = "new" | "trending" | "originals" | "other";

interface RunGame {
  name: string;
  url: string;
  thumb?: string;
  id?: string;
  rail: Rail;
  rank: number; // position within its rail in that run (0 = top)
}
interface Run {
  casino: string;
  key: string; // snapshot dir key (lowercased)
  stamp: string;
  capturedAt: string;
  date: string; // YYYY-MM-DD
  games: RunGame[];
}

function railOf(category: string | undefined): Rail {
  const c = (category || "").toLowerCase();
  if (c.includes("original")) return "originals";
  if (c.includes("new")) return "new";
  if (c.includes("slot") || c.includes("popular") || c.includes("trend")) return "trending";
  return "other";
}

/** Read every run of every casino (full history), newest-last per casino. */
async function loadAllRuns(): Promise<Run[]> {
  const casinos = await readdir(SNAPSHOTS_DIR, { withFileTypes: true }).catch(() => []);
  const out: Run[] = [];
  for (const c of casinos) {
    if (!c.isDirectory()) continue;
    const dir = path.join(SNAPSHOTS_DIR, c.name);
    const stamps = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const stamp of stamps) {
      try {
        const snap = JSON.parse(
          await readFile(path.join(dir, stamp, "games.json"), "utf8"),
        ) as { casino: string; capturedAt: string; games: RunGame[] & { category?: string }[] };
        const rankByRail: Record<string, number> = {};
        const games: RunGame[] = (snap.games as { name: string; url: string; thumb?: string; id?: string; category?: string }[]).map(
          (g) => {
            const rail = railOf(g.category);
            const rank = rankByRail[rail] ?? 0;
            rankByRail[rail] = rank + 1;
            return { name: g.name, url: g.url, thumb: g.thumb, id: g.id, rail, rank };
          },
        );
        out.push({
          casino: snap.casino,
          key: c.name,
          stamp,
          capturedAt: snap.capturedAt,
          date: snap.capturedAt.slice(0, 10),
          games,
        });
      } catch {
        /* skip half-written snapshot */
      }
    }
  }
  return out.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

/** The latest run per casino. */
function latestPerCasino(runs: Run[]): Map<string, Run> {
  const m = new Map<string, Run>();
  for (const r of runs) {
    const prev = m.get(r.casino);
    if (!prev || r.capturedAt > prev.capturedAt) m.set(r.casino, r);
  }
  return m;
}

/** For each casino+date, keep only that casino's latest run on that date. */
function latestPerCasinoPerDate(runs: Run[]): Map<string, Map<string, Run>> {
  // date -> casino -> run
  const byDate = new Map<string, Map<string, Run>>();
  for (const r of runs) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    const m = byDate.get(r.date)!;
    const prev = m.get(r.casino);
    if (!prev || r.capturedAt > prev.capturedAt) m.set(r.casino, r);
  }
  return byDate;
}

const gid = (g: RunGame) => g.id || normName(g.name);

type Dist = { label: string; count: number; pct: number };

/** Count games by a picked label (one or many), pct of pool, sorted desc. */
function distribution(
  games: { attrs?: CachedGame }[],
  pick: (a: CachedGame) => string | string[] | undefined,
): Dist[] {
  const counts = new Map<string, number>();
  let denom = 0;
  for (const g of games) {
    if (!g.attrs) continue;
    const v = pick(g.attrs);
    const labels = Array.isArray(v) ? v : v ? [v] : [];
    if (labels.length) denom++;
    for (const l of labels) if (l) counts.set(l, (counts.get(l) || 0) + 1);
  }
  const total = denom || 1;
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count, pct: Math.round((1000 * count) / total) / 10 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

interface PooledGame {
  name: string;
  url: string;
  thumb?: string;
  casinos: string[];
  rails: Rail[];
  bestRank: number; // best (lowest) trending rank seen across casinos
  attrs?: CachedGame;
}

/** Pool a set of runs into cross-casino games (deduped by normalized name),
 * counting only the new + trending rails (the "trend signal"). */
function poolTrendGames(runs: Run[], cache: Cache): PooledGame[] {
  const byKey = new Map<string, PooledGame>();
  for (const run of runs) {
    for (const g of run.games) {
      if (g.rail !== "new" && g.rail !== "trending") continue;
      const key = normName(g.name);
      if (!key) continue;
      let e = byKey.get(key);
      if (!e) {
        e = {
          name: g.name,
          url: g.url,
          thumb: g.thumb,
          casinos: [],
          rails: [],
          bestRank: Infinity,
          attrs: cache[key],
        };
        byKey.set(key, e);
      }
      if (!e.casinos.includes(run.casino)) e.casinos.push(run.casino);
      if (!e.rails.includes(g.rail)) e.rails.push(g.rail);
      if (g.rail === "trending") e.bestRank = Math.min(e.bestRank, g.rank);
      if (!e.thumb && g.thumb) e.thumb = g.thumb;
    }
  }
  return [...byKey.values()];
}

/** A deterministic, evidence-based "why it's popular" line built from the
 * cross-casino spread + the cached attribute profile — no AI, no prose padding. */
function whyPopular(g: PooledGame): string {
  const bits: string[] = [];
  bits.push(
    g.casinos.length > 1
      ? `Trending on ${g.casinos.length} casinos (${g.casinos.join(", ")})`
      : `On ${g.casinos[0]}`,
  );
  const a = g.attrs;
  if (a) {
    const profile = [
      a.volatility ? `${a.volatility} volatility` : null,
      a.theme,
      (a.mechanics || []).slice(0, 2).join(" + ") || null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (profile) bits.push(profile);
    if (a.rtpBand) bits.push(`RTP ${a.rtpBand}`);
  }
  return bits.join(" — ");
}

// Keep stacked-area / multi-line charts legible: top-N series by total + "Other".
function topSeries(allDist: Dist[], n: number): string[] {
  return allDist.slice(0, n).map((d) => d.label);
}

export interface DashboardData {
  generatedAt: string;
  kpis: {
    gamesTracked: number;
    casinos: number;
    runs: number;
    dateFrom: string;
    dateTo: string;
    providers: number;
    themes: number;
    newThisRun: number;
    classifiedPct: number;
  };
  casinos: { name: string; key: string; latest: string; counts: Record<Rail, number> }[];
  timeline: {
    date: string;
    casinos: string[];
    poolSize: number;
    newlyAppeared: number;
    byCasinoNew: Record<string, number>;
    byCasinoTotal: Record<string, number>;
    themeShare: Record<string, number>;
    volShare: Record<string, number>;
    rtpShare: Record<string, number>;
    mechShare: Record<string, number>;
  }[];
  series: { themes: string[]; volatility: string[]; mechanics: string[]; rtp: string[] };
  current: {
    dateFrom: string;
    dateTo: string;
    poolCount: number;
    rankings: {
      themes: Dist[];
      volatility: Dist[];
      rtp: Dist[];
      mechanics: Dist[];
      providers: Dist[];
    };
    topCrossCasino: {
      name: string;
      url: string;
      thumb?: string;
      provider?: string;
      theme?: string;
      volatility?: string;
      rtp?: number | string;
      rtpBand?: string;
      mechanics?: string[];
      casinos: string[];
      casinoCount: number;
      rails: Rail[];
      why: string;
    }[];
    newThisRun: { name: string; casino: string; url: string; theme?: string; volatility?: string; provider?: string }[];
    movers: { name: string; casino: string; from: number | null; to: number; delta: number | null }[];
    byCasino: {
      casino: string;
      key: string;
      new: { name: string; url: string; theme?: string }[];
      trending: { name: string; url: string; theme?: string; rank: number }[];
      originals: { name: string; url: string }[];
    }[];
  };
  originals: {
    newAcross: { name: string; casino: string; url: string; provider?: string }[];
    totalNow: number;
    casinos: number;
    byCasino: {
      casino: string;
      key: string;
      total: number;
      prevTotal: number | null;
      prevDate: string | null;
      added: { name: string; url: string; provider?: string }[];
      removed: { name: string; url: string; provider?: string }[];
      all: { name: string; url: string; provider?: string }[];
    }[];
  };
}

export async function buildDashboardData(
  opts: { log?: (m: string) => void } = {},
): Promise<DashboardData> {
  const log = opts.log ?? (() => {});
  const runs = await loadAllRuns();
  if (!runs.length) throw new Error("no snapshots yet — run `grog run all` first");

  // NO AI here. Read the classifications the report step already produced.
  const cache = await loadClassifications(log);

  const latest = latestPerCasino(runs);
  const latestRuns = [...latest.values()];
  const pooledCurrent = poolTrendGames(latestRuns, cache);

  // ── current rankings ──
  const rankings = {
    themes: distribution(pooledCurrent, (a) => a.theme),
    volatility: distribution(pooledCurrent, (a) => a.volatility),
    rtp: distribution(pooledCurrent, (a) => a.rtpBand),
    mechanics: distribution(pooledCurrent, (a) => a.mechanics),
    providers: distribution(pooledCurrent, (a) => a.provider),
  };

  // ── top cross-casino (popularity = how many casinos it's trending on) ──
  const railRank = (rs: Rail[]) =>
    rs.includes("trending") && rs.includes("new") ? 0 : rs.includes("trending") ? 1 : 2;
  const topCrossCasino = [...pooledCurrent]
    .sort(
      (a, b) =>
        b.casinos.length - a.casinos.length ||
        railRank(a.rails) - railRank(b.rails) ||
        a.bestRank - b.bestRank ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 20)
    .map((g) => ({
      name: g.name,
      url: g.url,
      thumb: g.thumb,
      provider: g.attrs?.provider,
      theme: g.attrs?.theme,
      volatility: g.attrs?.volatility,
      rtp: g.attrs?.rtp,
      rtpBand: g.attrs?.rtpBand,
      mechanics: g.attrs?.mechanics,
      casinos: g.casinos.slice().sort(),
      casinoCount: g.casinos.length,
      rails: g.rails,
      why: whyPopular(g),
    }));

  // ── per-casino current breakdown + counts ──
  const casinos = latestRuns
    .map((r) => {
      const counts: Record<Rail, number> = { new: 0, trending: 0, originals: 0, other: 0 };
      for (const g of r.games) counts[g.rail]++;
      return { name: r.casino, key: r.key, latest: r.stamp, counts };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const byCasino = latestRuns
    .map((r) => ({
      casino: r.casino,
      key: r.key,
      new: r.games
        .filter((g) => g.rail === "new")
        .sort((a, b) => a.rank - b.rank)
        .map((g) => ({ name: g.name, url: g.url, theme: cache[normName(g.name)]?.theme })),
      trending: r.games
        .filter((g) => g.rail === "trending")
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 25)
        .map((g) => ({ name: g.name, url: g.url, theme: cache[normName(g.name)]?.theme, rank: g.rank })),
      originals: r.games
        .filter((g) => g.rail === "originals")
        .map((g) => ({ name: g.name, url: g.url })),
    }))
    .sort((a, b) => a.casino.localeCompare(b.casino));

  // ── newly appeared (latest run vs the casino's previous run) + movers ──
  const runsByCasino = new Map<string, Run[]>();
  for (const r of runs) {
    if (!runsByCasino.has(r.casino)) runsByCasino.set(r.casino, []);
    runsByCasino.get(r.casino)!.push(r);
  }
  const newThisRun: DashboardData["current"]["newThisRun"] = [];
  const movers: DashboardData["current"]["movers"] = [];
  for (const [casino, list] of runsByCasino) {
    const cur = list[list.length - 1];
    const prev = list[list.length - 2];
    const prevIds = new Set(prev ? prev.games.map(gid) : []);
    if (prev) {
      for (const g of cur.games) {
        if ((g.rail === "new" || g.rail === "trending") && !prevIds.has(gid(g))) {
          const a = cache[normName(g.name)];
          newThisRun.push({ name: g.name, casino, url: g.url, theme: a?.theme, volatility: a?.volatility, provider: a?.provider });
        }
      }
      // trending rank movers
      const prevRank = new Map(prev.games.filter((g) => g.rail === "trending").map((g) => [gid(g), g.rank]));
      for (const g of cur.games) {
        if (g.rail !== "trending" || g.rank >= 15) continue;
        const from = prevRank.has(gid(g)) ? prevRank.get(gid(g))! : null;
        const delta = from === null ? null : from - g.rank;
        if (from === null || (delta !== null && delta >= 2)) movers.push({ name: g.name, casino, from, to: g.rank, delta });
      }
    }
  }
  movers.sort((a, b) => (b.delta ?? 999) - (a.delta ?? 999)).splice(12);

  const origAttr = (g: RunGame) => {
    const a = cache[normName(g.name)];
    return { name: g.name, url: g.url, provider: a?.provider };
  };
  const originalsByCasino: DashboardData["originals"]["byCasino"] = [];
  const newOriginalsAcross: DashboardData["originals"]["newAcross"] = [];
  let originalsTotalNow = 0;
  for (const [casino, list] of runsByCasino) {
    const cur = list[list.length - 1];
    const prev = list[list.length - 2];
    const curOrig = cur.games.filter((g) => g.rail === "originals").sort((a, b) => a.rank - b.rank);
    const prevOrig = prev ? prev.games.filter((g) => g.rail === "originals") : null;
    if (!curOrig.length && !(prevOrig && prevOrig.length)) continue; // skip casinos with no originals at all
    const prevIds = new Set(prevOrig ? prevOrig.map(gid) : []);
    const curIds = new Set(curOrig.map(gid));
    const added = prevOrig ? curOrig.filter((g) => !prevIds.has(gid(g))) : [];
    const removed = prevOrig ? prevOrig.filter((g) => !curIds.has(gid(g))) : [];
    originalsTotalNow += curOrig.length;
    originalsByCasino.push({
      casino,
      key: cur.key,
      total: curOrig.length,
      prevTotal: prevOrig ? prevOrig.length : null,
      prevDate: prev ? prev.date : null,
      added: added.map(origAttr),
      removed: removed.map(origAttr),
      all: curOrig.map(origAttr),
    });
    for (const g of added) newOriginalsAcross.push({ name: g.name, casino, url: g.url, provider: cache[normName(g.name)]?.provider });
  }
  originalsByCasino.sort((a, b) => a.casino.localeCompare(b.casino));
  newOriginalsAcross.sort((a, b) => a.casino.localeCompare(b.casino) || a.name.localeCompare(b.name));

  // ── timeline (per calendar date) ──
  const byDate = latestPerCasinoPerDate(runs);
  const dates = [...byDate.keys()].sort();
  // per casino, the prior date's full game-id set, to compute newly-appeared
  const prevIdsByCasino = new Map<string, Set<string>>();
  const timeline: DashboardData["timeline"] = [];
  for (const date of dates) {
    const dayRuns = [...byDate.get(date)!.values()];
    const pooled = poolTrendGames(dayRuns, cache);
    const byCasinoNew: Record<string, number> = {};
    const byCasinoTotal: Record<string, number> = {};
    let newlyAppeared = 0;
    for (const run of dayRuns) {
      const ids = new Set(run.games.map(gid));
      byCasinoTotal[run.casino] = run.games.filter((g) => g.rail === "new" || g.rail === "trending").length;
      const prev = prevIdsByCasino.get(run.casino);
      const fresh = prev ? [...ids].filter((id) => !prev.has(id)).length : 0;
      byCasinoNew[run.casino] = fresh;
      newlyAppeared += fresh;
      prevIdsByCasino.set(run.casino, ids);
    }
    const toShare = (d: Dist[]) => Object.fromEntries(d.map((x) => [x.label, x.count]));
    timeline.push({
      date,
      casinos: dayRuns.map((r) => r.casino).sort(),
      poolSize: pooled.length,
      newlyAppeared,
      byCasinoNew,
      byCasinoTotal,
      themeShare: toShare(distribution(pooled, (a) => a.theme)),
      volShare: toShare(distribution(pooled, (a) => a.volatility)),
      rtpShare: toShare(distribution(pooled, (a) => a.rtpBand)),
      mechShare: toShare(distribution(pooled, (a) => a.mechanics)),
    });
  }

  // series order (vocab order for vol/rtp; popularity order capped for theme/mech)
  const series = {
    themes: topSeries(rankings.themes, 8),
    volatility: VOLATILITY_VOCAB.filter((v) => rankings.volatility.some((d) => d.label === v)),
    mechanics: topSeries(rankings.mechanics, 8),
    rtp: RTP_BANDS.filter((v) => rankings.rtp.some((d) => d.label === v)),
  };

  const classifiedCount = pooledCurrent.filter((g) => g.attrs).length;
  const capturedAts = runs.map((r) => r.capturedAt).sort();

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      gamesTracked: pooledCurrent.length,
      casinos: latest.size,
      runs: runs.length,
      dateFrom: capturedAts[0].slice(0, 10),
      dateTo: capturedAts[capturedAts.length - 1].slice(0, 10),
      providers: rankings.providers.length,
      themes: rankings.themes.length,
      newThisRun: newThisRun.length,
      classifiedPct: pooledCurrent.length ? Math.round((100 * classifiedCount) / pooledCurrent.length) : 0,
    },
    casinos,
    timeline,
    series,
    current: {
      dateFrom: capturedAts[0].slice(0, 10),
      dateTo: capturedAts[capturedAts.length - 1].slice(0, 10),
      poolCount: pooledCurrent.length,
      rankings,
      topCrossCasino,
      newThisRun: newThisRun.slice(0, 40),
      movers,
      byCasino,
    },
    originals: {
      newAcross: newOriginalsAcross,
      totalNow: originalsTotalNow,
      casinos: originalsByCasino.length,
      byCasino: originalsByCasino,
    },
  };
}

export async function buildDashboard(
  opts: { log?: (m: string) => void } = {},
): Promise<string> {
  const data = await buildDashboardData(opts);
  await writeFile(DASHBOARD_DATA_PATH, JSON.stringify(data, null, 2));
  await writeFile(DASHBOARD_PATH, renderDashboardHtml(data));
  return DASHBOARD_PATH;
}

// Re-export vocab so the HTML renderer can colour series consistently.
export { THEME_VOCAB, VOLATILITY_VOCAB, RTP_BANDS, MECHANIC_VOCAB };
