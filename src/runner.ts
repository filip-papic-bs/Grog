import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startSession } from "./session.js";
import { writeSnapshot } from "./snapshot.js";
import type { Casino } from "./types.js";
import { CASINOS_DIR } from "./paths.js";

export async function listCasinos(): Promise<string[]> {
  const files = await readdir(CASINOS_DIR).catch(() => [] as string[]);
  return files
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .map((f) => f.replace(/\.ts$/, ""));
}

async function loadCasino(name: string): Promise<Casino> {
  const file = path.join(CASINOS_DIR, `${name}.ts`);
  const mod = await import(pathToFileURL(file).href);
  const casino: Casino = mod.default ?? mod.casino;
  if (
    !casino ||
    (typeof casino.flow !== "function" && typeof casino.fetch !== "function")
  ) {
    throw new Error(
      `casino file ${name}.ts must export a default Casino with a flow() or fetch()`,
    );
  }
  return casino;
}

export async function runCasino(
  name: string,
  opts: { headless?: boolean; profileDir?: string; channel?: string; proxyServer?: string },
): Promise<void> {
  const casino = await loadCasino(name);

  // Browserless path: fetch straight from the casino's API. No Playwright, no
  // Cloudflare browser challenge, no profile/IP escalation.
  if (typeof casino.fetch === "function") {
    console.log(`\n▶ ${casino.name}  (API, no browser)`);
    const log = (msg: string) => console.log(`   ${msg}`);
    const { games, raw } = await casino.fetch(log);
    const where = await writeSnapshot(
      casino.name,
      casino.name.toLowerCase(),
      games,
      raw,
    );
    console.log(`■ ${casino.name}: ${games.length} game(s) → ${where}`);
    return;
  }

  const headless = opts.headless ?? casino.headless ?? false;
  const channel = opts.channel ?? casino.channel ?? "chrome";
  const how = `${headless ? "headless" : "headful"}${channel ? `, ${channel}` : ""}${opts.proxyServer ? ", proxied" : ""}`;
  console.log(`\n▶ ${casino.name}  (${how})`);
  const session = await startSession({
    casino: casino.name,
    headless,
    profileDir: opts.profileDir,
    channel,
    proxyServer: opts.proxyServer,
  });

  try {
    await casino.flow!(session.ctx);
  } catch (err) {
    console.log(`   ⚠ flow error: ${String(err instanceof Error ? err.message : err)}`);
  } finally {
    await session.close();
  }
  console.log(`■ ${casino.name}: ${session.games.length} game(s) in snapshot`);
}
