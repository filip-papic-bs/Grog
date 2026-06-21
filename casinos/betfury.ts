/**
 * BetFury — its originals are real anchor links (/casino/games/<slug>), so the
 * straightforward "collect hrefs, visit each, screenshot" flow works here.
 */
import type { Casino } from "../src/types.js";

const casino: Casino = {
  name: "BetFury",
  startUrl: "https://betfury.com/casino/originals",

  async flow({ human, collect, screenshotNew, log }) {
    await human.goto(casino.startUrl);
    await human.dismiss();
    await human.scrollToBottom();

    // Scope to the originals grid's card anchors only — a bare
    // a[href*='/casino/games/'] also catches the "popular/recommended" carousels
    // lower on the page and inflates the count. (No id attribute here, so the
    // dedup key falls back to the URL slug, e.g. /casino/games/dice -> "dice".)
    const games = await collect({
      tile: "ul.games-list a.card[href*='/casino/games/']",
      name: "img@alt",
      url: "@href",
      thumb: "img@src",
    });
    // BetFury's alt text is "<Name> slot by BetFury" — strip that to a clean name.
    for (const g of games) g.name = g.name.replace(/\s*slot by BetFury\s*$/i, "").trim();
    log(`found ${games.length} games`);

    // Skip any game already in the DB; screenshot + store only the new ones.
    await screenshotNew(games, { category: "originals" });
  },
};
export default casino;
