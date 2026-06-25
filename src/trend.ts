import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { ROOT, SNAPSHOTS_DIR, REPORTS_DIR } from "./paths.js";
import type { Snapshot } from "./types.js";
import { loadEnv, chat, parseJsonLoose, esc, mdToHtml, aiModel, aiWeb } from "./analyze.js";


// Slots trend signal = new + trending rails. Originals are handled separately.
const TRENDING_CATS = new Set(["slots", "popular"]);
const NEW_CATS = new Set(["new-releases"]);

interface PooledGame {
  name: string;
  url: string;
  casinos: string[];
  inNew: boolean;
  inTrending: boolean;
}
interface PooledOriginal {
  name: string;
  url: string;
  casinos: string[];
}

/** Normalize a title for cross-casino matching: lowercase, strip punctuation.
 * Conservative (numbers kept) so "Sweet Bonanza" ≠ "Sweet Bonanza 1000". */
function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// `only` (casino keys, e.g. ["shuffle"]) scopes the trend pool to just those
// casinos; omit/undefined = every casino's latest snapshot.
async function latestSnapshots(only?: string[]): Promise<Snapshot[]> {
  const want = only && only.length ? new Set(only) : null;
  const casinos = await readdir(SNAPSHOTS_DIR, { withFileTypes: true }).catch(
    () => [],
  );
  const out: Snapshot[] = [];
  for (const c of casinos) {
    if (!c.isDirectory()) continue;
    if (want && !want.has(c.name)) continue;
    const dir = path.join(SNAPSHOTS_DIR, c.name);
    const runs = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const latest = runs[runs.length - 1];
    if (!latest) continue;
    try {
      out.push(
        JSON.parse(
          await readFile(path.join(dir, latest, "games.json"), "utf8"),
        ),
      );
    } catch {
      /* skip half-written snapshot */
    }
  }
  return out;
}

function poolSlots(snaps: Snapshot[]): PooledGame[] {
  const byKey = new Map<string, PooledGame>();
  for (const snap of snaps) {
    for (const g of snap.games) {
      const cat = g.category || "";
      const isNew = NEW_CATS.has(cat);
      const isTrending = TRENDING_CATS.has(cat);
      if (!isNew && !isTrending) continue;
      const key = normName(g.name);
      if (!key) continue;
      const e = byKey.get(key);
      if (e) {
        if (!e.casinos.includes(snap.casino)) e.casinos.push(snap.casino);
        e.inNew ||= isNew;
        e.inTrending ||= isTrending;
      } else {
        byKey.set(key, {
          name: g.name,
          url: g.url,
          casinos: [snap.casino],
          inNew: isNew,
          inTrending: isTrending,
        });
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      b.casinos.length - a.casinos.length || a.name.localeCompare(b.name),
  );
}

/** Originals are the same handful of in-house games re-skinned per casino
 * (Dice/Mines/Keno/Plinko…), so we dedupe by name across casinos — "Keno" on
 * three casinos is ONE entry tagged with all three. */
function poolOriginals(snaps: Snapshot[]): PooledOriginal[] {
  const byKey = new Map<string, PooledOriginal>();
  for (const snap of snaps) {
    for (const g of snap.games) {
      const cat = g.category || "";
      if (cat !== "originals" && !cat.endsWith("-originals")) continue;
      const key = normName(g.name);
      if (!key) continue;
      const e = byKey.get(key);
      if (e) {
        if (!e.casinos.includes(snap.casino)) e.casinos.push(snap.casino);
      } else {
        byKey.set(key, { name: g.name, url: g.url, casinos: [snap.casino] });
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      b.casinos.length - a.casinos.length || a.name.localeCompare(b.name),
  );
}

/** Names present in the most recent PRIOR trend report (its saved input.json),
 * so we can surface what's genuinely new since then. */
async function previousNames(): Promise<Set<string> | null> {
  const dirs = (
    await readdir(REPORTS_DIR, { withFileTypes: true }).catch(() => [])
  )
    .filter((d) => d.isDirectory() && d.name.startsWith("trend_"))
    .map((d) => d.name)
    .sort();
  // Scan newest-first for the most recent report with a parseable input.json —
  // skip failed/incomplete runs (which leave a dir but no input.json).
  for (let i = dirs.length - 1; i >= 0; i--) {
    try {
      const raw = JSON.parse(
        await readFile(path.join(REPORTS_DIR, dirs[i], "input.json"), "utf8"),
      );
      const slots = Array.isArray(raw) ? raw : raw.slots || [];
      const originals = Array.isArray(raw) ? [] : raw.originals || [];
      return new Set(
        [...slots, ...originals].map((g: { name: string }) => normName(g.name)),
      );
    } catch {
      /* no/invalid input.json — try the next-older report */
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The prompt — the product. Strict, fixed vocabularies, attribute-led (NOT
// provider-led), demands concrete actionable focus backed by real game evidence.
// ─────────────────────────────────────────────────────────────────────────────

const THEME_VOCAB = [
  "Ancient Egypt",
  "Greek Mythology",
  "Norse Mythology",
  "Other Mythology",
  "Fruit / Classic",
  "Sweets / Candy",
  "Irish / Luck",
  "Aztec / Maya",
  "Animals / Wildlife",
  "Ocean / Underwater",
  "Adventure / Exploration",
  "Horror / Dark",
  "Fantasy / Magic",
  "Sci-Fi / Space",
  "Western / Cowboy",
  "Asian / Oriental",
  "Pirates / Nautical",
  "Sports",
  "Money / Luxury / Gems",
  "Mining / Industrial",
  "Food / Drink",
  "Holiday / Festive",
  "Party / Music",
  "Crime / Heist",
];
const VOLATILITY_VOCAB = ["very low", "low", "medium", "high", "very high"];
const RTP_BANDS = [
  "< 94%",
  "94.0–95.0%",
  "95.0–96.0%",
  "96.0–96.5%",
  "96.5–97.0%",
  "97.0–98.0%",
  "≥ 98%",
];
const MECHANIC_VOCAB = [
  "tumble/cascade",
  "Megaways",
  "cluster pays",
  "ways-to-win",
  "hold & win",
  "free spins",
  "bonus buy",
  "multipliers",
  "expanding wilds",
  "walking wilds",
  "scatter pays",
  "jackpot",
  "pick bonus",
  "wheel",
];

// The model is told to use the fixed vocabularies but returns spacing variants
// ("Animals/Wildlife" vs the vocab's "Animals / Wildlife"), which otherwise count
// as separate ranking buckets and break the render's exact-label example lookup.
// Snap each returned label back to its canonical vocab form by an aggressive
// normalized key (handles slash spacing, en-dash vs hyphen, case). Unknown labels
// (e.g. "Other") pass through unchanged.
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function canon(value: string | undefined, vocab: string[]): string | undefined {
  if (!value) return value;
  const k = normKey(value);
  return vocab.find((v) => normKey(v) === k) ?? value;
}

// Classifying every pooled game AND producing rankings/top10/summary/focus in a
// SINGLE call makes the JSON output blow past max_tokens (a ~200-game pool emits
// >32k tokens), which truncates the response mid-array → invalid JSON → nothing
// usable. So classification is split into small batches that each emit valid JSON
// well under the cap, run MANY in parallel; rankings + top10 are then computed in
// code (exact, no model arithmetic), and one small final call writes only the
// analyst narrative (summary/focus/why).
//
// Coverage must be 100%, so a retry loop re-issues ONLY the games still missing
// after each pass, shrinking the batch size each round — a stubborn title that
// keeps failing inside a 15-game batch eventually gets its own 1-game call where
// it can't take others down with it.
const CLASSIFY_CONCURRENCY = 10;
// Batch size per round; the last entry repeats for any further rounds. Shrinking
// each round isolates stubborn titles down to their own 1-game call.
const CLASSIFY_ROUND_BATCHES = [15, 8, 4, 2, 1];
const CLASSIFY_MAX_ROUNDS = 8;

function railOf(g: PooledGame): string {
  return g.inNew && g.inTrending ? "both" : g.inNew ? "new" : "trending";
}

function classifySystem(): string {
  return [
    "You are a senior online-slots market analyst classifying real released slot titles for a competitive-intelligence brief.",
    "These are REAL released slots — identify the actual title and use real provider/theme/RTP/volatility/feature data, not guesses from the words.",
    "Be deterministic: identical input must yield identical classifications. Map every game onto the FIXED vocabularies given. Never invent labels.",
    "Output MUST be one valid JSON object matching the schema EXACTLY — no markdown, no code fences, no text before or after. Every field required for every object.",
  ].join(" ");
}

function classifyUser(
  batch: { i: number; name: string; casinos: string[]; rail: string }[],
): string {
  return [
    `INPUT GAMES (${batch.length} slot titles):`,
    JSON.stringify(batch),
    "",
    "Classify EVERY game using real slot data.",
    "",
    "FIXED VOCABULARIES (pick exactly one from the relevant list; never output anything outside them):",
    `- theme ∈ ${JSON.stringify(THEME_VOCAB)}. Pick the closest; use "Other" only if truly none fit.`,
    `- volatility ∈ ${JSON.stringify(VOLATILITY_VOCAB)}.`,
    `- rtpBand ∈ ${JSON.stringify(RTP_BANDS)} (from the game's real published RTP).`,
    `- mechanics ⊆ ${JSON.stringify(MECHANIC_VOCAB)} (reuse these exact strings; a game may have several).`,
    "",
    "PER-GAME RULES:",
    "- i: echo back the EXACT integer index given for the game (so it can be matched back).",
    "- name: echo the EXACT input name.",
    '- provider: real studio (e.g. "Pragmatic Play", "Hacksaw Gaming", "Nolimit City").',
    "- theme: ONE theme-vocab value from the game's actual setting/art.",
    '- colors: 2–4 dominant color words of the art (e.g. ["gold","purple"]).',
    "- rtp: real published default RTP, number one decimal (e.g. 96.5). Multi-version → headline RTP.",
    "- rtpBand: the band rtp falls into. volatility: one volatility-vocab value.",
    "- bonusGames: integer count of distinct special-mode bonus rounds (free spins, bonus-buy round, hold & spin, wheel…). 0 if none.",
    "- mechanics: array from the mechanic vocab. confidence: high (recognized exactly) | med (known series) | low (guessed). Fill every field regardless.",
    "",
    "OUTPUT — return ONLY this JSON object:",
    JSON.stringify(
      {
        games: [
          {
            i: "<int>",
            name: "<exact input title>",
            provider: "<studio>",
            theme: "<theme vocab>",
            colors: ["<color>"],
            rtp: "<number>",
            rtpBand: "<rtp band>",
            volatility: "<vol vocab>",
            bonusGames: "<int>",
            mechanics: ["<tag>"],
            confidence: "high|med|low",
          },
        ],
      },
      null,
      0,
    ),
    "",
    "Classify every input game; every games[] entry must have every field. Output valid JSON only.",
  ].join("\n");
}

function narrativeSystem(): string {
  return [
    "You are a senior online-slots market analyst writing a recurring competitive-intelligence brief for a casino operator (BitStarz).",
    "All per-game classification and aggregation is ALREADY DONE and provided to you. Do NOT reclassify games; write the analyst narrative from the given aggregated data.",
    "CRITICAL FRAMING: the operator already knows which studios are big. Do NOT make the analysis about providers/brands. Lead every narrative with GAME ATTRIBUTES — theme, volatility, mechanics, RTP, bonus structure. Provider is just one ranked dimension, never the headline.",
    "Output MUST be one valid JSON object matching the schema EXACTLY — no markdown, no code fences, no text before or after.",
  ].join(" ");
}

function narrativeUser(
  rankings: Record<string, Rank[]>,
  top10: Record<string, unknown>[],
  catalog: { name: string; theme?: string; volatility?: string; rtpBand?: string; mechanics?: string[] }[],
  total: number,
): string {
  return [
    `AGGREGATED RANKINGS (count + pct across ${total} classified slots; already computed — treat as ground truth):`,
    JSON.stringify(rankings),
    "",
    "TOP 10 cross-casino games (already ranked by how many casinos they appear on):",
    JSON.stringify(top10),
    "",
    "FULL CLASSIFIED CATALOG (use ONLY these real titles when citing example games):",
    JSON.stringify(catalog),
    "",
    'SUMMARY (2–3 sentences): lead with the dominant THEMES + VOLATILITY + MECHANICS + RTP pattern from the rankings. Example tone: "The trending mix skews Greek-mythology and sweets themes, high/very-high volatility, with tumble + free-spin/bonus-buy mechanics clustering at 96.5% RTP." Do NOT lead with or center providers.',
    "",
    "FOCUS — the most important section. 3–5 bullets of EXACTLY what the operator should focus on, each a concrete, buildable spec derived from the data, with real example titles as evidence. Each bullet MUST name: a theme + volatility + key mechanic(s) + RTP band, and cite 2–3 actual titles from the catalog that prove it. NO generic statements, NO 'studio X is popular', NO restating that a game is trending. Make it the kind of brief a slot studio could act on.",
    "",
    "whyTrending: for EACH top-10 game (keyed by its exact name), a ≤12-word attribute-focused reason it's trending.",
    "",
    "OUTPUT — return ONLY this JSON object:",
    JSON.stringify(
      {
        summary: "<attribute-led 2-3 sentences>",
        focus: [
          {
            headline: "<short imperative, attribute-led>",
            detail: "<1-2 sentences: theme+volatility+mechanic+RTP spec>",
            examples: ["<real game>", "<real game>"],
          },
        ],
        whyTrending: { "<exact top10 game name>": "<≤12 words>" },
      },
      null,
      0,
    ),
    "",
    "Output valid JSON only.",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification (chunked) + aggregation (in code).
// ─────────────────────────────────────────────────────────────────────────────

type ClassifyItem = { i: number; name: string; casinos: string[]; rail: string };

/** Resolve which pooled game a returned row refers to: trust the echoed index `i`,
 * but fall back to matching the echoed name against the batch (the model sometimes
 * drops/garbles `i` but gets the name right). Returns null if neither matches. */
function resolveIndex(x: ClassifiedGame, batch: ClassifyItem[]): number | null {
  const raw = (x as { i?: unknown }).i;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim()))
    return Number(raw.trim());
  if (typeof x.name === "string") {
    const key = normName(x.name);
    const hit = batch.find((it) => normName(it.name) === key);
    if (hit) return hit.i;
  }
  return null;
}

/** Run one wave of batches with bounded concurrency, merging classified rows into
 * `byI` by resolved index. A batch may time out or return an empty/short body that
 * classifies nothing — either way those games just don't land in `byI`; nothing
 * here aborts the run, and the caller re-issues whatever is still missing. */
async function classifyWave(
  batches: ClassifyItem[][],
  byI: Map<number, ClassifiedGame>,
): Promise<void> {
  for (let i = 0; i < batches.length; i += CLASSIFY_CONCURRENCY) {
    const group = batches.slice(i, i + CLASSIFY_CONCURRENCY);
    const results = await Promise.all(
      group.map(async (b) => {
        try {
          const raw = await chat(
            [
              { role: "system", content: classifySystem() },
              { role: "user", content: classifyUser(b) },
            ],
            {
              json: true,
              temperature: 0,
              maxTokens: 16000,
              // Flash-Lite answers a 15-game batch in a few seconds; anything that
              // hasn't returned by 60s is effectively dead — fail fast and let the
              // next round re-issue it on a fresh request.
              timeoutMs: 60_000,
              reasoning: { effort: "low" }, // no-op on non-reasoning models
            },
          );
          const games =
            (parseJsonLoose(raw) as { games?: ClassifiedGame[] }).games ?? [];
          return { batch: b, games };
        } catch (e) {
          console.log(`   ⚠ batch failed: ${e instanceof Error ? e.message : e}`);
          return { batch: b, games: [] as ClassifiedGame[] };
        }
      }),
    );
    for (const { batch, games } of results)
      for (const x of games) {
        const idx = resolveIndex(x, batch);
        if (idx !== null) byI.set(idx, { ...x, i: idx });
      }
  }
}

/** Classify every pooled slot in small batches (each a self-contained, valid-JSON
 * call) and merge the results back onto the pool by resolved index. We retry over
 * several rounds — each round only re-issues the games still missing, with a
 * SMALLER batch size — so a title that keeps failing in a big batch eventually
 * gets isolated into its own call. Coverage converges to 100%. */
async function classifyAll(slots: PooledGame[]): Promise<ClassifiedGame[]> {
  const items: ClassifyItem[] = slots.map((g, i) => ({
    i,
    name: g.name,
    casinos: g.casinos,
    rail: railOf(g),
  }));
  const byI = new Map<number, ClassifiedGame>();
  for (let round = 1; round <= CLASSIFY_MAX_ROUNDS; round++) {
    const pending = items.filter((it) => !byI.has(it.i));
    if (!pending.length) break;
    const size =
      CLASSIFY_ROUND_BATCHES[
        Math.min(round - 1, CLASSIFY_ROUND_BATCHES.length - 1)
      ];
    const batches: ClassifyItem[][] = [];
    for (let i = 0; i < pending.length; i += size)
      batches.push(pending.slice(i, i + size));
    console.log(
      round === 1
        ? `classifying ${items.length} games in ${batches.length} batch(es) of ≤${size} (concurrency ${CLASSIFY_CONCURRENCY})…`
        : `retry round ${round}: ${pending.length} game(s) still unclassified → ${batches.length} batch(es) of ≤${size}…`,
    );
    const before = byI.size;
    await classifyWave(batches, byI);
    console.log(`   …${byI.size}/${items.length} classified`);
    // A whole round that recovered nothing won't do better next time — stop.
    if (byI.size === before) break;
  }
  const missing = items.length - byI.size;
  if (missing)
    console.log(
      `   ⚠ ${missing} game(s) left unclassified after retries — proceeding without them`,
    );
  // Keep only games that got classified; attach pool-authoritative facts.
  const out: ClassifiedGame[] = [];
  slots.forEach((s, i) => {
    const ai = byI.get(i);
    if (!ai) return;
    out.push({
      ...ai,
      name: s.name,
      // Snap AI labels onto the fixed vocabularies so rankings don't fragment.
      theme: canon(ai.theme, THEME_VOCAB),
      volatility: canon(ai.volatility, VOLATILITY_VOCAB),
      rtpBand: canon(ai.rtpBand, RTP_BANDS),
      mechanics: (ai.mechanics ?? [])
        .map((m) => canon(m, MECHANIC_VOCAB))
        .filter((m): m is string => !!m),
      casinos: s.casinos,
      casinoCount: s.casinos.length,
      rail: railOf(s),
    });
  });
  return out;
}

/** Count games per bucket → {label,count,pct}, pct over the whole pool, sorted
 * count DESC then label ASC. `pick` returns one label or several (mechanics). */
function rankBy(
  games: ClassifiedGame[],
  pick: (g: ClassifiedGame) => string | string[] | undefined,
): Rank[] {
  const counts = new Map<string, number>();
  for (const g of games) {
    const v = pick(g);
    const labels = Array.isArray(v) ? v : v ? [v] : [];
    for (const l of labels) {
      if (!l) continue;
      counts.set(l, (counts.get(l) || 0) + 1);
    }
  }
  const total = games.length || 1;
  return [...counts.entries()]
    .map(([label, count]) => ({
      label,
      count,
      pct: Math.round((100 * count) / total),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function computeRankings(games: ClassifiedGame[]): Record<string, Rank[]> {
  return {
    themes: rankBy(games, (g) => g.theme),
    rtp: rankBy(games, (g) => g.rtpBand),
    volatility: rankBy(games, (g) => g.volatility),
    mechanics: rankBy(games, (g) => g.mechanics),
    providers: rankBy(games, (g) => g.provider),
  };
}

/** Top 10 cross-casino: casinoCount DESC, ties → both > trending > new, name ASC. */
function buildTop10(games: ClassifiedGame[]): Record<string, unknown>[] {
  const railRank = (r?: string) =>
    r === "both" ? 0 : r === "trending" ? 1 : 2;
  return [...games]
    .sort(
      (a, b) =>
        (b.casinoCount || 0) - (a.casinoCount || 0) ||
        railRank(a.rail) - railRank(b.rail) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 10)
    .map((g, idx) => ({
      rank: idx + 1,
      name: g.name,
      provider: g.provider,
      casinoCount: g.casinoCount,
      casinos: g.casinos,
      theme: g.theme,
      rtp: g.rtp,
      volatility: g.volatility,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — AI owns values, code owns layout + example selection (deterministic).
// ─────────────────────────────────────────────────────────────────────────────

interface AiGame {
  name: string;
  provider?: string;
  theme?: string;
  rtpBand?: string;
  volatility?: string;
  mechanics?: string[];
  confidence?: string;
}
// A classified game = the AI per-game fields plus the pool-authoritative facts
// (which casinos it appears on, which rail) that we know from the snapshots.
interface ClassifiedGame extends AiGame {
  i?: number;
  colors?: string[];
  rtp?: number | string;
  bonusGames?: number;
  rail?: string;
  casinos?: string[];
  casinoCount?: number;
}
interface NarrativeResult {
  summary?: string;
  focus?: FocusItem[];
  whyTrending?: Record<string, string>;
}
interface Rank {
  label: string;
  count: number;
  pct: number;
}
interface FocusItem {
  headline?: string;
  detail?: string;
  examples?: string[];
}
interface TrendResult {
  summary?: string;
  totals?: { uniqueGames?: number; casinos?: string[] };
  games?: AiGame[];
  rankings?: Record<string, Rank[]>;
  top10?: Record<string, unknown>[];
  focus?: FocusItem[];
}

const TOP_BUCKETS = 5; // show example games under this many buckets per ranking
const EXAMPLES_PER_BUCKET = 3;

function chip(name: string, url?: string): string {
  return url
    ? `<a class="ex" href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>`
    : `<span class="ex">${esc(name)}</span>`;
}

/** A ranking group: bars for all buckets, plus example game chips under the top
 * few buckets. `match(game,label)` decides which games belong to a bucket. */
function rankGroup(
  title: string,
  rows: Rank[] = [],
  games: AiGame[],
  urlOf: Map<string, string>,
  ccOf: Map<string, number>,
  match: (g: AiGame, label: string) => boolean,
): string {
  if (!rows.length)
    return `<div class="rank-card"><h3>${esc(title)}</h3><div class="muted">—</div></div>`;
  const sorted = [...rows].sort(
    (a, b) =>
      (b.count || 0) - (a.count || 0) ||
      String(a.label).localeCompare(String(b.label)),
  );
  const max = Math.max(...sorted.map((r) => r.count || 0), 1);
  const body = sorted
    .map((r, idx) => {
      const bar = `<div class="bar-row">
        <div class="bar-label">${esc(String(r.label))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round((100 * (r.count || 0)) / max)}%"></div></div>
        <div class="bar-num">${esc(String(r.count))}<span class="muted"> · ${esc(String(r.pct))}%</span></div>
      </div>`;
      let ex = "";
      if (idx < TOP_BUCKETS) {
        const picks = games
          .filter((g) => match(g, String(r.label)))
          .map((g) => ({ name: g.name, key: normName(g.name) }))
          .sort(
            (a, b) =>
              (ccOf.get(b.key) || 0) - (ccOf.get(a.key) || 0) ||
              a.name.localeCompare(b.name),
          )
          .slice(0, EXAMPLES_PER_BUCKET);
        if (picks.length)
          ex = `<div class="examples">${picks.map((p) => chip(p.name, urlOf.get(p.key))).join("")}</div>`;
      }
      return `<div class="rk-bucket">${bar}${ex}</div>`;
    })
    .join("");
  return `<div class="rank-card"><h3>${esc(title)}</h3>${body}</div>`;
}

function top10Table(rows: Record<string, unknown>[] = []): string {
  if (!rows.length)
    return `<div class="muted">No cross-casino overlap found.</div>`;
  const body = rows
    .map((r) => {
      const v = (k: string) => esc(String(r[k] ?? ""));
      return `<tr>
        <td class="rk">${v("rank")}</td>
        <td><strong>${v("name")}</strong></td>
        <td>${v("provider")}</td>
        <td class="ct">${v("casinoCount")}<span class="muted"> (${esc(((r.casinos as string[]) || []).join(", "))})</span></td>
        <td>${v("theme")}</td><td>${v("rtp")}</td><td>${v("volatility")}</td>
        <td class="why">${v("whyTrending")}</td>
      </tr>`;
    })
    .join("");
  return `<table class="t10"><thead><tr>
    <th>#</th><th>Game</th><th>Provider</th><th>Casinos</th><th>Theme</th><th>RTP</th><th>Vol.</th><th>Why</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

function focusHtml(items: FocusItem[] = []): string {
  if (!items.length) return `<div class="muted">—</div>`;
  return items
    .map(
      (f) => `<div class="focus-item">
      <div class="focus-h">${esc(f.headline || "")}</div>
      <div class="focus-d">${esc(f.detail || "")}</div>
      ${(f.examples || []).length ? `<div class="examples">${(f.examples || []).map((e) => chip(e)).join("")}</div>` : ""}
    </div>`,
    )
    .join("");
}

function newSinceHtml(
  newSlots: { game: PooledGame; theme?: string }[],
  newOriginals: PooledOriginal[],
  prevExists: boolean,
): string {
  if (!prevExists)
    return `<div class="note">Baseline run — no previous report to diff against. The next run will surface what's new since this one.</div>`;
  if (!newSlots.length && !newOriginals.length)
    return `<div class="note">Nothing new since the previous report.</div>`;
  const slotChips = newSlots
    .map(({ game, theme }) =>
      chip(`${game.name}${theme ? ` · ${theme}` : ""}`, game.url),
    )
    .join("");
  const origChips = newOriginals.map((o) => chip(o.name, o.url)).join("");
  return `${newSlots.length ? `<h3>New slots (${newSlots.length})</h3><div class="examples wide">${slotChips}</div>` : ""}
    ${newOriginals.length ? `<h3>New originals (${newOriginals.length})</h3><div class="examples wide">${origChips}</div>` : ""}`;
}

function originalsHtml(originals: PooledOriginal[]): string {
  if (!originals.length)
    return `<div class="muted">No originals captured.</div>`;
  const rows = originals
    .map(
      (o) => `<tr><td><strong>${esc(o.name)}</strong></td>
      <td class="ct">${o.casinos.length}</td>
      <td class="muted">${esc(o.casinos.join(", "))}</td></tr>`,
    )
    .join("");
  return `<table class="orig"><thead><tr><th>Original</th><th>Casinos</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderHtml(
  r: TrendResult,
  meta: {
    stamp: string;
    poolCount: number;
    casinos: string[];
    originals: PooledOriginal[];
    newSlots: { game: PooledGame; theme?: string }[];
    newOriginals: PooledOriginal[];
    prevExists: boolean;
    urlOf: Map<string, string>;
    ccOf: Map<string, number>;
  },
): string {
  const when = new Date().toLocaleString();
  const games = r.games || [];
  const g = (
    rows: Rank[] | undefined,
    m: (g: AiGame, l: string) => boolean,
    title: string,
  ) => rankGroup(title, rows, games, meta.urlOf, meta.ccOf, m);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grog — Slot Trend Radar</title>
<style>
  :root{--bg:#0a0d17;--surface:#141a2a;--line:#283049;--text:#eef1f8;--muted:#8b94ae;--accent:#2ee6a6;--accent2:#6aa6ff;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
  .wrap{max-width:1180px;margin:0 auto;padding:28px 22px 90px}
  h1{font-size:24px;margin:0 0 2px} .sub{color:var(--muted);font-size:13px;margin-bottom:20px}
  .summary{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:12px;padding:14px 18px;margin-bottom:24px;font-size:15px}
  h2{font-size:17px;border-bottom:1px solid var(--line);padding-bottom:8px;margin:34px 0 16px}
  h3{font-size:12px;margin:14px 0 8px;color:var(--accent2);text-transform:uppercase;letter-spacing:.5px}
  .rank-card h3{margin:0 0 10px}
  .muted{color:var(--muted)}
  .ranks{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}
  .rank-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .rk-bucket{margin:0 0 10px} .rk-bucket:last-child{margin-bottom:0}
  .bar-row{display:grid;grid-template-columns:130px 1fr 74px;align-items:center;gap:10px;font-size:12px}
  .bar-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar-track{background:#0c0f1a;border-radius:6px;height:14px;overflow:hidden}
  .bar-fill{height:100%;background:linear-gradient(90deg,var(--accent2),var(--accent))}
  .bar-num{text-align:right;font-variant-numeric:tabular-nums}
  .examples{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 2px 0}
  .examples.wide{margin-top:2px}
  .ex{font-size:11px;background:#0c0f1a;border:1px solid var(--line);color:var(--text);text-decoration:none;padding:2px 8px;border-radius:20px;white-space:nowrap}
  a.ex:hover{border-color:var(--accent);color:var(--accent)}
  table{width:100%;border-collapse:collapse;font-size:13px;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  th{text-align:left;background:#0e1422;color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:9px 11px}
  td{padding:8px 11px;border-top:1px solid var(--line);vertical-align:top}
  .t10 .rk{font-weight:700;color:var(--accent)} .t10 .ct,.orig .ct{white-space:nowrap} .t10 .why{color:var(--muted)}
  .scroll{overflow-x:auto}
  .focus-item{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--accent2);border-radius:10px;padding:11px 15px;margin-bottom:10px}
  .focus-h{font-weight:700;font-size:14px} .focus-d{font-size:13px;margin:3px 0 2px}
  .note{font-size:13px;color:var(--muted);background:var(--surface);border:1px dashed var(--line);border-radius:10px;padding:10px 14px}
</style></head><body><div class="wrap">
  <h1>🏴‍☠️ Grog — Slot Trend Radar</h1>
  <div class="sub">Generated ${esc(when)} · ${esc(meta.stamp)} · ${meta.poolCount} pooled slots · ${meta.originals.length} originals · casinos: ${esc(meta.casinos.join(", "))} · model: ${esc(aiModel())}${aiWeb() ? " + web" : ""}</div>
  <div class="summary">${esc(r.summary || "")}</div>

  <h2>🎯 What to focus on</h2>
  ${focusHtml(r.focus)}

  <h2>🏆 Top 10 — most cross-casino trending</h2>
  <div class="scroll">${top10Table(r.top10)}</div>

  <h2>📊 What's popular right now <span class="muted">— top buckets show example games</span></h2>
  <div class="ranks">
    ${g(r.rankings?.themes, (x, l) => x.theme === l, "Themes")}
    ${g(r.rankings?.rtp, (x, l) => x.rtpBand === l, "RTP bands")}
    ${g(r.rankings?.volatility, (x, l) => x.volatility === l, "Volatility")}
    ${g(r.rankings?.mechanics, (x, l) => (x.mechanics || []).includes(l), "Mechanics")}
    ${g(r.rankings?.providers, (x, l) => x.provider === l, "Providers")}
  </div>

  <h2>🆕 New since last report</h2>
  ${newSinceHtml(meta.newSlots, meta.newOriginals, meta.prevExists)}

  <h2>🎲 Originals across casinos <span class="muted">(deduped — same game on multiple casinos = one row)</span></h2>
  <div class="scroll">${originalsHtml(meta.originals)}</div>
</div></body></html>`;
}

export async function runTrend(only?: string[]): Promise<string> {
  loadEnv();
  const snaps = await latestSnapshots(only);
  if (!snaps.length)
    throw new Error("no snapshots yet — run `grog run all` first");
  const slots = poolSlots(snaps);
  const originals = poolOriginals(snaps);
  if (!slots.length)
    throw new Error("no slots in the latest snapshots — nothing to analyze");

  const casinos = [...new Set(snaps.map((s) => s.casino))];
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);

  // Diff against the previous report BEFORE we write this one.
  const prevNames = await previousNames();
  const prevExists = prevNames !== null;
  const newSlots = prevExists
    ? slots.filter((s) => !prevNames!.has(normName(s.name)))
    : [];
  const newOriginals = prevExists
    ? originals.filter((o) => !prevNames!.has(normName(o.name)))
    : [];

  console.log(
    `pooled ${slots.length} slots + ${originals.length} originals from ${casinos.length} casino(s): ${casinos.join(", ")}`,
  );
  console.log(`analyzing with ${aiModel()}${aiWeb() ? " (web)" : ""}…`);

  const outDir = path.join(REPORTS_DIR, `trend_${stamp}`);
  await mkdir(outDir, { recursive: true });

  // 1) Classify every game in small batches and 2) aggregate in code. This keeps
  // every LLM call's JSON small enough to never truncate (the old single-call
  // approach emitted >32k tokens for a ~200-game pool and finished as length-cut
  // invalid JSON).
  const games = await classifyAll(slots);
  await writeFile(
    path.join(outDir, "classified.json"),
    JSON.stringify(games, null, 2),
  );
  if (!games.length)
    throw new Error(
      `classification produced no usable data — see ${path.relative(ROOT, outDir)}`,
    );
  const rankings = computeRankings(games);
  const top10 = buildTop10(games);

  // 3) One small final call: only the analyst narrative (summary/focus/why),
  //    built from the already-aggregated data — tiny input, tiny output.
  console.log("writing narrative (summary / focus / why-trending)…");
  const catalog = games.map((g) => ({
    name: g.name,
    theme: g.theme,
    volatility: g.volatility,
    rtpBand: g.rtpBand,
    mechanics: g.mechanics,
  }));
  let narrative: NarrativeResult = {};
  try {
    const narrRaw = await chat(
      [
        { role: "system", content: narrativeSystem() },
        {
          role: "user",
          content: narrativeUser(rankings, top10, catalog, games.length),
        },
      ],
      {
        json: true,
        temperature: 0.3,
        maxTokens: 6000,
        timeoutMs: 90_000,
        // Disable thinking: this call only synthesizes already-computed data, so
        // it needs no fact-recall. Left enabled, Flash-Lite spiralled into a
        // 23k-token think and OpenRouter killed the idle stream (504).
        reasoning: { enabled: false },
      },
    );
    await writeFile(path.join(outDir, "raw-response.txt"), narrRaw);
    narrative = parseJsonLoose(narrRaw) as unknown as NarrativeResult;
  } catch (e) {
    console.log(
      `   ⚠ narrative call failed (${e instanceof Error ? e.message : e}) — report still has rankings + top 10`,
    );
  }

  const result: TrendResult = {
    summary: narrative.summary,
    totals: { uniqueGames: games.length, casinos },
    games,
    rankings,
    top10: top10.map((t) => ({
      ...t,
      whyTrending: narrative.whyTrending?.[String(t.name)] ?? "",
    })),
    focus: narrative.focus,
  };

  // Map AI game names back to URL + cross-casino count for example links.
  const urlOf = new Map(slots.map((s) => [normName(s.name), s.url]));
  const ccOf = new Map(slots.map((s) => [normName(s.name), s.casinos.length]));
  const themeOf = new Map(
    (result.games || []).map((g) => [normName(g.name), g.theme]),
  );
  const newSlotsAnnotated = newSlots.map((game) => ({
    game,
    theme: themeOf.get(normName(game.name)),
  }));

  const htmlPath = path.join(outDir, "report.html");
  await writeFile(
    htmlPath,
    renderHtml(result, {
      stamp,
      poolCount: slots.length,
      casinos,
      originals,
      newSlots: newSlotsAnnotated,
      newOriginals,
      prevExists,
      urlOf,
      ccOf,
    }),
  );
  await writeFile(
    path.join(outDir, "report.json"),
    JSON.stringify(
      {
        stamp,
        generatedAt: new Date().toISOString(),
        model: aiModel(),
        web: aiWeb(),
        casinos,
        slotCount: slots.length,
        originalsCount: originals.length,
        newSlots: newSlots.map((s) => s.name),
        newOriginals: newOriginals.map((o) => o.name),
        ...result,
      },
      null,
      2,
    ),
  );
  // Saved for the next run's diff + transparency (raw-response.txt already written).
  await writeFile(
    path.join(outDir, "input.json"),
    JSON.stringify({ slots, originals }, null, 2),
  );

  console.log(`trend report → ${path.relative(ROOT, htmlPath)}`);
  return htmlPath;
}
