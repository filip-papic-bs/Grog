import type { Casino } from "../src/types.js";

const TILE = "[data-analytics^='grid-casino-group-stake-originals'] a.link";

const casino: Casino = {
  name: "Stake",
  startUrl: "https://stake.com/casino/group/stake-originals",
  headless: false,
  channel: "chrome",

  async flow({ page, human, collect, snapshot, log }) {
    log("opening Stake originals…");
    await human.goto(casino.startUrl);

    // Stake's originals grid shows a SUBSET + a "Load more" button. The "only 8
    // games" bug is a DEGRADED page load: the grid comes up partial and "Load
    // more" is present but clicking it does nothing. The reliable signal for a bad
    // load is exactly that — button visible but the count won't grow. When we see
    // it, reload and retry the whole acquisition (a fresh load usually succeeds).
    let games: Awaited<ReturnType<typeof collect>> = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      log(`grid attempt ${attempt}/4 — waiting for grid…`);
      await page
        .waitForSelector(TILE, { state: "visible", timeout: 60000 })
        .catch(() => log("grid not found — Cloudflare may still be blocking"));
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

      // Click "Load more" until it's gone. Exact "load more" only (not "view all"
      // / "reload bonuses"). `degraded` = button shown but click added no tiles.
      let degraded = false;
      for (let clicks = 0; clicks < 15; clicks++) {
        const more = page.getByText(/^load more$/i).first();
        if (!(await more.isVisible().catch(() => false))) break;
        const before = await page.locator(TILE).count().catch(() => 0);
        await more.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await more.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(700);
        const after = await page.locator(TILE).count().catch(() => 0);
        log(`   load more #${clicks + 1}: ${before} → ${after} tiles`);
        if (after === before) { degraded = true; break; } // button did nothing
      }

      games = await collect({
        tile: TILE,
        id: "img@id",
        name: "img@alt",
        url: "@href",
        thumb: "img@src",
      });
      log(`   collected ${games.length} games`);

      if (games.length > 0 && !degraded) break; // good, complete load
      if (attempt < 4) {
        log(`   grid looks partial (degraded load) — reloading and retrying`);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    }

    for (const g of games)
      g.name = g.name.replace(/\b\w/g, (c) => c.toUpperCase());
    log(`found ${games.length} games on the page`);

    await snapshot(games, {
      category: "originals",
      nav: "click",
      listingSelector: TILE,
      listingUrl: casino.startUrl, // re-open the grid if a game leaves us on about:blank/challenge
      waitFor: ".game-content.stake-original",
      settle: 500,
      recoverText: [
        "something's gone wrong",
        "try refreshing",
        "something went wrong",
      ],
    });
  },
};
export default casino;
