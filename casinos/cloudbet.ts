import type { Casino, Game } from "../src/types.js";
import { curlText } from "../src/curl.js";

// Cloudbet is a Next.js SPA behind Cloudflare. The HTML shell is reachable with
// a plain request (Cloudflare does NOT challenge it — returns 200; note the
// domain is ISP-blocked on some networks e.g. MTS Serbia, but works on VPN and
// from CI). Next.js bakes the entire casino lobby into a static data JSON we can
// GET directly: /_next/data/<buildId>/en/casino.json. That one payload carries
// the rail configs (lobbyConfig — each curated rail has an ordered gameKey list),
// the resolved dynamic rails (lobbyWidgetData → gameIds) and a full game
// dictionary (lobbyGamesById). So all three rails come from ONE GET — no Algolia
// key, no browser. The buildId rotates per deploy, so we scrape it from the
// casino HTML each run instead of hard-coding it. Node's fetch is Cloudflare-
// fingerprinted on this origin → curl helper (like Rainbet/Gamdom/CoinCasino).
const SITE = "https://www.cloudbet.com";
const HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  origin: SITE,
  referer: `${SITE}/en/casino`,
};

const NEW_LIMIT = 30;
const TRENDING_LIMIT = 30;
const ORIGINALS_LIMIT = 50;

interface CBGame {
  id: string;
  code: string;
  name: string;
  studio_name?: string;
  studio_slug?: string;
  rtp?: number | null;
  type?: string;
  categories?: string[];
  launch_url?: string;
  image_url_portrait?: string;
  timestamp?: string;
  new?: boolean;
  hot?: boolean;
  trending?: boolean;
  popularity?: number;
}
interface LobbyConfig {
  layout?: string;
  tracking_key?: string;
  gameKey?: string[];
  title?: string;
  limit?: number;
}
interface WidgetVal {
  gameIds?: string[];
  totalGameCount?: number;
}
interface PageProps {
  lobbyConfig?: LobbyConfig[];
  lobbyWidgetData?: Record<string, WidgetVal>;
  lobbyGamesById?: Record<string, CBGame>;
}

async function get(url: string): Promise<string> {
  const res = await curlText(url, { headers: HEADERS, timeoutMs: 30_000 });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.body;
}

function toGame(g: CBGame, category: string): Game | null {
  if (!g?.name || !g.code) return null;
  // launch_url is the authoritative play link ("/casino/play/<code>"); the site
  // is locale-prefixed so we add /en. Fall back to building it from the code.
  const path =
    g.launch_url && g.launch_url.startsWith("/") ? `/en${g.launch_url}` : `/en/casino/play/${g.code}`;
  return {
    name: g.name,
    url: `${SITE}${path}`,
    thumb: g.image_url_portrait || undefined,
    id: g.code,
    category,
  };
}

const casino: Casino = {
  name: "Cloudbet",
  startUrl: `${SITE}/en/casino/cloudbet_originals`,

  async fetch(log) {
    // 1) buildId from the (reachable) casino HTML — it rotates per deploy.
    const html = await get(`${SITE}/en/casino`);
    const buildId = html.match(/"buildId":"([^"]+)"/)?.[1];
    if (!buildId) throw new Error("could not find Next.js buildId in /en/casino HTML");
    log(`buildId ${buildId}`);

    // 2) the whole lobby as a static data JSON
    const data = JSON.parse(await get(`${SITE}/_next/data/${buildId}/en/casino.json`)) as {
      pageProps?: PageProps;
    };
    const pp = data.pageProps ?? {};
    const byId = pp.lobbyGamesById ?? {};
    const byCode: Record<string, CBGame> = {};
    for (const g of Object.values(byId)) if (g?.code) byCode[g.code] = g;
    const configs = pp.lobbyConfig ?? [];
    const widgets = pp.lobbyWidgetData ?? {};
    log(`lobby: ${Object.keys(byId).length} games, ${configs.length} rails`);

    // Curated rail: an ordered list of game codes in lobbyConfig, resolved via
    // the game dictionary (codes not present in the dict are dropped, matching
    // what the site renders).
    const fromConfig = (trackingKey: string): CBGame[] => {
      const cfg = configs.find((c) => c.tracking_key === trackingKey);
      return (cfg?.gameKey ?? []).map((code) => byCode[code]).filter((g): g is CBGame => !!g);
    };
    // Dynamic rail: lobbyWidgetData is keyed by a serialized query; find the one
    // whose key contains the given filter and resolve its (already server-side)
    // gameIds. Used for rails that have no explicit gameKey list.
    const fromWidget = (needle: string): CBGame[] => {
      const key = Object.keys(widgets).find((k) => k.includes(needle));
      return key
        ? (widgets[key].gameIds ?? []).map((id) => byId[id]).filter((g): g is CBGame => !!g)
        : [];
    };

    // new releases: curated "New on Cloudbet" rail → dynamic "new" tag → flag
    let newReleases = fromConfig("new_on_cloudbet");
    if (!newReleases.length) newReleases = fromWidget('"_tags:new"');
    if (!newReleases.length)
      newReleases = Object.values(byId)
        .filter((g) => g.new)
        .sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0));
    newReleases = newReleases.slice(0, NEW_LIMIT);

    // trending: dynamic "Trending" rail → per-game flag (by live popularity)
    let trending = fromWidget('"trending:true"');
    if (!trending.length)
      trending = Object.values(byId)
        .filter((g) => g.trending)
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
    trending = trending.slice(0, TRENDING_LIMIT);

    // originals: curated "Cloudbet Originals" rail → games studio'd/tagged as such
    let originals = fromConfig("cloudbet_originals");
    if (!originals.length)
      originals = Object.values(byId).filter(
        (g) => (g.categories ?? []).includes("cloudbet_originals") || g.studio_slug === "cloudbet",
      );
    originals = originals.slice(0, ORIGINALS_LIMIT);

    const games: Game[] = [];
    const push = (rows: CBGame[], category: string) => {
      let n = 0;
      for (const g of rows) {
        const game = toGame(g, category);
        if (game) {
          games.push(game);
          n++;
        }
      }
      log(`${category}: ${n} games`);
    };
    push(newReleases, "new-releases");
    push(trending, "trending-slots");
    push(originals, "cloudbet-originals");

    if (!games.length) throw new Error("no rails resolved — lobby tracking_keys may have changed");
    log(`total: ${games.length} links across 3 categories`);

    return {
      games,
      raw: {
        fetchedAt: new Date().toISOString(),
        buildId,
        rails: {
          "new-releases": newReleases,
          "trending-slots": trending,
          "cloudbet-originals": originals,
        },
      },
    };
  },
};
export default casino;
