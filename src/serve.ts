import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { buildDashboardData, DASHBOARD_DATA_PATH } from "./dashboard.js";
import { renderDashboardHtml } from "./dashboard-html.js";

// ─────────────────────────────────────────────────────────────────────────────
// `grog serve` — hosts the dashboard as a localhost web app. The page is a
// read-only daily VIEW (no casino picker, no AI in the rendering); each load
// re-reads the snapshots + cached classifications and re-renders.
// ─────────────────────────────────────────────────────────────────────────────

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export async function serve(opts: { port?: number; log?: (m: string) => void } = {}): Promise<void> {
  const port = opts.port ?? (Number(process.env.GROG_PORT) || 8088);
  const log = opts.log ?? console.log;

  const server = createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    try {
      if (url === "/" || url === "/index.html") {
        // Rebuild fresh from disk on every load — cheap, no AI.
        const data = await buildDashboardData({});
        res.writeHead(200, HTML_HEADERS);
        res.end(renderDashboardHtml(data));
        return;
      }
      if (url === "/dashboard-data.json") {
        const json = await readFile(DASHBOARD_DATA_PATH, "utf8").catch(async () => {
          return JSON.stringify(await buildDashboardData({}));
        });
        res.writeHead(200, JSON_HEADERS);
        res.end(json);
        return;
      }
      if (url === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, HTML_HEADERS);
      res.end(`<pre style="color:#f87171;background:#0a0d14;padding:24px;font:14px ui-monospace">Dashboard build failed:\n\n${msg}\n\nRun \`npm run grog run all\` to gather snapshots first.</pre>`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  log(`✔ Dashboard live at http://127.0.0.1:${port}  (read-only · Ctrl-C to stop)`);

  // Keep the process alive until killed.
  await new Promise<void>(() => {});
}
