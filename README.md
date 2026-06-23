# 🏴‍☠️ Grog — Casino Trend Radar

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
npm run grog analyze                     # AI slot-trend report from the latest snapshot
```

> **Passing flags through npm:** npm swallows `--flags`, so put `--` first:
> `npm run grog -- run stake --profile .profile/stake`. Or skip npm:
> `npx tsx src/cli.ts run stake --profile .profile/stake`.

The report is `data/report.html` — a grid of screenshots grouped by casino, each with its
real name, category and URL.

### AI trend report (`analyze`)

`npm run grog analyze` reads the latest Stake snapshot, asks an OpenRouter model to infer
each game's **theme / visual style / mechanics**, then writes a concise slot-trends brief plus
game-art cards (using the captured thumbnails) to a **versioned** report.

- **Pipeline:** a harvest auto-runs analyze when done — `npm run grog -- run stake …` harvests
  *and* generates the report (pass `--no-ai` to skip). Or run `analyze` on its own anytime.
- **Versioned reports:** each run writes `data/reports/<snapshot-stamp>/report.html` (+ a
  `report.json` with the structured per-game data) instead of overwriting one file — so reports
  accumulate and can be compared over time. The web UI's **Reports** tab lists every version.
- Needs `OPENROUTER_API_KEY` in `.env`.
- Model: defaults to `google/gemini-2.5-flash-lite` (cheap + good slot knowledge; a run costs
  well under a cent). Override with `GROG_AI_MODEL=...` (e.g. `meta-llama/llama-3.1-8b-instruct`
  is ~5× cheaper but weaker). `GROG_AI_WEB=1` appends `:online` so the model web-searches each
  game (more accurate, small extra cost).
- **Originals** are only reported as *new since the previous snapshot* (a diff). The first run
  is a baseline — originals are noted but excluded from the trend brief until there's a prior
  run to compare against.

### Flags

| Flag                       | Meaning                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--headless` / `--headful` | force a mode (default is headful; a casino can set its own — CLI wins)                                                                           |
| `--chrome`                 | drive real Google Chrome instead of bundled Chromium (better Cloudflare pass rate)                                                               |
| `--profile <dir>`          | persistent browser profile, e.g. `--profile .profile/stake`. Solve a Cloudflare check by hand once and the clearance cookie persists across runs |
| `--fresh`                  | ignore the catalog and re-screenshot every game                                                                                                  |

`GROG_LIMIT=5 npm run grog -- run betfury` caps the number of **new** games per run (handy
for quick tests).

---
