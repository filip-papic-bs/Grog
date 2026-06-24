import type { Casino, Game } from "../src/types.js";
import { curlText } from "../src/curl.js";

// Duelbits exposes its homepage rails through one POST endpoint that returns
// clean JSON per "swimlane" section. Cloudflare fronts it and fingerprints the
// TLS handshake — Node's fetch gets 403, but curl passes — so we go through the
// curl helper. One request fetches all sections. `payout` is the RTP; originals
// have releasedAt === null.
const ENDPOINT = "https://ws.duelbits.com/games/landing/sections";

// section name → our category key + how many to keep ("originals" is small, keep all)
const SECTIONS = [
  { section: "new", key: "new-releases", limit: 50 },
  { section: "popular", key: "popular", limit: 50 },
  { section: "originals", key: "duelbits-originals", limit: 50 },
];

interface DuelbitsGame {
  slug: string;
  title: string;
  provider: string;
  producer: string;
  category: string;
  payout: number | null;
  releasedAt: string | null;
}

interface SectionResult {
  section: string;
  games: DuelbitsGame[];
}

const casino: Casino = {
  name: "Duelbits",
  startUrl: "https://duelbits.com/en/originals/all",

  async fetch(log) {
    const res = await curlText(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        swimlaneSections: SECTIONS.map((s) => s.section),
      }),
    });
    if (res.status !== 200 && res.status !== 201)
      throw new Error(`HTTP ${res.status} for ${ENDPOINT}`);
    const data = JSON.parse(res.body) as SectionResult[];
    const bySection = new Map(data.map((d) => [d.section, d.games ?? []]));

    const games: Game[] = [];
    const raw: Record<string, DuelbitsGame[]> = {};
    for (const s of SECTIONS) {
      const rows = (bySection.get(s.section) ?? []).slice(0, s.limit);
      raw[s.key] = rows;
      for (const g of rows) {
        games.push({
          name: g.title,
          url: `https://duelbits.com/casino/${g.slug}`,
          id: g.slug,
          category: s.key,
        });
      }
      log(`${s.key}: ${rows.length} games`);
    }
    log(`total: ${games.length} links across ${SECTIONS.length} categories`);

    return { games, raw: { fetchedAt: new Date().toISOString(), categories: raw } };
  },
};
export default casino;
