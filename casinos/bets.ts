import type { Casino, Game } from "../src/types.js";
import { curlText } from "../src/curl.js";

// Bets.io runs the same SoftSwiss/"s" platform as Wild.io — identical POST
// games_filter endpoint and the same custom Accept media type
// (application/vnd.s.v2+json, without which it 406s). Only the per-brand rail
// identifiers differ (here: new_games / hot). Bets.io has no in-house originals.
const ENDPOINT = "https://www.bets.io/api/games_filter";
const SITE = "https://www.bets.io"; // canonical host (bets.io 301s here)
const ACCEPT = "application/vnd.s.v2+json";

const GROUPS = [
  { key: "new-releases", identifier: "new_games", limit: 20 },
  { key: "trending-slots", identifier: "hot", limit: 20 },
];

interface SsGame {
  identifier: string;
  title: string;
  seo_title?: string;
  uniq_seo_title?: string;
  provider?: string;
  payout?: string;
  volatility_rating?: string;
}

async function fetchRail(identifier: string, pageSize: number): Promise<SsGame[]> {
  const res = await curlText(ENDPOINT, {
    method: "POST",
    headers: {
      accept: ACCEPT,
      "content-type": "application/json",
      origin: SITE,
      referer: `${SITE}/`,
    },
    body: JSON.stringify({
      device: "desktop",
      page_size: pageSize,
      filter: { categories: { identifiers: [identifier] } },
      page: 1,
      without_territorial_restrictions: true,
    }),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for rail "${identifier}"`);
  return (JSON.parse(res.body) as { data?: SsGame[] }).data ?? [];
}

function toGame(g: SsGame, category: string): Game | null {
  const slug = g.seo_title || g.uniq_seo_title;
  if (!slug || !g.title) return null;
  return { name: g.title, url: `${SITE}/casino/games/${slug}`, id: slug, category };
}

const casino: Casino = {
  name: "Bets.io",
  startUrl: `${SITE}/casino`,

  async fetch(log) {
    const all: Game[] = [];
    const raw: Record<string, SsGame[]> = {};
    for (const grp of GROUPS) {
      const rows = await fetchRail(grp.identifier, grp.limit);
      raw[grp.key] = rows;
      let n = 0;
      for (const g of rows) {
        const game = toGame(g, grp.key);
        if (game) {
          all.push(game);
          n++;
        }
      }
      log(`${grp.key}: ${n} games`);
    }
    log(`total: ${all.length} links across ${GROUPS.length} categories`);
    return { games: all, raw: { fetchedAt: new Date().toISOString(), rails: raw } };
  },
};
export default casino;
