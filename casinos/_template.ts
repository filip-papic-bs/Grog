/**
 * CASINO FLOW TEMPLATE
 * ====================
 * Copy this to casinos/<name>.ts and write the steps for ONE casino.
 * Everything here runs through plain Playwright — no AI, nothing invented.
 *
 * The flow gets a context with:
 *   page      — the raw Playwright Page (full control: page.click, page.locator, …)
 *   human     — human-like actions (pauses, scrolls, mouse, overlay dismissal)
 *   collect   — pull REAL games out of the DOM by selector (see grammar below)
 *   shoot(g)  — screenshot the current viewport for game `g`
 *   record(g) — add a game to the results (collect/shoot already do this)
 *   log(msg)  — print a line
 *
 * SELECTOR GRAMMAR for collect():
 *   tile:  "a.game-card"        one element per game
 *   name:  ".title"             -> that sub-element's text
 *   name:  "img@alt"            -> a sub-element's attribute
 *   url:   "@href"              -> the TILE element's own attribute
 *   thumb: "img@src"            -> a sub-element's attribute
 *   (relative urls are auto-resolved to absolute; nothing is faked)
 *
 * STEPS available:
 *   await human.goto(url)
 *   await human.pause(1500, 4000)              // explicit wait (min/max ms) when you need one
 *   await human.dismiss(["play for fun"])      // close cookie/age/geo popups (+extra words)
 *   await human.scroll(800)                    // scroll a bit
 *   await human.scrollToBottom({ steps: 25 })  // load all lazy tiles
 *   await human.click("button.demo")           // click something
 *   await page.waitForSelector("...")          // raw Playwright is available too
 */
import type { Casino } from "../src/types.js";

const casino: Casino = {
  name: "Example",
  startUrl: "https://example.com/casino/originals",

  async flow({ page, human, collect, screenshotNew, log }) {
    // 1) open the listing page and let the tiles load
    await human.goto(casino.startUrl);
    await human.dismiss();
    await page
      .waitForSelector("a[href*='/game']", { state: "visible", timeout: 30000 })
      .catch(() => log("tiles not found — tune the selector"));
    await human.scrollToBottom();

    // 2) collect the real games (TUNE THESE SELECTORS for the casino).
    //    `id` is the game's stable id from the grid cell — the dedup key. If the
    //    cell has no id, omit it and the key falls back to the URL slug.
    const games = await collect({
      tile: "a[href*='/game']",
      id: "img@id",
      name: "img@alt",
      url: "@href",
      thumb: "img@src",
    });
    log(`found ${games.length} games`);

    // 3) skip anything already in the DB; screenshot + store only the new ones.
    await screenshotNew(games, { category: "originals" });
  },
};
export default casino;

/* -------------------------------------------------------------------------
 * SPA CASINOS (e.g. Stake): a hard goto() to a game URL reloads the page and can
 * bounce back to the home page. Pass nav:"click" so screenshotNew CLICKS each
 * tile (client-side navigation) instead, and listingSelector so it can wait for
 * the grid again after going back:
 *
 *   await screenshotNew(games, {
 *     category: "originals",
 *     nav: "click",
 *     listingSelector: TILE,
 *   });
 *
 * See casinos/stake.ts for a full working example.
 * ------------------------------------------------------------------------- */
