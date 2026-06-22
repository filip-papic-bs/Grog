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
```

> **Passing flags through npm:** npm swallows `--flags`, so put `--` first:
> `npm run grog -- run stake --profile .profile/stake`. Or skip npm:
> `npx tsx src/cli.ts run stake --profile .profile/stake`.

The report is `data/report.html` — a grid of screenshots grouped by casino, each with its
real name, category and URL.

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
