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
    const { runAnalysis } = await import("./analyze.js");
    const p = await runAnalysis();
    console.log(`✔ Trend report: ${p}\n  open: file://${p}`);
    return;
  }

  if (cmd === "run") {
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

    // Pipeline: once the harvest is done, immediately generate the AI trend
    // report from the fresh snapshot (skip with --no-ai). Stake-only for now.
    if (flags["no-ai"] !== true && names.includes("stake")) {
      try {
        const { runAnalysis } = await import("./analyze.js");
        const tp = await runAnalysis();
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
  npm run grog analyze               AI slot-trend report from the latest snapshot
                                     (OpenRouter; set OPENROUTER_API_KEY in .env;
                                     GROG_AI_MODEL to pick the model, GROG_AI_WEB=1
                                     to let it web-search each game)

Flags:
  --headless          force headless (overrides a casino's own setting)
  --headful           force headful (overrides a casino's own setting)
  --chrome            drive real Google Chrome (better Cloudflare pass rate)
  --proxy <url>       route through a proxy/VPN (for ISP-blocked casinos);
                      e.g. http://host:8080 or http://user:pass@host:8080
  --profile <dir>     use a persistent browser profile (keeps a solved
                      Cloudflare challenge alive between runs)

Tip for Cloudflare-heavy sites (Stake): run headful with real Chrome + a profile,
solve the check by hand once, then reruns reuse the clearance cookie:
  npm run grog -- run stake --chrome --profile .profile/stake

Report: file://${REPORT_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
