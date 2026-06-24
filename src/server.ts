import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { listCasinos } from "./runner.js";
import { DATA_DIR, SNAPSHOTS_DIR, REPORTS_DIR, ROOT } from "./paths.js";
import type { Snapshot } from "./types.js";

interface ReportMeta {
  stamp: string;
  when: string;
  capturedAt?: string;
  counts?: Record<string, number>;
  url: string;
}

async function listReports(): Promise<ReportMeta[]> {
  const dirs = await readdir(REPORTS_DIR, { withFileTypes: true }).catch(
    () => [],
  );
  const out: ReportMeta[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const htmlPath = path.join(REPORTS_DIR, d.name, "report.html");
    try {
      await stat(htmlPath);
    } catch {
      continue;
    }
    let meta: { generatedAt?: string; capturedAt?: string; counts?: Record<string, number> } = {};
    try {
      meta = JSON.parse(
        await readFile(path.join(REPORTS_DIR, d.name, "report.json"), "utf8"),
      );
    } catch {
      /* report.json missing/old — fall back to mtime below */
    }
    const when =
      meta.generatedAt || (await stat(htmlPath)).mtime.toISOString();
    out.push({
      stamp: d.name,
      when,
      capturedAt: meta.capturedAt,
      counts: meta.counts,
      url: `/data/reports/${d.name}/report.html`,
    });
  }
  // Newest first by actual generation time — NOT by dir name, since names now
  // carry prefixes ("trend_", legacy "stake_", bare stamps) that would interleave.
  return out.sort((a, b) => (a.when < b.when ? 1 : -1));
}

const UI_DIR = path.join(ROOT, "ui");
const PORT = Number(process.env.GROG_UI_PORT) || 5000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

interface Run {
  id: string;
  casinos: string[];
  lines: string[];
  listeners: Set<http.ServerResponse>;
  done: boolean;
  code: number | null;
  startedAt: string;
  child: ChildProcess;
  stopped: boolean;
}
const runs = new Map<string, Run>();
let runSeq = 0;
let activeRun: string | null = null;

function broadcast(run: Run, event: string, data: string) {
  const payload = `event: ${event}\ndata: ${data.replace(/\n/g, "\\n")}\n\n`;
  for (const res of run.listeners) res.write(payload);
}

const DEFAULT_PROFILE = ".profile/stake";

function launch(args: string[], casinos: string[]): Run {
  const id = `run_${++runSeq}_${Date.now()}`;

  const child = spawn("npx", args, {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
      FORCE_COLOR: "0",
    },
  });

  const run: Run = {
    id,
    casinos,
    lines: [],
    listeners: new Set(),
    done: false,
    code: null,
    startedAt: new Date().toISOString(),
    child,
    stopped: false,
  };
  runs.set(id, run);
  activeRun = id;

  const onData = (buf: Buffer) => {
    for (const raw of buf.toString().split(/\r?\n/)) {
      const line = raw.replace(/\[[0-9;]*m/g, "");
      if (line.trim() === "") continue;
      run.lines.push(line);
      broadcast(run, "line", line);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const finalize = (code: number) => {
    if (run.done) return;
    run.done = true;
    run.code = code;
    if (activeRun === id) activeRun = null;
    broadcast(run, "done", String(code));
    for (const res of run.listeners) res.end();
    run.listeners.clear();
  };
  child.on("exit", (code) => finalize(run.stopped ? 130 : (code ?? 0)));
  child.on("close", (code) => finalize(run.stopped ? 130 : (code ?? 0)));
  child.on("error", (err) => {
    const msg = `⚠ failed to start run: ${err.message}`;
    run.lines.push(msg);
    broadcast(run, "line", msg);
    finalize(1);
  });
  return run;
}

function startRun(casinos: string[]): Run {
  return launch(
    ["tsx", "src/cli.ts", "run", ...casinos, "--profile", DEFAULT_PROFILE],
    casinos,
  );
}

function startAnalyze(): Run {
  return launch(["tsx", "src/cli.ts", "analyze"], ["analyze"]);
}

function stopRun(run: Run): boolean {
  if (run.done || run.stopped) return false;
  run.stopped = true;
  run.lines.push("■ stopped by user");
  broadcast(run, "line", "■ stopped by user");
  const pid = run.child.pid;
  if (!pid) return false;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      run.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    if (run.done) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }, 3000);
  return true;
}

interface SnapMeta {
  casino: string;
  casinoSlug: string;
  stamp: string;
  capturedAt: string;
  count: number;
  shots: number;
}

async function listSnapshots(): Promise<SnapMeta[]> {
  const out: SnapMeta[] = [];
  const casinos = await readdir(SNAPSHOTS_DIR, { withFileTypes: true }).catch(
    () => [],
  );
  for (const c of casinos) {
    if (!c.isDirectory()) continue;
    const dir = path.join(SNAPSHOTS_DIR, c.name);
    const runDirs = (
      await readdir(dir, { withFileTypes: true }).catch(() => [])
    )
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const stamp of runDirs) {
      try {
        const snap: Snapshot = JSON.parse(
          await readFile(path.join(dir, stamp, "games.json"), "utf8"),
        );
        out.push({
          casino: snap.casino,
          casinoSlug: c.name,
          stamp,
          capturedAt: snap.capturedAt,
          count: snap.games.length,
          shots: snap.games.filter((g) => g.screenshot).length,
        });
      } catch {
        /* half-written / missing games.json — skip */
      }
    }
  }
  return out.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1)); // newest first
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
};

async function serveFile(res: http.ServerResponse, file: string) {
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type":
        MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": st.size,
      "cache-control": "no-cache, no-store, must-revalidate",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404");
  }
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });

function safeJoin(root: string, rel: string): string | null {
  const p = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  return p.startsWith(root) ? p : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === "/api/casinos") {
      const ready = await listCasinos();
      const label = (id: string) =>
        id
          .replace(
            /(^|[-_])(\w)/g,
            (_, s, c) => (s ? " " : "") + c.toUpperCase(),
          )
          .trim();
      const COMING_SOON = [
        "BC.Game",
        "BetFury",
        "BetPlay",
        "Cloudbet",
        "Coin Casino",
        "Crypto Games",
        "Cryptorino",
        "Duelbits",
        "Gamdom",
        "Rainbet",
        "Rollbit",
        "Roobet",
        "Shuffle",
        "Thrill",
      ].filter(
        (name) => !ready.includes(name.toLowerCase().replace(/[^a-z0-9]/g, "")),
      );
      return json(res, 200, [
        ...ready.map((id) => ({ id, label: label(id), status: "ready" })),
        ...COMING_SOON.map((label) => ({ label, status: "soon" })),
      ]);
    }

    if (p === "/api/snapshots") {
      return json(res, 200, await listSnapshots());
    }

    if (p === "/api/state") {
      return json(res, 200, {
        activeRun,
        casinos: activeRun ? (runs.get(activeRun)?.casinos ?? []) : [],
      });
    }

    if (p === "/api/snapshot") {
      const slug = url.searchParams.get("casino") || "";
      const stamp = url.searchParams.get("stamp") || "";
      const file = safeJoin(
        SNAPSHOTS_DIR,
        path.join(slug, stamp, "games.json"),
      );
      if (!file) return json(res, 400, { error: "bad path" });
      try {
        return json(res, 200, JSON.parse(await readFile(file, "utf8")));
      } catch {
        return json(res, 404, { error: "snapshot not found" });
      }
    }

    if (p === "/api/run" && req.method === "POST") {
      if (activeRun)
        return json(res, 409, {
          error: "a run is already in progress",
          runId: activeRun,
        });
      const body = JSON.parse((await readBody(req)) || "{}");
      const all = await listCasinos();
      const casinos = (Array.isArray(body.casinos) ? body.casinos : []).filter(
        (c: string) => all.includes(c),
      );
      if (!casinos.length)
        return json(res, 400, { error: "no valid casinos selected" });
      const run = startRun(casinos);
      return json(res, 200, { runId: run.id, casinos });
    }

    if (p === "/api/reports") {
      return json(res, 200, await listReports());
    }

    if (p === "/api/analyze" && req.method === "POST") {
      if (activeRun)
        return json(res, 409, {
          error: "a run is already in progress",
          runId: activeRun,
        });
      const run = startAnalyze();
      return json(res, 200, { runId: run.id, casinos: run.casinos });
    }

    const stopMatch = p.match(/^\/api\/run\/([^/]+)\/stop$/);
    if (stopMatch && req.method === "POST") {
      const run = runs.get(stopMatch[1]);
      if (!run) return json(res, 404, { error: "unknown run" });
      const ok = stopRun(run);
      return json(res, 200, { stopped: ok });
    }

    const streamMatch = p.match(/^\/api\/run\/([^/]+)\/stream$/);
    if (streamMatch) {
      const run = runs.get(streamMatch[1]);
      if (!run) return json(res, 404, { error: "unknown run" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const line of run.lines)
        res.write(`event: line\ndata: ${line.replace(/\n/g, "\\n")}\n\n`);
      if (run.done) {
        res.write(`event: done\ndata: ${run.code}\n\n`);
        return res.end();
      }
      run.listeners.add(res);
      req.on("close", () => run.listeners.delete(res));
      return;
    }

    if (p.startsWith("/data/")) {
      const file = safeJoin(DATA_DIR, p.slice("/data/".length));
      if (!file) return json(res, 400, { error: "bad path" });
      return serveFile(res, file);
    }

    const rel = p === "/" ? "index.html" : p.replace(/^\//, "");
    const uiFile = safeJoin(UI_DIR, rel);
    if (uiFile) return serveFile(res, uiFile);

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404");
  } catch (err) {
    json(res, 500, { error: String(err instanceof Error ? err.message : err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n🏴‍☠️  Grog UI  →  http://localhost:${PORT}\n`);
});
