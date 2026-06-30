import type { Casino, Game } from "../src/types.js";
import { curlText } from "../src/curl.js";

// Thrill (SvelteKit SPA, Cloudflare-gated HTML) publishes a full daily game-state
// snapshot as a static JSON on a separate host — no auth, no browser, plain GET.
// The edge answers fine over IPv4 but black-holes IPv6 (Node's happy-eyeballs
// intermittently picks v6 and hangs), so we fetch via curl with -4 forced. The
// file is date-named DD-MM-YYYY; we try today then yesterday in case today's
// isn't published yet. Each game carries its position within every site category
// in `categoryGameIndex`, so we rebuild the on-site rails (new releases / hot
// picks / originals) by that index.
const STATE_HOST = "https://games-state.thrill.com/snapshots";
const SITE = "https://thrill.com";

// site category code → our category key + cap
const RAILS = [
  { code: "new-releases", key: "new-releases", limit: 30 },
  { code: "hot-picks", key: "trending-slots", limit: 30 },
  { code: "originals", key: "thrill-originals", limit: 50 },
];

interface CatIndex {
  category: { id: number; name: string; code: string };
  index: number;
}
interface ThrillGame {
  name: string;
  gameCode: string;
  provider?: { name?: string; code?: string };
  hidden?: boolean;
  volatility?: number;
  rtp?: number;
  releaseDateTimestampMs?: number;
  categoryGameIndex?: CatIndex[];
}

function ddmmyyyy(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

async function loadState(log: (m: string) => void): Promise<{ games: ThrillGame[]; date: string }> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  for (const d of [now, yesterday]) {
    const date = ddmmyyyy(d);
    const res = await curlText(`${STATE_HOST}/${date}.json`, {
      ipv4: true,
      timeoutMs: 30_000,
      headers: { accept: "application/json", referer: `${SITE}/` },
    }).catch(() => null);
    if (res?.status === 200) {
      const json = JSON.parse(res.body) as { games?: ThrillGame[] };
      return { games: json.games ?? [], date };
    }
    log(`snapshot ${date} unavailable (${res?.status ?? "no response"}) — trying older`);
  }
  throw new Error("no Thrill game-state snapshot reachable (today or yesterday)");
}

const casino: Casino = {
  name: "Thrill",
  startUrl: `${SITE}/casino/category/originals`,

  async fetch(log) {
    const { games: state, date } = await loadState(log);
    const live = state.filter((g) => !g.hidden && g.gameCode && g.name);
    log(`game-state ${date}: ${live.length} live games`);

    const all: Game[] = [];
    const raw: Record<string, ThrillGame[]> = {};
    for (const r of RAILS) {
      const rows = live
        .map((g) => {
          const ci = (g.categoryGameIndex ?? []).find((c) => c.category?.code === r.code);
          return ci ? { g, index: ci.index } : null;
        })
        .filter((x): x is { g: ThrillGame; index: number } => !!x)
        .sort((a, b) => a.index - b.index)
        .slice(0, r.limit)
        .map((x) => x.g);
      raw[r.key] = rows;
      for (const g of rows) {
        all.push({
          name: g.name,
          // The play-route slug is the gameCode verbatim (originals already use
          // dashes like "thrill-keno"; third-party codes keep underscores like
          // "avx_blessingsofcaishen"), so don't transform it.
          url: `${SITE}/casino/play/${g.gameCode}`,
          id: g.gameCode,
          category: r.key,
        });
      }
      log(`${r.key}: ${rows.length} games`);
    }
    if (!all.length) throw new Error("no rails matched — category codes may have changed");
    log(`total: ${all.length} links across ${Object.keys(raw).length} categories`);

    return { games: all, raw: { fetchedAt: new Date().toISOString(), date, categories: raw } };
  },
};
export default casino;
