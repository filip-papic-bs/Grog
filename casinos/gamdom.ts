import type { Casino, Game } from "../src/types.js";
import { curlText } from "../src/curl.js";

// Gamdom builds its API URLs at runtime (nothing static to grep), so the
// endpoint was found via a one-time live network capture. One POST to the
// thematic-carousel endpoint returns ALL the homepage rails at once, each with
// its games inline — we just pick the rails we care about by slug. No auth;
// Node fetch is Cloudflare-fingerprinted → curl helper.
const ENDPOINT = "https://gamdom.com/client-api/thematicCarousel/carousels";
const SITE = "https://gamdom.com";

// carousel slug → our category key
const RAILS: Record<string, string> = {
  "new-games": "new-releases",
  "hot-games": "trending-slots",
  "gamdom-originals": "gamdom-originals",
};

interface StaticData {
  game_code?: string;
  slug?: string;
  name?: string;
  default_provider_name?: string;
  url_thumb?: string;
  url_thumb_override?: string;
  rtp?: number;
}
interface Carousel {
  slug?: string;
  name?: string;
  games?: { staticData?: StaticData }[];
}

function thumb(s: StaticData): string | undefined {
  const t = s.url_thumb || s.url_thumb_override;
  if (!t) return undefined;
  return t.startsWith("http") ? t : `${SITE}${t}`;
}

function toGame(s: StaticData, category: string): Game | null {
  if (!s.slug || !s.name) return null;
  return {
    name: s.name,
    url: `${SITE}/casino/${s.slug}`,
    thumb: thumb(s),
    id: s.game_code || s.slug,
    category,
  };
}

const casino: Casino = {
  name: "Gamdom",
  startUrl: `${SITE}/casino`,

  async fetch(log) {
    const res = await curlText(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: SITE,
        referer: `${SITE}/`,
        accept: "application/json",
      },
      body: JSON.stringify({ locale: "en-gb" }),
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${ENDPOINT}`);
    const carousels = JSON.parse(res.body) as Carousel[];

    const all: Game[] = [];
    const raw: Record<string, StaticData[]> = {};
    for (const c of carousels) {
      const category = c.slug ? RAILS[c.slug] : undefined;
      if (!category) continue;
      const rows = (c.games ?? []).map((g) => g.staticData).filter((s): s is StaticData => !!s);
      raw[category] = rows;
      let n = 0;
      for (const s of rows) {
        const game = toGame(s, category);
        if (game) {
          all.push(game);
          n++;
        }
      }
      log(`${category}: ${n} games`);
    }
    if (!all.length)
      throw new Error(`no rails matched — carousel slugs were: ${carousels.map((c) => c.slug).join(", ")}`);
    log(`total: ${all.length} links across ${Object.keys(raw).length} categories`);

    return { games: all, raw: { fetchedAt: new Date().toISOString(), rails: raw } };
  },
};
export default casino;
