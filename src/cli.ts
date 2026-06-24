import { rm } from "node:fs/promises";
import { runCasino, listCasinos } from "./runner.js";
import { buildReport } from "./report.js";
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

  const headless = flags.headless === true ? true : flags.headful === true ? false : undefined;
  const profileDir = typeof flags.profile === "string" ? flags.profile : undefined;
  const channel = flags.chrome === true ? "chrome" : typeof flags.channel === "string" ? flags.channel : undefined;
  const proxyServer = typeof flags.proxy === "string" ? flags.proxy : undefined;

  if (cmd === "list") {
    const names = await listCasinos();
    console.log("Casinos:\n" + names.map((n) => "  • " + n).join("\n"));
    return;
  }

  if (cmd === "report") {
    const p = await buildReport();
    console.log(`✔ Report: ${p}\n  open: file://${p}`);
    return;
  }

  if (cmd === "analyze") {
    const { runTrend } = await import("./trend.js");
    const p = await runTrend();
    console.log(`✔ Trend report: file://${p}`);
    return;
  }

  if (cmd === "run") {
    // --fresh wipes the persistent profile before launch. A profile flagged by
    // Cloudflare's interactive Turnstile (the looping "are you human" check)
    // stays flagged across reruns; burning it drops you back to the silent
    // managed challenge. Pair with a new IP (--proxy / VPN) for a clean slate.
    if (flags.fresh === true) {
      if (!profileDir) {
        console.log("⚠ --fresh has no effect without --profile <dir>");
      } else {
        await rm(profileDir, { recursive: true, force: true });
        console.log(`🧹 wiped profile ${profileDir} (fresh start)`);
      }
    }

    let names = positional;
    if (names.length === 0 || names[0] === "all") names = await listCasinos();
    for (const n of names) {
      try {
        await runCasino(n, { headless, profileDir, channel, proxyServer });
      } catch (err) {
        console.log(`✖ ${n}: ${err instanceof Error ? err.message : err}`);
      }
    }
    const p = await buildReport();
    console.log(`\n✔ Report: file://${p}`);

    // Pipeline: once every casino is harvested, pool all their slots and
    // generate ONE casino-agnostic AI trend report (skip with --no-ai).
    if (flags["no-ai"] !== true) {
      try {
        const { runTrend } = await import("./trend.js");
        const tp = await runTrend();
        console.log(`✔ Trend report: file://${tp}`);
      } catch (err) {
        console.log(`✖ analyze: ${err instanceof Error ? err.message : err}`);
      }
    }
    return;
  }

  console.log(`grog — competitor casino snapshots (plain Playwright, no AI)

Each run captures the WHOLE listing for a casino into a timestamped snapshot
(data/snapshots/<casino>/<stamp>/ — games.json + shots/). Nothing is deduped
against history, so two snapshots can be diffed (by AI) to find what changed.

Usage:
  npm run grog list                  list casino flow files
  npm run grog run <name>            run one casino (e.g. betfury)
  npm run grog run all               run every casino
  npm run grog report                rebuild the HTML report (latest snapshots)
  npm run grog analyze               ONE pooled AI slot-trend report across all
                                     casinos (themes/RTP/volatility ranked + Top 10)
                                     (OpenRouter; set OPENROUTER_API_KEY in .env;
                                     MODEL to pick the model, GROG_AI_WEB=1
                                     to let it web-search each game)

Flags:
  --headless          force headless (overrides a casino's own setting)
  --headful           force headful (overrides a casino's own setting)
  --chrome            drive real Google Chrome (better Cloudflare pass rate)
  --proxy <url>       route through a proxy/VPN (for ISP-blocked casinos);
                      e.g. http://host:8080 or http://user:pass@host:8080
  --profile <dir>     use a persistent browser profile (keeps a solved
                      Cloudflare challenge alive between runs)
  --fresh             wipe the --profile dir before launch (resets a profile
                      that Cloudflare flagged into the looping human-check)

Stake now uses its public GraphQL API directly (no browser, no Cloudflare):
  npm run grog -- run stake

For Cloudflare-heavy *browser-path* casinos: run headful with real Chrome + a
profile, solve the check by hand once, then reruns reuse the clearance cookie:
  npm run grog -- run <casino> --chrome --profile .profile/<casino>
If it gets stuck in the looping "are you human" check, the profile+IP are
flagged — change your VPN/exit IP, then wipe the profile and rerun with --fresh.

Report: file://${REPORT_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
