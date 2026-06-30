import type { Casino, Game } from "../src/types.js";
import { curlText } from "../src/curl.js";

// CoinCasino is a CMS-driven SPA. The HTML shell is hard-gated by Cloudflare,
// but the data lives on a separate gateway host (platform-gateway.coincasino.com)
// that passes with a normal origin/referer (Node's fetch is TLS-fingerprinted →
// curl helper, like Rainbet/Duelbits). Two steps: (1) POST the /casino page to
// the CMS to discover the homepage rails (each "GamesCategoryContainer" carries
// a title, slug and a games-fetch URL containing the rail's id — resolved live
// so we never hard-code a UUID that might rotate); (2) GET each rail we want.
const SITE = "https://www.coincasino.com";
const GW = "https://platform-gateway.coincasino.com";
const HEADERS = {
  "content-type": "application/json",
  origin: SITE,
  referer: `${SITE}/`,
  accept: "application/json",
};

// rail slug tail → our category key + cap. (Slugs are stable + human-readable;
// the gateway has no pure "new releases" rail, so "New & Popular" is the closest.)
const RAILS = [
  { match: "new-popular", key: "new-releases", limit: 30 },
  { match: "player-favourites", key: "trending-slots", limit: 30 },
  { match: "coincasino-originals", key: "coincasino-originals", limit: 50 },
];

interface CCGame {
  id: string;
  name: string;
  imageUrl?: string;
  realPlayUrl?: string;
}
interface Rail {
  title?: string;
  slug?: string;
  fetchUrl?: string;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await curlText(`${GW}${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  if (res.status !== 200 && res.status !== 201) throw new Error(`HTTP ${res.status} for ${path}`);
  return JSON.parse(res.body);
}
async function get(pathOrUrl: string): Promise<unknown> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GW}/${pathOrUrl.replace(/^\//, "")}`;
  const res = await curlText(url, { headers: HEADERS });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  return JSON.parse(res.body);
}

/** Collect every "GamesCategoryContainer" rail (title/slug/fetchUrl) from the
 * CMS page tree, wherever it is nested. */
function findRails(root: unknown): Rail[] {
  const out: Rail[] = [];
  const seen = new Set<unknown>();
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== "object" || seen.has(o)) continue;
    seen.add(o);
    if (Array.isArray(o)) {
      for (const x of o) stack.push(x);
      continue;
    }
    const rec = o as Record<string, unknown>;
    if (rec.container === "GamesCategoryContainer" && rec.data) {
      const d = rec.data as Record<string, unknown>;
      out.push({ title: d.title as string, slug: d.slug as string, fetchUrl: d.fetchUrl as string });
    }
    for (const k in rec) stack.push(rec[k]);
  }
  return out;
}

function toGame(g: CCGame, category: string): Game | null {
  if (!g.name) return null;
  const path = (g.realPlayUrl || "").replace(/\/play$/, "");
  return {
    name: g.name,
    url: path ? `${SITE}${path}` : SITE,
    thumb: g.imageUrl ? `${SITE}${g.imageUrl}` : undefined,
    id: g.id,
    category,
  };
}

const casino: Casino = {
  name: "CoinCasino",
  startUrl: `${SITE}/en/casino/category/coincasino-originals`,

  async fetch(log) {
    const page = await post("/cms-service/api/frontend/slug/page", { slug: "/casino" });
    const rails = findRails(page);
    log(`discovered ${rails.length} rails on /casino`);

    const all: Game[] = [];
    const raw: Record<string, CCGame[]> = {};
    for (const r of RAILS) {
      const rail = rails.find((x) => (x.slug || "").includes(r.match) && x.fetchUrl);
      if (!rail?.fetchUrl) {
        log(`⚠ rail "${r.match}" not found — skipping`);
        continue;
      }
      const res = (await get(rail.fetchUrl)) as { data?: CCGame[] };
      const rows = (res.data ?? []).slice(0, r.limit);
      raw[r.key] = rows;
      let n = 0;
      for (const g of rows) {
        const game = toGame(g, r.key);
        if (game) {
          all.push(game);
          n++;
        }
      }
      log(`${r.key}: ${n} games`);
    }
    if (!all.length) throw new Error("no rails matched — CMS slugs may have changed");
    log(`total: ${all.length} links across ${Object.keys(raw).length} categories`);

    return { games: all, raw: { fetchedAt: new Date().toISOString(), categories: raw } };
  },
};
export default casino;
