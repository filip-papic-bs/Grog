import type { Casino, Game } from "../src/types.js";

// Shuffle is a SPA backed by a public Apollo GraphQL API (same shape as Stake:
// introspection is disabled, but the catalog query name `GetGames` was lifted
// from the JS bundle). We hit /graphql directly — no Playwright, no Cloudflare
// browser challenge. Native Node fetch passes (the endpoint is not TLS-
// fingerprinted the way Duelbits' is). Only the HTML SPA shell is region-gated.
const ENDPOINT = "https://shuffle.com/graphql";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Thumbnails: each game carries an `image.key` UUID served from Shuffle's imgix
// CDN. Verified: https://shuffle-com.imgix.net/<key> -> 200 image/png.
const IMG_BASE = "https://shuffle-com.imgix.net/";

// The single `GetGames` query powers every casino rail; the rail is just a
// different combination of variables:
//   categories: [GameCategoryType!]  e.g. [SLOTS] (5.5k), [LATEST_RELEASES] (293)
//   sortBy:     GameSortby           POPULAR | FEATURED
//   isOriginal: Boolean              true -> the ~15 in-house Shuffle Originals
// So "new", "trending" and "originals" are the three views below.
// NB: `first` is capped at 40 per request server-side (>40 -> error). Originals
// total only ~15, so 40 covers them all; paginate via `skip` if a rail ever
// needs more than 40.
const GROUPS = [
  { key: "new-releases", limit: 20, vars: { categories: ["LATEST_RELEASES"] } },
  { key: "trending-slots", limit: 20, vars: { categories: ["SLOTS"], sortBy: "POPULAR" } },
  { key: "shuffle-originals", limit: 40, vars: { isOriginal: true } },
];

const QUERY = `
query GetGames($first: Int, $categories: [GameCategoryType!], $sortBy: GameSortby, $isOriginal: Boolean) {
  games(first: $first, categories: $categories, sortBy: $sortBy, isOriginal: $isOriginal) {
    totalCount
    nodes {
      id
      name
      slug
      releasedDate
      provider { name slug }
      image { key }
    }
  }
}`;

interface ShuffleGame {
  id: string;
  name: string;
  slug: string;
  releasedDate: string | null;
  provider: { name: string; slug: string } | null;
  image: { key: string } | null;
}

interface GamesResponse {
  totalCount: number;
  nodes: ShuffleGame[];
}

async function fetchGames(
  limit: number,
  vars: Record<string, unknown>,
): Promise<GamesResponse> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": UA,
      origin: "https://shuffle.com",
    },
    body: JSON.stringify({
      operationName: "GetGames",
      query: QUERY,
      variables: { first: limit, ...vars },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${ENDPOINT}`);
  const json = (await res.json()) as {
    data?: { games?: GamesResponse | null };
    errors?: { message: string }[];
  };
  if (json.errors?.length)
    throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  const games = json.data?.games;
  if (!games) throw new Error("no games in response");
  return games;
}

const casino: Casino = {
  name: "Shuffle",
  startUrl: "https://shuffle.com/casino",

  async fetch(log) {
    const all: Game[] = [];
    const raw: Record<string, GamesResponse> = {};
    for (const grp of GROUPS) {
      const data = await fetchGames(grp.limit, grp.vars);
      raw[grp.key] = data;
      for (const g of data.nodes) {
        all.push({
          name: g.name,
          url: `https://shuffle.com/casino/games/${g.slug}`,
          thumb: g.image?.key ? IMG_BASE + g.image.key : undefined,
          id: g.slug,
          category: grp.key,
        });
      }
      log(`${grp.key}: ${data.nodes.length} games (of ${data.totalCount})`);
    }
    log(`total: ${all.length} links across ${GROUPS.length} categories`);
    return { games: all, raw: { fetchedAt: new Date().toISOString(), groups: raw } };
  },
};
export default casino;
