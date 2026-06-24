import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Game, Snapshot } from "./types.js";
import { DATA_DIR, snapshotsDirFor } from "./paths.js";

/**
 * Write a snapshot's artifacts (games.json + links.txt) to a fresh timestamped
 * run dir, in the SAME shape the browser session produces — so the rest of the
 * pipeline (report, analyze) doesn't care whether the games came from a real
 * browser or a direct API fetch. Returns the run dir.
 */
export async function writeSnapshot(
  casino: string,
  category: string,
  games: Game[],
  raw?: unknown,
): Promise<string> {
  const capturedAt = new Date().toISOString();
  const stamp = capturedAt.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const runDir = path.join(snapshotsDirFor(casino), stamp);
  await mkdir(runDir, { recursive: true });

  const snap: Snapshot = { casino, category, capturedAt, games };
  await writeFile(
    path.join(runDir, "games.json"),
    JSON.stringify(snap, null, 2),
  );

  // Full untouched API payload, so nothing the API returned is lost.
  if (raw !== undefined) {
    await writeFile(
      path.join(runDir, "raw-api.json"),
      JSON.stringify(raw, null, 2),
    );
  }

  const cats = [...new Set(games.map((g) => g.category).filter(Boolean))];
  let links: string;
  if (cats.length > 1) {
    links = cats
      .map((c) => {
        const urls = games
          .filter((g) => g.category === c)
          .map((g) => g.url)
          .filter(Boolean);
        return `# ${c} (${urls.length})\n${urls.join("\n")}`;
      })
      .join("\n\n");
  } else {
    links = games
      .map((g) => g.url)
      .filter(Boolean)
      .join("\n");
  }
  await writeFile(path.join(runDir, "links.txt"), links + (links ? "\n" : ""));

  return path.relative(DATA_DIR, runDir);
}
