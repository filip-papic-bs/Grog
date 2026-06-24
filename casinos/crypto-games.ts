import type { Casino, Game } from "../src/types.js";

// Crypto-Games.io is an older server-rendered site (Next.js on Vercel, no
// Cloudflare): the originals list is baked straight into the HTML, so a plain
// GET + regex gets the games — no browser, no API reverse-engineering. Its
// in-house catalog is small (~5 originals); no popularity/new ordering exposed.
const PAGE = "https://crypto-games.io/en";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// <a ... href="/en/game/<slug>">Display Name</a>
const ANCHOR = /href="\/en\/game\/([^"]+)">([^<]+)<\/a>/g;

const casino: Casino = {
  name: "Crypto-Games",
  startUrl: PAGE,

  async fetch(log) {
    const res = await fetch(PAGE, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${PAGE}`);
    const html = await res.text();

    const games: Game[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(ANCHOR)) {
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      games.push({
        name: m[2].trim(),
        url: `https://crypto-games.io/en/game/${slug}`,
        id: slug,
        category: "originals",
      });
    }
    log(`originals: ${games.length} games`);
    if (!games.length)
      log(`⚠ no games matched — page markup may have changed`);

    return {
      games,
      raw: {
        fetchedAt: new Date().toISOString(),
        categories: { originals: games },
      },
    };
  },
};
export default casino;
