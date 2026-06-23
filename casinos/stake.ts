import type { Casino, Game } from "../src/types.js";

const CATEGORIES = [
  {
    key: "new-releases",
    tab: "new-releases-category-button",
    grid: "grid-casino-home-new-releases",
  },
  {
    key: "slots",
    tab: "slots-category-button",
    grid: "grid-casino-home-slots",
  },
  {
    key: "stake-originals",
    tab: "stake-originals-category-button",
    grid: "grid-casino-home-stake-originals",
  },
];

const casino: Casino = {
  name: "Stake",
  startUrl: "https://stake.com/casino/home/new-releases",
  headless: false,
  channel: "chrome",

  async flow({ page, collect, snapshot, log }) {
    const NAV = "[data-analytics='slots-category-button']";
    const ERRORS = [
      "something's gone wrong",
      "something went wrong",
      "try refreshing",
      "our team has been notified",
    ];
    const isBroken = async () => {
      const t = ((await page.textContent("body").catch(() => "")) || "")
        .toLowerCase()
        .replace(/’/g, "'");
      return ERRORS.some((p) => t.includes(p));
    };

    log("opening Stake casino home…");
    log(
      "if a Cloudflare 'are you human' check appears, solve it once (~45s per try)…",
    );

    let navReady = false;
    for (let attempt = 1; attempt <= 4 && !navReady; attempt++) {
      try {
        if (attempt === 1) {
          await page.goto(casino.startUrl, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });
        } else {
          log(`   reload & retry (${attempt}/4)…`);
          await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
        }
      } catch {
        log(`   initial load timed out (${attempt}/4) — reloading…`);
        continue;
      }
      const navUp = await page
        .waitForSelector(NAV, { state: "visible", timeout: 45000 })
        .then(() => true)
        .catch(() => false);
      if (await isBroken()) {
        log(`   Stake error page ("something's gone wrong") — refreshing…`);
        continue;
      }
      navReady = navUp;
    }
    if (!navReady)
      log(
        "nav bar still not found — Cloudflare/Stake error; wait a few minutes and rerun",
      );

    const all: Game[] = [];

    for (const cat of CATEGORIES) {
      const TILE = `[data-analytics^='${cat.grid}'] a.link`;
      let tilesUp = false;
      for (let attempt = 1; attempt <= 3 && !tilesUp; attempt++) {
        log(
          attempt === 1
            ? `→ ${cat.key}: clicking tab…`
            : `   ${cat.key}: recovering, retry ${attempt}/3…`,
        );
        await page
          .click(`[data-analytics='${cat.tab}']`, { timeout: 10000 })
          .catch(() => log(`   couldn't click ${cat.key} tab`));
        tilesUp = await page
          .waitForSelector(TILE, { state: "visible", timeout: 30000 })
          .then(() => true)
          .catch(() => false);
        if (tilesUp) break;
        if (await isBroken()) {
          log(`   ${cat.key}: Stake error page — refreshing & recovering…`);
          await page
            .reload({ waitUntil: "domcontentloaded", timeout: 45000 })
            .catch(() => {});
          await page
            .waitForSelector(NAV, { state: "visible", timeout: 45000 })
            .catch(() => {});
        } else {
          log(`   no tiles appeared for ${cat.key}`);
          break;
        }
      }
      await page
        .waitForLoadState("networkidle", { timeout: 3000 })
        .catch(() => {});

      const games = await collect({
        tile: TILE,
        id: "img@id",
        name: "img@alt",
        url: "@href",
        thumb: "img@src",
      });
      for (const g of games) {
        g.name = g.name.replace(/\b\w/g, (c) => c.toUpperCase());
        g.category = cat.key;
      }
      log(`   ${cat.key}: collected ${games.length} links`);
      all.push(...games);
    }

    log(`total: ${all.length} links across ${CATEGORIES.length} categories`);
    await snapshot(all, { category: "stake", capture: false });
  },
};
export default casino;
