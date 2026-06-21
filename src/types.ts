import type { Page, BrowserContext } from "playwright";

/** A real game scraped from a casino. Nothing here is ever invented — names come
 *  from actual DOM text/attributes, urls from real hrefs or real navigations. */
export interface Game {
  name: string;
  url: string;          // "" if the game has no real URL (SPA tile) — never faked
  thumb?: string;
  id?: string;          // the casino's own stable id for the game (from the grid cell)
  screenshot?: string;  // path relative to data/ once captured
}

/** How to pull games out of a listing page's DOM.
 *  Selector grammar:
 *    "a.card"            -> element's textContent
 *    "a.card@href"       -> that element's `href` attribute
 *    "@href"             -> the tile element's OWN attribute
 *    "img@src"           -> sub-element's attribute
 */
export interface CollectSpec {
  tile: string;        // selector matching ONE element per game
  name?: string;
  url?: string;
  thumb?: string;
  id?: string;         // the game's stable id from the cell, e.g. "img@id" or "@data-id"
  limit?: number;
}

export interface Human {
  /** Navigate like a person: go, wait for load, settle a random beat. */
  goto(url: string): Promise<void>;
  /** Sleep a random time between min and max ms (defaults 600–1600). */
  pause(minMs?: number, maxMs?: number): Promise<void>;
  /** Scroll to the bottom to trigger lazy-loading (stops when height stops growing). */
  scrollToBottom(opts?: { steps?: number }): Promise<void>;
  /** Scroll by roughly `px` pixels. */
  scroll(px?: number): Promise<void>;
  /** Click a selector. */
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  /** Best-effort dismissal of cookie / age / geo overlays. */
  dismiss(extraWords?: string[]): Promise<void>;
}

export interface Ctx {
  page: Page;
  context: BrowserContext;
  human: Human;
  casino: string;
  /** Extract real games from the current page's DOM. */
  collect(spec: CollectSpec): Promise<Game[]>;
  /** Screenshot the current viewport for `game`, store path on it, record it. */
  shoot(game: Game): Promise<void>;
  /** The core formula: for each game, SKIP if already in the DB (don't even open
   *  it); otherwise open its URL, wait for it to render, screenshot it, and store
   *  it. `category` tags the list it came from (e.g. "originals"). `waitFor` is a
   *  selector for the rendered game (e.g. "canvas") — we wait for it before the
   *  shot so we don't capture the loading/lobby state. `settle` is how long (ms) to
   *  wait after load before shooting, for the game to draw its first frame
   *  (default 2500; bump it for heavier games). */
  screenshotNew(
    games: Game[],
    opts?: {
      category?: string;
      waitFor?: string;
      settle?: number;
      /** "goto" = hard navigate (default; real-page casinos like BetFury).
       *  "click" = click the tile in the listing for client-side nav — required
       *  for SPAs like Stake, where a hard reload bounces back to the home page. */
      nav?: "goto" | "click";
      /** For nav:"click" — selector to wait for after going back to the listing. */
      listingSelector?: string;
    },
  ): Promise<void>;
  /** Record a game (with whatever screenshot/url it has) into the run results. */
  record(game: Game): void;
  log(msg: string): void;
}

export interface Casino {
  name: string;
  startUrl: string;
  /** Per-casino default for headless mode. Omit to inherit the global default
   *  (headful). A CLI flag (--headless/--headful) still overrides this. */
  headless?: boolean;
  /** Per-casino browser channel, e.g. "chrome" to drive real Google Chrome.
   *  A CLI flag (--chrome/--channel) still overrides this. */
  channel?: string;
  /** Write the flow step by step. Return the games you found (optional —
   *  anything you `shoot`/`record` is already captured). */
  flow(ctx: Ctx): Promise<Game[] | void>;
}
