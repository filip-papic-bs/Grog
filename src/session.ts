import { chromium, type Browser, type BrowserContext } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeHuman } from "./human.js";
import type { Ctx, Game, CollectSpec, Snapshot } from "./types.js";
import { DATA_DIR, snapshotsDirFor, slugify } from "./paths.js";

export interface SessionOpts {
  casino: string;
  headless: boolean;
  profileDir?: string;
  channel?: string;
  proxyServer?: string;
}

function parseProxy(
  s?: string,
): { server: string; username?: string; password?: string } | undefined {
  if (!s) return undefined;
  try {
    const u = new URL(s);
    const server = `${u.protocol}//${u.host}`;
    if (u.username) {
      return {
        server,
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      };
    }
    return { server };
  } catch {
    return { server: s };
  }
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
  const contextOpts = {
    viewport,
    locale: "en-US",
    timezoneId: "Europe/Belgrade",
    deviceScaleFactor: 1,
  };
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];

  const proxy = parseProxy(opts.proxyServer);

  let context: BrowserContext;
  let browser: Browser | undefined;
  if (opts.profileDir) {
    context = await chromium.launchPersistentContext(opts.profileDir, {
      headless: opts.headless,
      channel: opts.channel,
      args: launchArgs,
      proxy,
      ...contextOpts,
    });
  } else {
    browser = await chromium.launch({
      headless: opts.headless,
      channel: opts.channel,
      args: launchArgs,
      proxy,
    });
    context = await browser.newContext(contextOpts);
  }

  await context.addInitScript(
    "globalThis.__name = globalThis.__name || ((f) => f);" +
      "try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}",
  );

  const page = context.pages()[0] ?? (await context.newPage());
  const human = makeHuman(page);

  let dead = false;
  const markDead = () => {
    dead = true;
  };
  page.on("close", markDead);
  context.on("close", markDead);
  browser?.on("disconnected", markDead);

  const capturedAt = new Date().toISOString();
  const stamp = capturedAt.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const runDir = path.join(snapshotsDirFor(opts.casino), stamp);
  const shotsDir = path.join(runDir, "shots");
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
          if (
            (attr === "href" || attr === "src") &&
            v &&
            !/^https?:/i.test(v)
          ) {
            try {
              return new URL(v, location.href).href;
            } catch {
              return v;
            }
          }
          return v;
        }
        return (target.textContent || "").trim();
      };
      const out: { name: string; url: string; thumb: string; id: string }[] =
        [];
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

    const result: Game[] = [];
    const dedup = new Set<string>();
    for (const r of raw) {
      const name = (r.name || "").trim();
      const url = (r.url || "").trim();
      const id = (r.id || "").trim();
      if (!name && !url && !id) continue;
      const key = id || slugFromUrl(url) || name.toLowerCase();
      if (dedup.has(key)) continue;
      dedup.add(key);
      result.push({
        name: name || url,
        url,
        thumb: r.thumb || undefined,
        id: id || undefined,
      });
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

  const loadAndIdle = async () => {
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    await page
      .waitForLoadState("networkidle", { timeout: 1500 })
      .catch(() => {});
  };

  const waitForRender = async (waitFor: string | undefined, settle: number) => {
    if (waitFor) {
      await page
        .waitForSelector(waitFor, { state: "visible", timeout: 6000 })
        .catch(() => {});
    }
    await page.waitForTimeout(settle);
  };

  const withTimeout = <T>(
    p: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    const guard = new Promise<T>((_, rej) => {
      timer = setTimeout(
        () => rej(new Error(`timed out after ${ms}ms (${label})`)),
        ms,
      );
    });
    return Promise.race([p, guard]).finally(() => clearTimeout(timer));
  };

  const looksBroken = async (phrases: string[]): Promise<boolean> => {
    if (!phrases.length) return false;
    const txt = (
      (await page.textContent("body").catch(() => "")) || ""
    ).toLowerCase();
    return phrases.some((p) => txt.includes(p.toLowerCase()));
  };

  const snapshot = async (
    gamesIn: Game[],
    o?: {
      category?: string;
      waitFor?: string;
      settle?: number;
      nav?: "goto" | "click";
      listingSelector?: string;
      listingUrl?: string;
      recoverText?: string | string[];
      capture?: boolean;
    },
  ): Promise<Snapshot> => {
    const category = o?.category ?? "originals";
    const capture = o?.capture ?? true;
    const waitFor = o?.waitFor;
    const settle = o?.settle ?? 2500;
    const nav = o?.nav ?? "goto";
    const listingSelector = o?.listingSelector;
    const listingUrl = o?.listingUrl;

    const ensureListing = async (): Promise<boolean> => {
      if (dead || !listingSelector) return !dead;
      const here = await page
        .waitForSelector(listingSelector, { state: "visible", timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (here) return true;
      if (!listingUrl) return false;
      const where = page.url().startsWith("about:")
        ? "about:blank"
        : "off the listing";
      log(`   listing lost (${where}) — reopening ${listingUrl}`);
      await page
        .goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
        .catch(() => {});
      return page
        .waitForSelector(listingSelector, { state: "visible", timeout: 30000 })
        .then(() => true)
        .catch(() => {
          log(`   ⚠ listing still not back`);
          return false;
        });
    };
    const recoverText = o?.recoverText
      ? Array.isArray(o.recoverText)
        ? o.recoverText
        : [o.recoverText]
      : [];
    const writeArtifacts = async (): Promise<Snapshot> => {
      const snap: Snapshot = {
        casino: opts.casino,
        category,
        capturedAt,
        games: gamesIn,
      };
      await writeFile(
        path.join(runDir, "games.json"),
        JSON.stringify(snap, null, 2),
      );
      const cats = [...new Set(gamesIn.map((g) => g.category).filter(Boolean))];
      let links: string;
      if (cats.length > 1) {
        links = cats
          .map((c) => {
            const urls = gamesIn
              .filter((g) => g.category === c)
              .map((g) => g.url)
              .filter(Boolean);
            return `# ${c} (${urls.length})\n${urls.join("\n")}`;
          })
          .join("\n\n");
      } else {
        links = gamesIn
          .map((g) => g.url)
          .filter(Boolean)
          .join("\n");
      }
      await writeFile(
        path.join(runDir, "links.txt"),
        links + (links ? "\n" : ""),
      );
      return snap;
    };

    if (!capture) {
      for (const g of gamesIn) record(g);
      const snap = await writeArtifacts();
      log(
        `links-only: ${gamesIn.length} link(s) → ${path.relative(DATA_DIR, runDir)} (games.json + links.txt)`,
      );
      return snap;
    }

    const cap = Number(process.env.GROG_LIMIT) || 0;
    const toShoot = cap ? gamesIn.slice(0, cap) : gamesIn;
    log(`${gamesIn.length} on page · capturing ${toShoot.length} (${nav})`);

    const PER_GAME_MS = 35_000;

    let shot = 0;
    let misses = 0;
    for (const g of toShoot) {
      if (dead) {
        log(
          `⚠ browser closed — aborting after ${shot} shot(s), saving partial snapshot`,
        );
        break;
      }
      const path = (() => {
        try {
          return new URL(g.url).pathname;
        } catch {
          return g.url;
        }
      })();

      if (nav === "click") await ensureListing();

      const open = async () => {
        if (nav === "click") {
          const tile = page.locator(`a[href$='${path}']`).first();
          await tile.scrollIntoViewIfNeeded().catch(() => {});
          log(`→ ${g.name}: clicking ${path}`);
          try {
            await tile.click({ timeout: 6000 });
          } catch {
            log(`   click intercepted by an overlay — forcing`);
            await tile.click({ timeout: 6000, force: true });
          }
          await page
            .waitForURL(
              (u) => u.pathname.endsWith(path) || u.href.includes(path),
              { timeout: 15000 },
            )
            .catch(() => {});
        } else {
          log(`→ ${g.name}: opening ${g.url}`);
          await human.goto(g.url);
          await human.dismiss();
        }

        await loadAndIdle();

        for (
          let tries = 0;
          tries < 2 && (await looksBroken(recoverText));
          tries++
        ) {
          log(`   error page detected — refreshing (${tries + 1}/2)`);
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await loadAndIdle();
        }

        await waitForRender(waitFor, settle);
      };

      try {
        await withTimeout(open(), PER_GAME_MS, g.name);
      } catch (e) {
        log(
          `   ⚠ ${g.name}: ${e instanceof Error ? e.message : e} — capturing as-is and moving on`,
        );
      }

      const url = page.url();
      const landed = url.replace(/^https?:\/\//, "");
      const onChallenge = /__cf_chl|cdn-cgi\/challenge/.test(url);
      const reached = url.includes(path) && !onChallenge;
      if (onChallenge) {
        log(
          `   ⚠ ${g.name}: bounced to a Cloudflare challenge — skipping screenshot`,
        );
      } else {
        log(`   ${reached ? "at" : "⚠ NOT on game, at"} ${landed}`);
        await shoot(g).catch((e) =>
          log(`   screenshot failed for ${g.name}: ${e}`),
        );
        shot++;
      }

      misses = reached ? 0 : misses + 1;
      if (misses >= 5) {
        log(
          `⚠ ${misses} games in a row failed — session looks broken, saving partial snapshot`,
        );
        break;
      }

      if (nav === "click") {
        await page
          .goBack({ waitUntil: "domcontentloaded", timeout: 10000 })
          .catch(() => {});
        await ensureListing();
      }
    }
    for (const g of gamesIn) record(g);
    const snap = await writeArtifacts();
    log(
      `snapshot: ${gamesIn.length} game(s), ${shot} shot(s) → ${path.relative(DATA_DIR, runDir)}`,
    );
    return snap;
  };

  const log = (msg: string) => console.log(`   ${msg}`);

  const ctx: Ctx = {
    page,
    context,
    human,
    casino: opts.casino,
    collect,
    shoot,
    snapshot,
    record,
    log,
  };
  return {
    ctx,
    games,
    async close() {
      await context.close().catch(() => {});
      await browser?.close().catch(() => {});
    },
  };
}
