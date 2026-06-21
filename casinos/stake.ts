/**
 * Stake — the originals grid uses real anchor links (/casino/games/<slug>), each
 * tile wrapped in div[data-analytics^="grid-casino-group-stake-originals"]. So we
 * collect them directly (no click-through needed).
 *
 * Stake runs a Cloudflare "are you human" check. With real Chrome + headful it
 * auto-passes; run it with a profile so the clearance cookie persists:
 *   npm run grog -- run stake --chrome --profile .profile/stake
 * After one pass you can reuse that profile headless too:
 *   npm run grog -- run stake --chrome --headless --profile .profile/stake
 */
import type { Casino } from "../src/types.js";

// Scope to the originals group's real anchors only.
const TILE =
  "[data-analytics^='grid-casino-group-stake-originals'] a.link[href*='/casino/games/']";

const casino: Casino = {
  name: "Stake",
  startUrl: "https://stake.com/casino/group/stake-originals",
  headless: false, // Stake's Cloudflare check needs a real, visible browser
  channel: "chrome", // drive real Google Chrome (auto-passes the "are you human" check)

  async flow({ page, human, collect, screenshotNew, log }) {
    log("opening Stake originals…");
    await human.goto(casino.startUrl);

    // Selector-based entry wait (no blind timer): wait for a grid tile to be
    // VISIBLE (only happens once Cloudflare cleared + page rendered), then for the
    // network to go quiet so Stake's post-Cloudflare load is fully done.
    log("waiting for the originals grid (Cloudflare to clear)…");
    await page
      .waitForSelector(TILE, { state: "visible", timeout: 60000 })
      .catch(() => log("grid not found — Cloudflare may still be blocking"));
    log("grid visible; brief settle…");
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});

    await human.scrollToBottom();

    // game_id comes from the grid cell's <img id="dice"> — the stable id we dedup on.
    const games = await collect({
      tile: TILE,
      id: "img@id",
      name: "img@alt",
      url: "@href",
      thumb: "img@src",
    });
    for (const g of games) g.name = g.name.replace(/\b\w/g, (c) => c.toUpperCase());
    log(`found ${games.length} games on the page`);

    // Stake is an SPA — open each new game by CLICKING its tile (client-side nav),
    // NOT a hard goto (which reloads the page and bounces back to stake.com).
    // After each game we go back to the listing (TILE) and continue.
    await screenshotNew(games, {
      category: "originals",
      nav: "click",
      listingSelector: TILE,
      settle: 3500,
    });
  },
};
export default casino;
