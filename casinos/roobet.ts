import type { Casino, Game } from "../src/types.js";

// Roobet serves its ENTIRE catalog (~8.5k games) from one unauthenticated JSON
// endpoint with no Cloudflare challenge — easier than Stake (plain GET, no
// browser UA even needed). Each game carries category/popularity/releasedAt, so
// "new", "popular" and "originals" are just client-side views of one response.
const ESSENTIALS = "https://roobet.com/_api/tp-games/essentials";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const NEW_LIMIT = 20;
const POPULAR_LIMIT = 20;

interface RoobetGame {
  id: string;
  gid: string;
  title: string;
  slug: string;
  provider: string;
  aggregator: string;
  category: string;
  releasedAt: string | null;
  createdAt: string | null;
  popularity: number | null;
  recentTrendingRank: number | null;
  squareImage: string | null;
}

function toGame(g: RoobetGame, category: string): Game {
  return {
    name: g.title,
    url: `https://roobet.com/casino/game/${g.slug}`,
    thumb: g.squareImage || undefined,
    id: g.slug,
    category,
  };
}

const casino: Casino = {
  name: "Roobet",
  startUrl: "https://roobet.com/casino/category/roobet-games",

  async fetch(log) {
    const res = await fetch(ESSENTIALS, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${ESSENTIALS}`);
    const all = (await res.json()) as RoobetGame[];
    log(`catalog: ${all.length} games`);

    // Newest by releasedAt (desc), most-played by popularity (desc), and the
    // in-house Roobet originals (aggregator === "roobet").
    const newReleases = [...all]
      .filter((g) => g.releasedAt)
      .sort((a, b) => (a.releasedAt! < b.releasedAt! ? 1 : -1))
      .slice(0, NEW_LIMIT);
    const popular = [...all]
      .filter((g) => typeof g.popularity === "number")
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
      .slice(0, POPULAR_LIMIT);
    const originals = all.filter((g) => g.aggregator === "roobet");

    const games: Game[] = [
      ...newReleases.map((g) => toGame(g, "new-releases")),
      ...popular.map((g) => toGame(g, "popular")),
      ...originals.map((g) => toGame(g, "roobet-originals")),
    ];

    log(
      `new-releases: ${newReleases.length} · popular: ${popular.length} · roobet-originals: ${originals.length}`,
    );
    log(`total: ${games.length} links across 3 categories`);

    // Keep only the selected games in the raw dump (the full catalog is ~8.7MB).
    return {
      games,
      raw: {
        fetchedAt: new Date().toISOString(),
        catalogSize: all.length,
        categories: {
          "new-releases": newReleases,
          popular,
          "roobet-originals": originals,
        },
      },
    };
  },
};
export default casino;
