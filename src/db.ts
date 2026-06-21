/**
 * Persistent game catalog. SQLite now (built-in node:sqlite, no native build);
 * swap this module's internals for a SQL-server client later — keep the same
 * `Db` interface and the rest of the app is unaffected.
 *
 * A game is identified by (casino, game_id). game_id is the casino's own stable
 * id for the game (read from the grid cell), so "already checked" survives across
 * runs and we skip it before ever opening it.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";

// Silence the one-time "SQLite is experimental" node warning.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const msg = typeof warning === "string" ? warning : (warning as Error)?.message;
  if (typeof msg === "string" && msg.includes("SQLite is an experimental")) return;
  return (_emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export interface GameRow {
  casino: string;
  game_id: string;
  name: string;
  url: string;
  thumb: string | null;
  category: string;
  screenshot: string | null;
  first_seen: string;
}

export class Db {
  private db: DatabaseSync;

  constructor(file = path.join(DATA_DIR, "grog.db")) {
    mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        casino      TEXT NOT NULL,
        game_id     TEXT NOT NULL,
        name        TEXT,
        url         TEXT,
        thumb       TEXT,
        category    TEXT,
        screenshot  TEXT,
        first_seen  TEXT NOT NULL,
        UNIQUE(casino, game_id)
      );
    `);
  }

  /** Has this game (casino + its grid id) been catalogued before? */
  has(casino: string, gameId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM games WHERE casino = ? AND game_id = ?")
      .get(casino, gameId);
  }

  /** Insert a newly-checked game. No-op if it somehow already exists. */
  add(row: GameRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO games
           (casino, game_id, name, url, thumb, category, screenshot, first_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.casino,
        row.game_id,
        row.name,
        row.url,
        row.thumb,
        row.category,
        row.screenshot,
        row.first_seen,
      );
  }

  /** All known game ids for a casino, as a Set — preloaded once so the run can
   *  diff every tile in memory instead of querying per game. */
  idsForCasino(casino: string): Set<string> {
    const rows = this.db
      .prepare("SELECT game_id FROM games WHERE lower(casino) = lower(?)")
      .all(casino) as { game_id: string }[];
    return new Set(rows.map((r) => (r.game_id || "").toLowerCase()));
  }

  /** Whole catalog, newest first — used to build the report. */
  all(): GameRow[] {
    return this.db
      .prepare("SELECT * FROM games ORDER BY first_seen DESC, casino, name")
      .all() as unknown as GameRow[];
  }

  /** Forget catalogued games so the next run re-captures them. Pass a game_id to
   *  forget one game, or omit it to forget the whole casino. Returns rows removed. */
  forget(casino: string, gameId?: string): number {
    const info = gameId
      ? this.db
          .prepare("DELETE FROM games WHERE lower(casino) = lower(?) AND lower(game_id) = lower(?)")
          .run(casino, gameId)
      : this.db.prepare("DELETE FROM games WHERE lower(casino) = lower(?)").run(casino);
    return Number(info.changes);
  }

  countForCasino(casino: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM games WHERE casino = ?").get(casino) as {
      c: number;
    };
    return r.c;
  }

  close(): void {
    this.db.close();
  }
}
