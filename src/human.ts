import type { Page } from "playwright";
import type { Human } from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));

const DISMISS_WORDS = [
  "accept all", "accept", "i agree", "agree", "got it", "allow all", "allow",
  "enter", "i am over", "over 18", "18+", "yes", "continue", "ok", "confirm",
  "close", "dismiss",
];

export function makeHuman(page: Page): Human {
  const vp = () => page.viewportSize() ?? { width: 1366, height: 850 };

  const pause = async (minMs?: number, maxMs?: number) => {
    if (minMs == null) return;
    const lo = maxMs == null ? minMs : Math.min(minMs, maxMs);
    const hi = maxMs == null ? minMs : Math.max(minMs, maxMs);
    await sleep(hi <= lo ? lo : rnd(lo, hi));
  };

  const scroll = async (px = 900) => {
    await page.mouse.wheel(0, px);
  };

  const scrollToBottom = async (o?: { steps?: number }) => {
    const steps = o?.steps ?? 40;
    let lastHeight = 0;
    let stable = 0;
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, vp().height);
      await sleep(250); // let lazy tiles load
      const h = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
      if (h === lastHeight) {
        if (++stable >= 2) break;
      } else {
        stable = 0;
        lastHeight = h;
      }
    }
    await page.evaluate(() => window.scrollTo({ top: 0 })).catch(() => {});
  };

  const goto = async (url: string) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  };

  const click = async (selector: string, o?: { timeout?: number }) => {
    await page.click(selector, { timeout: o?.timeout ?? 8000 });
  };

  const dismiss = async (extraWords?: string[]) => {
    const words = [...DISMISS_WORDS, ...(extraWords ?? []).map((w) => w.toLowerCase())];
    await page
      .evaluate((ws: string[]) => {
        const els = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, a, [role="button"], input[type="button"], input[type="submit"]',
          ),
        );
        for (const el of els) {
          const t = (el.innerText || el.textContent || (el as HTMLInputElement).value || "")
            .trim()
            .toLowerCase();
          if (!t || t.length > 28) continue;
          if (ws.some((w) => t === w || t.startsWith(w))) {
            try { el.click(); } catch { /* ignore */ }
          }
        }
      }, words)
      .catch(() => {});
  };

  return { goto, pause, scrollToBottom, scroll, click, dismiss };
}
