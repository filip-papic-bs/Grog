import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, REPORTS_DIR } from "./paths.js";
import { classifyAll, normName, type ClassifiedGame } from "./trend.js";

// ─────────────────────────────────────────────────────────────────────────────
// Classification cache — the key to cheap, stable, time-comparable data.
//
// A game's attributes (theme/volatility/mechanics/RTP/provider) don't change
// run to run, so we classify each title ONCE and keep it forever, keyed by the
// normalized name (so the same game on multiple casinos shares one record).
// Daily runs then only pay the LLM for genuinely new titles, and a game's labels
// stay byte-identical across dates — which is what makes the dashboard's
// theme-over-time / volatility-over-time series clean instead of noisy.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_PATH = path.join(DATA_DIR, "classifications.json");

// The stable, AI-derived attributes we persist per game (no pool/casino facts —
// those are recomputed per run from the snapshots, they're not intrinsic).
export interface CachedGame {
  name: string;
  provider?: string;
  theme?: string;
  colors?: string[];
  rtp?: number | string;
  rtpBand?: string;
  volatility?: string;
  bonusGames?: number;
  mechanics?: string[];
  confidence?: string;
  classifiedAt: string;
}

export type Cache = Record<string, CachedGame>; // key = normName(name)

function pickAttrs(g: ClassifiedGame, when: string): CachedGame {
  return {
    name: g.name,
    provider: g.provider,
    theme: g.theme,
    colors: g.colors,
    rtp: g.rtp,
    rtpBand: g.rtpBand,
    volatility: g.volatility,
    bonusGames: typeof g.bonusGames === "string" ? Number(g.bonusGames) : g.bonusGames,
    mechanics: g.mechanics,
    confidence: g.confidence,
    classifiedAt: when,
  };
}

export async function loadCache(): Promise<Cache> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, "utf8")) as Cache;
  } catch {
    return {};
  }
}

export async function saveCache(cache: Cache): Promise<void> {
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/** Seed the cache from every prior trend report's classified.json so we never
 * re-pay the LLM for the ~hundreds of games already classified on disk. Only
 * fills keys the cache is missing; never overwrites a newer record. Returns how
 * many entries it added. */
export async function backfillFromReports(cache: Cache): Promise<number> {
  const dirs = (await readdir(REPORTS_DIR, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && d.name.startsWith("trend_"))
    .map((d) => d.name)
    .sort(); // oldest → newest, so newer classifications win on key collisions
  let added = 0;
  for (const d of dirs) {
    let rows: ClassifiedGame[];
    try {
      rows = JSON.parse(
        await readFile(path.join(REPORTS_DIR, d, "classified.json"), "utf8"),
      );
    } catch {
      continue; // failed/incomplete report
    }
    // dir name trend_YYYY-MM-DD_HH-MM-SS → ISO-ish "YYYY-MM-DDTHH:MM:SS"
    const m = d.match(/^trend_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
    const when = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}` : new Date().toISOString();
    for (const g of rows) {
      if (!g?.name || !g.theme) continue;
      const key = normName(g.name);
      if (!key || cache[key]) continue;
      cache[key] = pickAttrs(g, when);
      added++;
    }
  }
  return added;
}

/** DASHBOARD PATH — NO AI, EVER. Just reads what the report step already
 * produced: load the cache + fold in every prior report's classified.json.
 * The dashboard is pure presentation; classification is the report's job. */
export async function loadClassifications(log?: (m: string) => void): Promise<Cache> {
  const cache = await loadCache();
  const added = await backfillFromReports(cache);
  if (added) {
    await saveCache(cache);
    log?.(`loaded classifications from reports (+${added} new)`);
  }
  return cache;
}

/** Ensure every name in `names` has a cached classification.
 * - Always backfills from prior reports first (free).
 * - If `classify` is true, sends the still-uncached names to the LLM (batched
 *   via classifyAll) and merges the results.
 * - Persists the cache. Returns the up-to-date cache.
 * Under `classify:false` (e.g. a --no-ai run) uncached names simply stay
 * unclassified; the dashboard still counts them in its deterministic metrics. */
export async function ensureClassified(
  names: string[],
  opts: { classify: boolean; log?: (m: string) => void } = { classify: true },
): Promise<Cache> {
  const log = opts.log ?? (() => {});
  const cache = await loadCache();

  const added = await backfillFromReports(cache);
  if (added) log(`cache: backfilled ${added} game(s) from prior reports`);

  // Unique by normalized key, keep first display spelling.
  const wanted = new Map<string, string>();
  for (const n of names) {
    const k = normName(n);
    if (k && !wanted.has(k)) wanted.set(k, n);
  }
  const missing = [...wanted.entries()].filter(([k]) => !cache[k]);

  log(
    `cache: ${wanted.size - missing.length}/${wanted.size} games already classified, ${missing.length} new`,
  );

  if (missing.length && opts.classify) {
    log(`classifying ${missing.length} new game(s)…`);
    const stubs = missing.map(([, name]) => ({
      name,
      url: "",
      casinos: [] as string[],
      inNew: false,
      inTrending: true,
    }));
    const classified = await classifyAll(stubs);
    const when = new Date().toISOString();
    for (const g of classified) {
      const k = normName(g.name);
      if (k && g.theme) cache[k] = pickAttrs(g, when);
    }
    await saveCache(cache);
  } else if (added) {
    await saveCache(cache); // persist the backfill even when not classifying
  }

  return cache;
}
