import type { Casino, Game } from "../src/types.js";

// Stake is a SPA backed by a public GraphQL API. We hit that directly instead
// of driving a browser: no Playwright, no Cloudflare "are you human" challenge,
// no profile/IP escalation. The /_api/graphql endpoint passes Cloudflare with a
// plain request (only the HTML SPA shell is hard-gated).
const ENDPOINT = "https://stake.com/_api/graphql";

// Each homepage rail is a "kurator group" addressed by slug. limit = how many
// games to pull from the top of each (the rail's own ordering: new-releases is
// newest-first, slots is trending/popular-first). Tweak counts here.
const GROUPS = [
  { key: "new-releases", slug: "new-releases", limit: 50 },
  { key: "slots", slug: "slots", limit: 50 },
  { key: "stake-originals", slug: "stake-originals", limit: 50 }, // all (~31); 50 = API max per request
];

// We request every useful field the GameKuratorGame type exposes so the raw
// dump (raw-api.json) is complete. Notables: `edge` = house edge (1 - RTP),
// `playerCount` = players in the game right now (live popularity signal),
// `theme`/`type` = genre + provider key.
const QUERY = `
query GrogGroup($slug: String!, $limit: Int!) {
  slugKuratorGroup(slug: $slug) {
    name
    translation
    gameCount
    groupGamesList(limit: $limit, offset: 0) {
      game {
        id
        name
        slug
        active
        edge
        theme
        type
        playerCount
        thumbnailUrl
        provider { name }
      }
    }
  }
}`;

interface KuratorGame {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  edge: number | null;
  theme: string | null;
  type: string | null;
  playerCount: number | null;
  thumbnailUrl: string | null;
  provider: { name: string } | null;
}

interface GroupResponse {
  name: string;
  translation: string | null;
  gameCount: number;
  groupGamesList: { game: KuratorGame }[];
}

async function fetchGroup(slug: string, limit: number): Promise<GroupResponse> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // A normal browser UA; the endpoint is content-gated, not UA-gated, but
      // a real UA keeps us off any heuristic radar.
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      operationName: "GrogGroup",
      query: QUERY,
      variables: { slug, limit },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for group "${slug}"`);
  const json = (await res.json()) as {
    data?: { slugKuratorGroup?: GroupResponse | null };
    errors?: { message: string }[];
  };
  if (json.errors?.length)
    throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  const grp = json.data?.slugKuratorGroup;
  if (!grp) throw new Error(`group "${slug}" not found`);
  return grp;
}

const casino: Casino = {
  name: "Stake",
  startUrl: "https://stake.com/casino/home",
  channel: "chrome",

  async fetch(log) {
    const all: Game[] = [];
    const raw: Record<string, GroupResponse> = {};
    for (const grp of GROUPS) {
      const data = await fetchGroup(grp.slug, grp.limit);
      raw[grp.key] = data;
      for (const { game } of data.groupGamesList) {
        all.push({
          name: game.name,
          url: `https://stake.com/casino/games/${game.slug}`,
          thumb: game.thumbnailUrl || undefined,
          id: game.slug,
          category: grp.key,
        });
      }
      log(`${grp.key}: ${data.groupGamesList.length} games`);
    }
    log(`total: ${all.length} links across ${GROUPS.length} categories`);
    return { games: all, raw: { fetchedAt: new Date().toISOString(), groups: raw } };
  },
};
export default casino;
