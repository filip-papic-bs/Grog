import type { Casino, Game } from "../src/types.js";
import { curlText } from "../src/curl.js";
import { parseNuxtData, collectObjects } from "../src/nuxt.js";

// BetFury's live casino lives at bf1.io (betfury.com now redirects to Thrill).
// It's a Nuxt 3 SPA, but the homepage SSRs its featured catalog into the
// <script id="__NUXT_DATA__"> blob — ~300 games with rail flags baked in. No
// browser and no separate API host needed (api.betfury.com/api.bf1.io don't
// resolve; /api/* 404). Cloudflare TLS-fingerprints Node's fetch → we go through
// the curl helper (same as Duelbits). NOTE: bf1.io dropped the locale prefix —
// the live path is /casino (the old /en/casino now 404s). One request gets
// everything; the three rails are then just filters on the games' own flags:
//   new-releases  = new === true
//   trending      = hot === true (the "hot" slots rail)
//   originals     = integrator === "betfury" (in-house Dice/Mines/Plinko/…)
const BASE = "https://bf1.io";
const PAGE = `${BASE}/casino`;

const NEW_LIMIT = 40;
const TRENDING_LIMIT = 40;

interface BfGame {
  name: string;
  provider?: string;
  providerPublicName?: string;
  routes?: string[];
  image?: string;
  uuid?: string;
  integrator?: string;
  type?: string;
  new?: boolean;
  hot?: boolean;
  top?: boolean;
}

function isGame(o: Record<string, unknown>): boolean {
  return (
    typeof o.name === "string" &&
    Array.isArray(o.routes) &&
    (typeof o.provider === "string" || typeof o.providerPublicName === "string")
  );
}

function toGame(g: BfGame, category: string): Game | null {
  const route = g.routes?.find((r) => typeof r === "string" && r.startsWith("casino/games/"));
  if (!route) return null;
  return {
    name: g.name,
    url: `${BASE}/${route}`,
    thumb: typeof g.image === "string" && g.image.startsWith("http") ? g.image : undefined,
    id: g.uuid || route.replace("casino/games/", ""),
    category,
  };
}

const casino: Casino = {
  name: "BetFury",
  startUrl: PAGE,

  async fetch(log) {
    const res = await curlText(PAGE, { headers: { accept: "text/html" } });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${PAGE}`);

    const root = parseNuxtData(res.body);
    const all = collectObjects(root, isGame) as unknown as BfGame[];
    // Dedupe by uuid/canonical route (the same game object can sit on several rails).
    const seen = new Set<string>();
    const games = all.filter((g) => {
      const key = g.uuid || g.routes?.[0] || g.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    log(`catalog: ${games.length} games`);

    const newReleases = games.filter((g) => g.new).slice(0, NEW_LIMIT);
    const trending = games
      .filter((g) => (g.hot || g.top) && g.type === "slots")
      .slice(0, TRENDING_LIMIT);
    const originals = games.filter((g) => g.integrator === "betfury");

    const out: Game[] = [];
    const push = (rows: BfGame[], category: string) => {
      let n = 0;
      for (const g of rows) {
        const game = toGame(g, category);
        if (game) {
          out.push(game);
          n++;
        }
      }
      log(`${category}: ${n} games`);
    };
    push(newReleases, "new-releases");
    push(trending, "trending-slots");
    push(originals, "betfury-originals");
    log(`total: ${out.length} links across 3 categories`);

    return {
      games: out,
      raw: {
        fetchedAt: new Date().toISOString(),
        catalogSize: games.length,
        rails: { "new-releases": newReleases, "trending-slots": trending, "betfury-originals": originals },
      },
    };
  },
};
export default casino;
