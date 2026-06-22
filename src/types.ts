import type { Page, BrowserContext } from "playwright";

export interface Game {
  name: string;
  url: string;
  thumb?: string;
  id?: string;
  screenshot?: string;
  category?: string;
}

export interface Snapshot {
  casino: string;
  category: string;
  capturedAt: string;
  games: Game[];
}

export interface CollectSpec {
  tile: string;
  name?: string;
  url?: string;
  thumb?: string;
  id?: string;
  limit?: number;
}

export interface Human {
  goto(url: string): Promise<void>;
  pause(minMs?: number, maxMs?: number): Promise<void>;
  scrollToBottom(opts?: { steps?: number }): Promise<void>;
  scroll(px?: number): Promise<void>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  dismiss(extraWords?: string[]): Promise<void>;
}

export interface Ctx {
  page: Page;
  context: BrowserContext;
  human: Human;
  casino: string;
  collect(spec: CollectSpec): Promise<Game[]>;
  shoot(game: Game): Promise<void>;
  snapshot(
    games: Game[],
    opts?: {
      category?: string;
      waitFor?: string;
      settle?: number;
      nav?: "goto" | "click";
      listingSelector?: string;
      listingUrl?: string;
      recoverText?: string | string[];
      capture?: boolean;
    },
  ): Promise<Snapshot>;
  record(game: Game): void;
  log(msg: string): void;
}

export interface Casino {
  name: string;
  startUrl: string;
  headless?: boolean;
  channel?: string;
  flow(ctx: Ctx): Promise<Game[] | void>;
}
