import type { Casino, Game } from "../src/types.js";
import { curlText } from "../src/curl.js";

// Rainbet is a Next.js SPA whose public API lives on services.rainbet.com.
// Cloudflare 403s a bare request, but a normal browser referer/origin sails
// through (Node's fetch is TLS-fingerprinted → we use the curl helper, like
// Duelbits/Betfury). The catalog endpoint validates a country+region against
// the caller's IP geo, so we first ask /v1/public/ip what geo this IP is and
// feed those back — which means it self-adjusts to wherever the scraper runs
// (Filip's VPN exit locally, or the server's region once deployed). Rails are
// the `sort_by` param: newest = new releases, popular = trending; the in-house
// games are `type === "originals"`.
const API = "https://services.rainbet.com/v1";
const SITE = "https://rainbet.com";
const HEADERS = {
  origin: SITE,
  referer: `${SITE}/`,
  accept: "application/json",
};

const NEW_LIMIT = 20;
const TRENDING_LIMIT = 20;
const ORIGINALS_LIMIT = 30;

interface RbGame {
  id: number;
  name: string;
  producer: string;
  payout: number | null; // RTP %
  url: string; // slug
  icon: string | null;
  type: string; // "slots" | "originals" | "roulette" | …
  region_blocked?: boolean;
}

async function api<T>(path: string): Promise<T> {
  const res = await curlText(`${API}${path}`, { headers: HEADERS });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${path}`);
  return JSON.parse(res.body) as T;
}

function toGame(g: RbGame, category: string): Game {
  return {
    name: g.name,
    url: `${SITE}/casino/${g.type}/${g.url}`,
    thumb: g.icon || undefined,
    id: g.url,
    category,
  };
}

const casino: Casino = {
  name: "Rainbet",
  startUrl: `${SITE}/casino/slots`,

  async fetch(log) {
    // 1) what geo is this IP? (the list endpoint cross-checks it)
    const geo = await api<{ country: string; region: string }>("/public/ip");
    const geoQ = `country=${encodeURIComponent(geo.country)}&region=${encodeURIComponent(geo.region)}`;
    log(`geo: ${geo.country}/${geo.region}`);

    const list = (sort: string) =>
      api<{ games: RbGame[] }>(`/public/games/list?${geoQ}&sort_by=${sort}`).then((r) =>
        (r.games || []).filter((g) => !g.region_blocked),
      );

    const [newest, popular] = await Promise.all([list("newest"), list("popular")]);

    const newReleases = newest.slice(0, NEW_LIMIT);
    const trending = popular.filter((g) => g.type === "slots").slice(0, TRENDING_LIMIT);
    const originals = popular.filter((g) => g.type === "originals").slice(0, ORIGINALS_LIMIT);

    const games: Game[] = [
      ...newReleases.map((g) => toGame(g, "new-releases")),
      ...trending.map((g) => toGame(g, "trending-slots")),
      ...originals.map((g) => toGame(g, "rainbet-originals")),
    ];
    log(
      `new-releases: ${newReleases.length} · trending-slots: ${trending.length} · rainbet-originals: ${originals.length}`,
    );
    log(`total: ${games.length} links across 3 categories`);

    return {
      games,
      raw: {
        fetchedAt: new Date().toISOString(),
        geo,
        rails: { "new-releases": newReleases, "trending-slots": trending, "rainbet-originals": originals },
      },
    };
  },
};
export default casino;
