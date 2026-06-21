/**
 * Cryptorino — NOT YET TUNED.
 * Same formula as betfury.ts / stake.ts: collect the real game tiles, then
 * screenshotNew() (skips games already in the DB; screenshots + stores new ones).
 *
 * To tune: run it, open the report, and if the count/names are wrong, inspect a
 * game tile and fix TILE / id / name. If the tiles have a stable id, set `id`
 * (e.g. "img@id"); otherwise the dedup key falls back to the URL slug.
 * If this casino is a single-page app that bounces on hard navigation, set
 * `nav: "click"` + `listingSelector: TILE` (see stake.ts). If Cloudflare blocks
 * it, add `headless: false` + `channel: "chrome"` and run with --profile.
 */
import type { Casino } from "../src/types.js";

// <-- TUNE: a selector matching ONE real game-tile anchor (with a real href).
const TILE = "a[href*='/game']";

const casino: Casino = {
  name: "Cryptorino",
  startUrl: "https://cryptorino.io/en/originals",

  async flow({ page, human, collect, screenshotNew, log }) {
    await human.goto(casino.startUrl);
    await human.dismiss();
    await page
      .waitForSelector(TILE, { state: "visible", timeout: 30000 })
      .catch(() => log("tiles not found — tune TILE for this casino"));
    await human.scrollToBottom();

    const games = await collect({
      tile: TILE,
      id: "img@id",   // <-- TUNE (or remove to dedup by URL slug)
      name: "img@alt", // <-- TUNE (or a title element like ".game-title")
      url: "@href",
      thumb: "img@src",
    });
    for (const g of games) g.name = g.name.replace(/\b\w/g, (c) => c.toUpperCase());
    log(`found ${games.length} games`);

    await screenshotNew(games, { category: "originals" });
  },
};
export default casino;
