import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SNAPSHOTS_DIR, REPORT_PATH } from "./paths.js";
import type { Snapshot } from "./types.js";

const esc = (s: string) =>
  (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function latestSnapshots(): Promise<Snapshot[]> {
  const casinos = await readdir(SNAPSHOTS_DIR, { withFileTypes: true }).catch(() => []);
  const out: Snapshot[] = [];
  for (const c of casinos) {
    if (!c.isDirectory()) continue;
    const dir = path.join(SNAPSHOTS_DIR, c.name);
    const runs = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const latest = runs[runs.length - 1];
    if (!latest) continue;
    try {
      const snap: Snapshot = JSON.parse(await readFile(path.join(dir, latest, "games.json"), "utf8"));
      out.push(snap);
    } catch {
      /* skip a malformed/half-written snapshot */
    }
  }
  return out.sort((a, b) => a.casino.localeCompare(b.casino));
}

export async function buildReport(): Promise<string> {
  const snaps = await latestSnapshots();
  const totalGames = snaps.reduce((n, s) => n + s.games.length, 0);
  const totalShots = snaps.reduce((n, s) => n + s.games.filter((g) => g.screenshot).length, 0);

  const sections = snaps
    .map((s) => {
      const cards = s.games
        .map((g) => {
          const img = g.screenshot
            ? `<img loading="lazy" src="${esc(g.screenshot)}" alt="${esc(g.name)}">`
            : g.thumb
            ? `<img loading="lazy" src="${esc(g.thumb)}" alt="${esc(g.name)}">`
            : `<div class="ph">no screenshot</div>`;
          const link = g.url
            ? `<a href="${esc(g.url)}" target="_blank">${esc(g.url)}</a>`
            : `<span class="nourl">no url</span>`;
          return `<div class="card"><div class="shot">${img}</div>
            <div class="body"><div class="nm">${esc(g.name)}</div>
            <div class="meta"><span class="cat">${esc(s.category || "")}</span></div>
            <div class="url">${link}</div></div></div>`;
        })
        .join("\n");
      const when = (s.capturedAt || "").slice(0, 16).replace("T", " ");
      return `<section><h2>${esc(s.casino)} <span class="muted">— ${s.games.length} games · captured ${esc(when)}</span></h2>
        <div class="grid">${cards}</div></section>`;
    })
    .join("\n");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grog — Snapshots</title>
<style>
  :root{--bg:#0a0d17;--surface:#141a2a;--line:#283049;--text:#eef1f8;--muted:#8b94ae;--accent:#2ee6a6;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1240px;margin:0 auto;padding:28px 22px 80px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--muted);font-size:13px;margin-bottom:18px}
  .stats{display:flex;gap:14px;margin:14px 0 26px}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 18px}
  .stat .n{font-size:24px;font-weight:700} .stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  h2{font-size:16px;border-bottom:1px solid var(--line);padding-bottom:8px;margin:34px 0 14px}
  h2 .muted{font-weight:400;font-size:13px} .muted{color:var(--muted)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .shot{aspect-ratio:16/10;background:#0c0f1a;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .shot img{width:100%;height:100%;object-fit:cover} .ph{color:var(--muted);font-size:12px}
  .body{padding:10px 12px} .nm{font-weight:650;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .meta{display:flex;justify-content:space-between;margin:3px 0;font-size:11px;color:var(--muted)}
  .cat{text-transform:uppercase;letter-spacing:.4px}
  .url{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .url a{color:var(--accent);text-decoration:none} .nourl{color:var(--muted)}
</style></head><body><div class="wrap">
  <h1>🏴‍☠️ Grog — Snapshots</h1>
  <div class="sub">Generated ${new Date().toLocaleString()} · plain Playwright · latest snapshot per casino</div>
  <div class="stats">
    <div class="stat"><div class="n">${snaps.length}</div><div class="l">Casinos</div></div>
    <div class="stat"><div class="n">${totalGames}</div><div class="l">Games in latest snapshots</div></div>
    <div class="stat"><div class="n">${totalShots}</div><div class="l">Screenshots</div></div>
  </div>
  ${sections || '<div class="muted">No snapshots yet. Try: npm run grog -- run stake --profile .profile/stake</div>'}
</div></body></html>`;

  await writeFile(REPORT_PATH, html);
  return REPORT_PATH;
}
