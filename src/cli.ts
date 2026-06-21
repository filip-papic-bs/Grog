import { runCasino, listCasinos } from "./runner.js";
import { buildReport } from "./report.js";
import { Db } from "./db.js";
import { REPORT_PATH } from "./paths.js";

function parseFlags(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);

  // Leave undefined unless explicitly set, so each casino's own setting can apply.
  // --headless / --headful override the per-casino default; global default is headful.
  const headless = flags.headless === true ? true : flags.headful === true ? false : undefined;
  const profileDir = typeof flags.profile === "string" ? flags.profile : undefined;
  // --chrome drives real Google Chrome (more legitimate fingerprint than bundled Chromium)
  const channel = flags.chrome === true ? "chrome" : typeof flags.channel === "string" ? flags.channel : undefined;

  if (cmd === "list") {
    const names = await listCasinos();
    console.log("Casinos:\n" + names.map((n) => "  • " + n).join("\n"));
    return;
  }

  if (cmd === "recheck") {
    const [casino, gameId] = positional;
    if (!casino) {
      console.log("usage: npm run grog -- recheck <casino> [game_id]   (omit game_id to forget the whole casino)");
      return;
    }
    const db = new Db();
    const n = db.forget(casino, gameId);
    db.close();
    const what = gameId ? `${casino}/${gameId}` : `all of ${casino}`;
    console.log(`Forgot ${n} catalogued game(s) for ${what}. The next run will re-capture them.`);
    return;
  }

  if (cmd === "report") {
    const p = await buildReport();
    console.log(`✔ Report: ${p}\n  open: file://${p}`);
    return;
  }

  if (cmd === "run") {
    let names = positional;
    if (names.length === 0 || names[0] === "all") names = await listCasinos();
    const fresh = flags.fresh === true;
    const db = new Db();
    try {
      for (const n of names) {
        try {
          await runCasino(n, db, { headless, profileDir, channel, fresh });
        } catch (err) {
          console.log(`✖ ${n}: ${err instanceof Error ? err.message : err}`);
        }
      }
      const p = await buildReport(db);
      console.log(`\n✔ Report: file://${p}`);
    } finally {
      db.close();
    }
    return;
  }

  console.log(`grog — competitor casino screenshots (plain Playwright, no AI)

Usage:
  npm run grog list                  list casino flow files
  npm run grog run <name>            run one casino (e.g. betfury)
  npm run grog run all               run every casino
  npm run grog recheck <casino> [id] forget catalogued game(s) so they re-capture
  npm run grog report                rebuild the HTML report

Flags:
  --headless          force headless (overrides a casino's own setting)
  --headful           force headful (overrides a casino's own setting)
  --chrome            drive real Google Chrome (better Cloudflare pass rate)
  --fresh             ignore the catalog and re-screenshot every game
  --profile <dir>     use a persistent browser profile (keeps a solved
                      Cloudflare challenge alive between runs)

Tip for Cloudflare-heavy sites (Stake): run headful with real Chrome + a profile,
solve the check by hand once, then reruns reuse the clearance cookie:
  npm run grog -- run stake --chrome --profile .profile/stake

Report: file://${REPORT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
