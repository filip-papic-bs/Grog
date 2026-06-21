import { chromium, type BrowserContext } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { makeHuman } from "./human.js";
import type { Ctx, Game, CollectSpec } from "./types.js";
import type { Db } from "./db.js";
import { DATA_DIR, screenshotsDir, slugify } from "./paths.js";

export interface SessionOpts {
  casino: string;
  headless: boolean;
  db: Db;
  profileDir?: string; // persistent profile (keeps a solved Cloudflare challenge alive)
  channel?: string;    // e.g. "chrome" to drive real Google Chrome instead of bundled Chromium
  fresh?: boolean;     // ignore the DB and re-screenshot everything
}

export interface Session {
  ctx: Ctx;
  games: Game[];
  close(): Promise<void>;
}

function slugFromUrl(u: string): string {
  try {
    const p = new URL(u).pathname.replace(/\/+$/, "");
    return p.split("/").pop() || "";
  } catch {
    return "";
  }
}

export async function startSession(opts: SessionOpts): Promise<Session> {
  const viewport = { width: 1366, height: 850 };
  // No userAgent override: a hardcoded UA that disagrees with the real engine
  // version is a bot tell. Let the browser report its own (correct) UA.
  const contextOpts = {
    viewport,
    locale: "en-US",
    timezoneId: "Europe/Belgrade",
    deviceScaleFactor: 1,
  };
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
  ];

  let context: BrowserContext;
  if (opts.profileDir) {
    context = await chromium.launchPersistentContext(opts.profileDir, {
      headless: opts.headless,
      channel: opts.channel,
      args: launchArgs,
      ...contextOpts,
    });
  } else {
    const browser = await chromium.launch({
      headless: opts.headless,
      channel: opts.channel,
      args: launchArgs,
    });
    context = await browser.newContext(contextOpts);
  }

  // (1) tsx/esbuild injects a `__name(...)` helper into page.evaluate callbacks that
  //     isn't defined in the browser → "__name is not defined". Shim it (identity).
  // (2) Scrub navigator.webdriver (the #1 automation tell) on every page/frame.
  await context.addInitScript(
    "globalThis.__name = globalThis.__name || ((f) => f);" +
      "try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}",
  );

  const page = context.pages()[0] ?? (await context.newPage());
  const human = makeHuman(page);

  const shotsDir = screenshotsDir(opts.casino);
  await mkdir(shotsDir, { recursive: true });

  const games: Game[] = [];
  const recorded = new Set<string>();

  const record = (g: Game) => {
    const key = (g.url || g.name).toLowerCase();
    if (recorded.has(key)) return;
    recorded.add(key);
    games.push(g);
  };

  const collect = async (spec: CollectSpec): Promise<Game[]> => {
    const raw = await page.evaluate((s: CollectSpec) => {
      const pick = (el: Element, sel?: string): string => {
        if (!sel) return "";
        let target: Element | null = el;
        let attr: string | null = null;
        let q = sel;
        const at = sel.indexOf("@");
        if (at >= 0) {
          q = sel.slice(0, at);
          attr = sel.slice(at + 1);
        }
        if (q) target = el.querySelector(q);
        if (!target) return "";
        if (attr) {
          const v = target.getAttribute(attr) || "";
          if ((attr === "href" || attr === "src") && v && !/^https?:/i.test(v)) {
            try { return new URL(v, location.href).href; } catch { return v; }
          }
          return v;
        }
        return (target.textContent || "").trim();
      };
      const out: { name: string; url: string; thumb: string; id: string }[] = [];
      const tiles = Array.from(document.querySelectorAll(s.tile));
      for (const el of tiles) {
        out.push({
          name: pick(el, s.name),
          url: pick(el, s.url),
          thumb: pick(el, s.thumb),
          id: pick(el, s.id),
        });
        if (s.limit && out.length >= s.limit) break;
      }
      return out;
    }, spec);

    // collect sees ALL games (that's the point — so we can diff). No cap here.
    const result: Game[] = [];
    const dedup = new Set<string>();
    for (const r of raw) {
      const name = (r.name || "").trim();
      const url = (r.url || "").trim();
      const id = (r.id || "").trim();
      if (!name && !url && !id) continue; // skip empties — never fabricate
      const key = id || slugFromUrl(url) || name.toLowerCase();
      if (dedup.has(key)) continue;
      dedup.add(key);
      result.push({ name: name || url, url, thumb: r.thumb || undefined, id: id || undefined });
    }
    return result;
  };

  const shoot = async (game: Game) => {
    const slug = slugify(game.id || game.name || game.url || "game");
    const file = path.join(shotsDir, `${slug}.png`);
    await page.screenshot({ path: file, fullPage: false }).catch(() => {});
    game.screenshot = path.relative(DATA_DIR, file);
    record(game);
  };

  const gameKey = (g: Game): string =>
    (g.id && g.id.trim()) || slugFromUrl(g.url) || slugify(g.name) || "x";

  // Wait for a game to render after navigation (shared by goto + click modes).
  const waitForGame = async (waitFor: string | undefined, settle: number) => {
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    // Brief best-effort only: live game clients stream constantly and never go
    // "networkidle", so a long timeout here is pure dead time. The `settle` below
    // is the real "let the game draw its first frame" wait.
    await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
    if (waitFor) {
      await page.waitForSelector(waitFor, { state: "visible", timeout: 4000 }).catch(() => {});
    }
    await page.waitForTimeout(settle);
  };

  const screenshotNew = async (
    gamesIn: Game[],
    o?: {
      category?: string;
      waitFor?: string;
      settle?: number;
      nav?: "goto" | "click"; // "click" = client-side nav (SPAs like Stake)
      listingSelector?: string; // for "click": what to wait for after going back
    },
  ): Promise<void> => {
    const category = o?.category ?? "originals";
    const waitFor = o?.waitFor;
    const settle = o?.settle ?? 2500;
    const nav = o?.nav ?? "goto";
    const listingSelector = o?.listingSelector;
    const cap = Number(process.env.GROG_LIMIT) || 0; // cap NEW games (quick tests)
    // Preload every known id for this casino ONCE, then diff each tile in memory.
    const seen = opts.fresh ? new Set<string>() : opts.db.idsForCasino(opts.casino);
    const toShoot = gamesIn.filter((g) => !seen.has(gameKey(g).toLowerCase()));
    const skipped = gamesIn.length - toShoot.length;
    log(`${gamesIn.length} on page · ${skipped} already checked · ${toShoot.length} to capture (${nav})`);

    let shot = 0;
    let processed = 0;

    for (const g of toShoot) {
      if (cap && processed >= cap) break;
      processed++;
      const path = (() => {
        try { return new URL(g.url).pathname; } catch { return g.url; }
      })();

      try {
        if (nav === "click") {
          // Client-side navigation: click the tile in the listing (no hard reload,
          // so the SPA session/Cloudflare clearance is preserved and it won't bounce).
          const tile = page.locator(`a[href$='${path}']`).first();
          await tile.scrollIntoViewIfNeeded().catch(() => {});
          log(`→ ${g.name}: clicking ${path}`);
          await tile.click({ timeout: 10000 });
          await page
            .waitForURL((u) => u.pathname.endsWith(path) || u.href.includes(path), { timeout: 20000 })
            .catch(() => {});
        } else {
          log(`→ ${g.name}: opening ${g.url}`);
          await human.goto(g.url);
          await human.dismiss();
        }

        await waitForGame(waitFor, settle);
        const landed = page.url().replace(/^https?:\/\//, "");
        const reached = page.url().includes(path);
        log(`   ${reached ? "at" : "⚠ NOT on game, at"} ${landed}`);
        await shoot(g);
        shot++;

        if (nav === "click") {
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          if (listingSelector) {
            await page
              .waitForSelector(listingSelector, { state: "visible", timeout: 30000 })
              .catch(() => {});
          }
        }
      } catch (e) {
        log(`screenshot failed for ${g.name}: ${e}`);
      }

      opts.db.add({
        casino: opts.casino,
        game_id: gameKey(g),
        name: g.name,
        url: g.url,
        thumb: g.thumb ?? null,
        category,
        screenshot: g.screenshot ?? null,
        first_seen: new Date().toISOString(),
      });
    }
    log(`done: ${shot} screenshot(s) captured`);
  };

  const log = (msg: string) => console.log(`   ${msg}`);

  const ctx: Ctx = {
    page,
    context,
    human,
    casino: opts.casino,
    collect,
    shoot,
    screenshotNew,
    record,
    log,
  };
  return {
    ctx,
    games,
    async close() {
      await context.close().catch(() => {});
    },
  };
}
