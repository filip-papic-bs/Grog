import type { Casino, Game } from "../src/types.js";
import { curlText } from "../src/curl.js";

// Wild.io runs the SoftSwiss/"s" platform. Its game grid is powered by a POST
// filter endpoint that takes a category identifier per rail. The catch is a
// custom Accept media type — `application/vnd.s.v2+json` — without it the API
// 406s (that, not Cloudflare, is what blocks a naive request). Endpoint + header
// found via a one-time live capture. No auth; curl helper.
const ENDPOINT = "https://www.wild.io/api/games_filter";
const SITE = "https://wild.io";
const ACCEPT = "application/vnd.s.v2+json";

const GROUPS = [
  { key: "new-releases", identifier: "new-releases", limit: 20 },
  { key: "trending-slots", identifier: "top-games", limit: 20 },
  { key: "wild-originals", identifier: "wild-originals", limit: 30 },
];

interface WildGame {
  identifier: string;
  title: string;
  seo_title?: string;
  uniq_seo_title?: string;
  provider?: string;
  payout?: string; // RTP %
  volatility_rating?: string;
  is_geo_available?: boolean;
}

async function fetchRail(identifier: string, pageSize: number): Promise<WildGame[]> {
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
  return (JSON.parse(res.body) as { data?: WildGame[] }).data ?? [];
}

function toGame(g: WildGame, category: string): Game | null {
  const slug = g.seo_title || g.uniq_seo_title;
  if (!slug || !g.title) return null;
  return {
    name: g.title,
    url: `${SITE}/games/${slug}`,
    id: slug,
    category,
  };
}

const casino: Casino = {
  name: "Wild.io",
  startUrl: `${SITE}/en/casino`,

  async fetch(log) {
    const all: Game[] = [];
    const raw: Record<string, WildGame[]> = {};
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
