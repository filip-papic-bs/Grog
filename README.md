# 🏴‍☠️ Grog — Originals Radar

Grog screenshots competitor casinos' **original games** so you can scout what they're
shipping. It's plain **Playwright + TypeScript** with a **flow file per casino**. It keeps
a **catalog (SQLite)** of every game it has already captured, so each run **sees all games,
skips the ones already checked, and only opens + screenshots the new ones**.

**No AI. Nothing invented.** Game names and URLs come only from the real page DOM — if a
game has no real link it's kept without one, never fabricated. (AI trend analysis may be
layered on later as a separate step.)

---

## Setup

```bash
cd grog
npm install
npx playwright install chromium    # one-time browser download
```

Requires Node 18+ (developed on Node 24). Real Google Chrome is recommended for
Cloudflare-heavy sites (the `--chrome` / per-casino `channel: "chrome"` option).

---

## Usage

```bash
npm run grog list                        # list the casino flow files
npm run grog run betfury                 # run one casino
npm run grog run all                     # run every casino
npm run grog recheck stake dice          # forget a game so it re-captures next run
npm run grog recheck stake               # forget a whole casino
npm run grog report                      # rebuild data/report.html from the catalog
```

> **Passing flags through npm:** npm swallows `--flags`, so put `--` first:
> `npm run grog -- run stake --profile .profile/stake`. Or skip npm:
> `npx tsx src/cli.ts run stake --profile .profile/stake`.

The report is `data/report.html` — a grid of screenshots grouped by casino, each with its
real name, category and URL.

### Flags

| Flag | Meaning |
|------|---------|
| `--headless` / `--headful` | force a mode (default is headful; a casino can set its own — CLI wins) |
| `--chrome` | drive real Google Chrome instead of bundled Chromium (better Cloudflare pass rate) |
| `--profile <dir>` | persistent browser profile, e.g. `--profile .profile/stake`. Solve a Cloudflare check by hand once and the clearance cookie persists across runs |
| `--fresh` | ignore the catalog and re-screenshot every game |

`GROG_LIMIT=5 npm run grog -- run betfury` caps the number of **new** games per run (handy
for quick tests).

---

## How it works

Per casino, one run:

1. **Open** the originals listing and wait (selector-based) for the grid — for Cloudflare
   sites that also confirms the "are you human" check has cleared.
2. **Collect** every game tile from the real DOM (name, URL, thumbnail, and a stable
   `game_id` read from the cell).
3. **Diff** each tile against the SQLite catalog (preloaded into a Set). Games already
   catalogued are **skipped without opening them**.
4. **Capture** only the new ones — open the game, wait for it to render, screenshot, and
   store it in the catalog.
5. **Report** is rebuilt from the catalog.

So the first run on a casino captures everything; later runs only do work for genuinely new
games. Use `recheck` to forget games (e.g. to re-shoot a bad capture) or `--fresh` to redo
all.

---

## Writing a casino flow

Each casino is one file in `casinos/<name>.ts` — copy `casinos/_template.ts`. The flow gets:

- **`human`** — `goto(url)`, `scrollToBottom()`, `dismiss([extraWords])`, `click(sel)`,
  `scroll(px)`, `pause(min,max)` (explicit wait, only if you need one)
- **`collect({ tile, id?, name?, url?, thumb? })`** — pull real games from the DOM
- **`screenshotNew(games, opts?)`** — the formula: skip games already in the catalog,
  screenshot + store the new ones
- **`page`** — the raw Playwright `Page` for anything custom
- **`log(msg)`**

```ts
import type { Casino } from "../src/types.js";

const TILE = "a.card[href*='/casino/games/']";

const casino: Casino = {
  name: "BetFury",
  startUrl: "https://betfury.com/casino/originals",
  async flow({ page, human, collect, screenshotNew, log }) {
    await human.goto(casino.startUrl);
    await human.dismiss();
    await page.waitForSelector(TILE, { state: "visible", timeout: 30000 }).catch(() => {});
    await human.scrollToBottom();

    const games = await collect({ tile: TILE, name: "img@alt", url: "@href", thumb: "img@src" });
    log(`found ${games.length} games`);

    await screenshotNew(games, { category: "originals" });
  },
};
export default casino;
```

### Selector grammar for `collect`

| Form | Result |
|------|--------|
| `".title"` | the sub-element's text |
| `"img@alt"` | a sub-element's attribute |
| `"@href"` | the **tile** element's own attribute |

Relative URLs are auto-resolved. Empty matches are skipped — never faked. The dedup
`game_id` comes from `id` if set (e.g. `"img@id"`), else the URL slug.

### Per-casino options

Set these on the `Casino` object so the casino "just works" without remembering flags:

```ts
headless: false,        // force headful (Cloudflare-heavy sites)
channel: "chrome",      // drive real Chrome
```

And `screenshotNew` options:

```ts
await screenshotNew(games, {
  category: "originals",
  settle: 3500,          // ms to wait after load for the game to draw (tune per casino)
  waitFor: "canvas",     // optional: wait for a game element before the shot
  nav: "click",          // SPA mode — see below
  listingSelector: TILE, // for nav:"click", what to wait for after going back
});
```

### SPA casinos (e.g. Stake)

Single-page apps bounce a hard `goto(gameUrl)` back to the home page. Use **`nav: "click"`**
so `screenshotNew` clicks each tile (client-side navigation, no reload) and goes back
between games. `casinos/stake.ts` is the worked example.

---

## Layout

```
src/
  types.ts     Casino / Game / Ctx interfaces
  paths.ts     project paths + slugify
  human.ts     navigation, scrolling, overlay dismissal
  session.ts   launches Playwright, builds the flow context (collect / screenshotNew)
  db.ts        SQLite catalog (swap for a SQL server later — same interface)
  runner.ts    loads + runs a casino's flow
  report.ts    builds data/report.html from the catalog
  cli.ts       `npm run grog ...`
casinos/
  _template.ts documented starting point
  betfury.ts   tuned reference (real game links)
  stake.ts     tuned reference (SPA, click-nav, real Chrome + headful)
  <13 more>    real start URLs, selectors to tune per casino
data/
  grog.db      the catalog (SQLite)
  screenshots/ <casino>/<game>.png
  report.html
```

---

## Notes & limits

- **Tune selectors per casino.** `betfury.ts` and `stake.ts` are worked references; the
  others have real start URLs and `// <-- TUNE` markers. Run one, open the report, fix the
  `TILE` / `name` / `id` selectors, repeat. That's the per-casino "do it once" work.
- **Cloudflare** is an arms race. Real Chrome (`--chrome`) + headful + a `--profile` passes
  most checks (solve once by hand if prompted; the profile keeps the clearance). Some sites
  may still resist.
- **Names** are only as clean as the site's markup — adjust the `name:` selector (or
  post-process, as Stake/BetFury do) for tidier labels.
- Internal competitive research only; don't redistribute screenshots.
