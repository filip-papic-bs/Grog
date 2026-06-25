import type { Casino, Game } from "../src/types.js";
import { curlText } from "../src/curl.js";

// BC.Game is a Cloudflare-fronted SPA with no static API path — the endpoint was
// found by capturing the live page's network traffic (one-time DevTools-style
// capture via Playwright). Its casino rails come from a single POST that takes a
// `selectionName` (the rail) and returns `data.gameList.list[]`. No auth needed;
// Node fetch is Cloudflare-fingerprinted, so we go through the curl helper.
// Valid rails: "new", "slots", "originals" ("popular"/"trending"/etc. → code 4001).
const ENDPOINT = "https://bc.game/api/game/home/recommend/selection/";
const SITE = "https://bc.game";

// areaCode drives geo game-restrictions; CA is served fully. Restricted games
// come back with isRestricted=1 and are filtered out.
const AREA = "CA";
const PAGE_SIZE = 30; // min is ~20 (smaller → code 4001 "size too small")

const GROUPS = [
  { key: "new-releases", selection: "new" },
  { key: "trending-slots", selection: "slots" },
  { key: "bc-originals", selection: "originals" },
];

interface BcGame {
  gameIdentity?: { gameUrl?: string; gameName?: string; gameInfoId?: number };
  fullName?: string;
  thumbnail?: string;
  providerName?: string;
  rtpDes?: number;
  onlineUsers?: number;
  isRestricted?: number;
  categoryName?: string;
}
interface SelectionResp {
  code: number;
  msg: string | null;
  data?: { gameList?: { total?: number; list?: BcGame[] } };
}

async function fetchSelection(selection: string, pageSize: number): Promise<BcGame[]> {
  const res = await curlText(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: SITE,
      referer: `${SITE}/`,
      accept: "application/json",
    },
    body: JSON.stringify({
      areaCode: AREA,
      distinctId: "grog",
      showingBlocked: 0,
      bcLang: "en",
      browserLang: "en-US",
      isBrazil: false,
      selectionName: selection,
      page: 1,
      pageSize,
      relatedGameIds: "",
    }),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for selection "${selection}"`);
  const json = JSON.parse(res.body) as SelectionResp;
  if (json.code !== 0) throw new Error(`selection "${selection}" → code ${json.code} (${json.msg})`);
  return (json.data?.gameList?.list ?? []).filter((g) => !g.isRestricted);
}

function toGame(g: BcGame, category: string): Game | null {
  const slug = g.gameIdentity?.gameUrl;
  if (!slug || !g.fullName) return null;
  return {
    name: g.fullName,
    url: `${SITE}/game/${slug}`,
    thumb: g.thumbnail || undefined,
    id: slug,
    category,
  };
}

const casino: Casino = {
  name: "BC.Game",
  startUrl: `${SITE}/casino`,

  async fetch(log) {
    const all: Game[] = [];
    const raw: Record<string, BcGame[]> = {};
    for (const grp of GROUPS) {
      const rows = await fetchSelection(grp.selection, PAGE_SIZE);
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
    return { games: all, raw: { fetchedAt: new Date().toISOString(), area: AREA, rails: raw } };
  },
};
export default casino;
