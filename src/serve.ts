import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { buildDashboardData, DASHBOARD_DATA_PATH } from "./dashboard.js";
import { renderDashboardHtml } from "./dashboard-html.js";
import { ROOT } from "./paths.js";

// ─────────────────────────────────────────────────────────────────────────────
// `grog serve` — hosts the dashboard as a localhost web app. The page is a
// read-only daily VIEW (no casino picker, no AI in the rendering); each load
// re-reads the snapshots + cached classifications and re-renders. The one bit
// of interaction is a "Run now" button that manually triggers the same pipeline
// the daily job will run later (scrape → report → refresh) — handy until the
// scheduled job exists. POST /run starts it; GET /run/status polls progress.
// ─────────────────────────────────────────────────────────────────────────────

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

// Single in-flight run at a time.
const runState: { running: boolean; child: ChildProcess | null; startedAt: number; last: string; exitCode: number | null } = {
  running: false,
  child: null,
  startedAt: 0,
  last: "",
  exitCode: null,
};

function startRun(): boolean {
  if (runState.running) return false;
  // Reuse the npm script so NODE_OPTIONS/tsx are set up exactly as normal.
  // --no-open: don't pop a second browser tab; the page reloads itself.
  const child = spawn("npm", ["run", "grog", "--", "run", "all", "--no-open"], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runState.running = true;
  runState.child = child;
  runState.startedAt = Date.now();
  runState.last = "starting…";
  runState.exitCode = null;

  const onData = (buf: Buffer) => {
    const line = buf.toString().split("\n").map((l) => l.trim()).filter(Boolean).pop();
    if (line) runState.last = line;
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const finish = (code: number | null) => {
    if (!runState.running) return;
    runState.running = false;
    runState.child = null;
    runState.exitCode = code ?? 0;
    runState.last = code ? `exited with code ${code}` : "done";
  };
  child.on("exit", finish);
  child.on("error", (err) => {
    runState.last = `failed to start: ${err.message}`;
    finish(1);
  });
  return true;
}

export async function serve(opts: { port?: number; log?: (m: string) => void } = {}): Promise<void> {
  const port = opts.port ?? (Number(process.env.GROG_PORT) || 8088);
  const log = opts.log ?? console.log;

  const server = createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    const method = req.method || "GET";
    try {
      if (url === "/" || url === "/index.html") {
        // Rebuild fresh from disk on every load — cheap, no AI.
        const data = await buildDashboardData({});
        res.writeHead(200, HTML_HEADERS);
        res.end(renderDashboardHtml(data));
        return;
      }
      if (url === "/run" && method === "POST") {
        const started = startRun();
        res.writeHead(started ? 202 : 409, JSON_HEADERS);
        res.end(JSON.stringify({ started, running: runState.running }));
        return;
      }
      if (url === "/run/status") {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
          running: runState.running,
          last: runState.last,
          exitCode: runState.exitCode,
          elapsedMs: runState.startedAt ? Date.now() - runState.startedAt : 0,
        }));
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
  log(`✔ Dashboard live at http://127.0.0.1:${port}  ("Run now" triggers a manual review · Ctrl-C to stop)`);

  // Keep the process alive until killed.
  await new Promise<void>(() => {});
}
