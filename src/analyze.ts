import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { ROOT, SNAPSHOTS_DIR, REPORTS_DIR } from "./paths.js";
import type { Snapshot, Game } from "./types.js";

const MODEL = process.env.GROG_AI_MODEL || "google/gemini-2.5-flash-lite";
const WEB = process.env.GROG_AI_WEB === "1";

interface AiGame {
  i: number;
  provider?: string;
  theme?: string;
  style?: string;
  mechanics?: string[];
  confidence?: string;
}
type Enriched = Game & { ai?: AiGame | null };

function loadEnv() {
  if (process.env.OPENROUTER_API_KEY) return;
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(
      path.join(ROOT, ".env"),
    );
  } catch {
    /* no .env — rely on the ambient environment */
  }
}

async function chat(
  messages: { role: string; content: string }[],
  opts: { json?: boolean; temperature?: number } = {},
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set (put it in .env)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://localhost/grog",
        "X-Title": "Grog",
      },
      body: JSON.stringify({
        model: MODEL + (WEB ? ":online" : ""),
        messages,
        temperature: opts.temperature ?? 0.3,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  } catch (e) {
    throw new Error(
      ctrl.signal.aborted
        ? "OpenRouter request timed out after 90s"
        : `OpenRouter request failed: ${e instanceof Error ? e.message : e}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok)
    throw new Error(
      `OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

function parseJsonLoose(s: string): { games?: AiGame[] } {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  try {
    return JSON.parse(a >= 0 && b > a ? body.slice(a, b + 1) : body);
  } catch {
    return {};
  }
}

function slugOf(url: string): string {
  try {
    return new URL(url).pathname.split("/").pop() || url;
  } catch {
    return url;
  }
}

async function stakeRuns(): Promise<string[]> {
  const dir = path.join(SNAPSHOTS_DIR, "stake");
  const runs = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return runs.map((r) => path.join(dir, r, "games.json"));
}

async function readSnap(file: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function enrich(games: Game[]): Promise<Enriched[]> {
  if (!games.length) return [];
  const list = games.map((g, i) => ({
    i,
    name: g.name,
    slug: slugOf(g.url),
    category: g.category,
  }));
  const sys =
    "You are a slots-industry analyst. For each online casino slot, infer its theme, visual style and core mechanics from the game name and provider slug, using your knowledge of real slots. If you don't recognise a title, infer from the name and set confidence 'low'. Be concise and consistent in your labels.";
  const user =
    `Games (JSON):\n${JSON.stringify(list)}\n\n` +
    `Return STRICT JSON: {"games":[{"i":<index>,"provider":"","theme":"","style":"","mechanics":["",...],"confidence":"high|med|low"}]}.\n` +
    `- provider: studio name from the slug (e.g. "Pragmatic Play", "Hacksaw Gaming").\n` +
    `- theme: ONE short canonical phrase, reuse the same wording across games (e.g. "Candy/Sweets", "Ancient Egypt", "Greek mythology", "Fruit", "Sports", "Horror", "Adventure", "Irish luck", "Aztec/Maya", "Animals", "Fantasy").\n` +
    `- style: visual style (e.g. "vibrant cartoon", "realistic 3D", "neon/cyber", "cute/chibi", "dark/gritty").\n` +
    `- mechanics: array of slot mechanics (e.g. "tumble/cascade", "bonus buy", "Megaways", "cluster pays", "scatter pays", "hold & win", "multipliers", "expanding wilds").`;
  const out = parseJsonLoose(
    await chat(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { json: true },
    ),
  );
  const byI = new Map((out.games ?? []).map((x) => [x.i, x]));
  return games.map((g, i) => ({ ...g, ai: byI.get(i) ?? null }));
}

async function trendBrief(enriched: Enriched[]): Promise<string> {
  const compact = enriched.map((g) => ({
    name: g.name,
    cat: g.category,
    provider: g.ai?.provider,
    theme: g.ai?.theme,
    style: g.ai?.style,
    mech: g.ai?.mechanics,
  }));
  const sys =
    "You are a slots trend analyst advising a casino operator (BitStarz). Be sharp, concrete and pattern-focused — no fluff, no per-game recaps.";
  const user =
    `Competitor (Stake) slot data — "new-releases" = just launched, "slots" = currently trending/most played — each tagged with theme/style/mechanics:\n` +
    `${JSON.stringify(compact)}\n\n` +
    `Write a CONCISE trend brief in markdown (~350-450 words, tight bullets). Use these sections exactly:\n` +
    `## Trending themes\n(rank the top themes with rough counts, note new vs trending)\n` +
    `## Dominant mechanics\n## Visual style direction\n## What the new releases signal\n## Ideas for our next slot\n(3-5 concrete, punchy concepts)\n\n` +
    `Focus on patterns across many titles, not individual games.`;
  return chat(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { temperature: 0.5 },
  );
}

const esc = (s: string) =>
  (s || "").replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!,
  );

function mdToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  let html = "";
  let inList = false;
  const inline = (t: string) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
    } else if (/^#{1,4}\s+/.test(line)) {
      closeList();
      const level = line.match(/^#+/)![0].length;
      html += `<h${level}>${inline(line.replace(/^#+\s+/, ""))}</h${level}>`;
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function gameCard(g: Enriched): string {
  const a = g.ai;
  const img = g.thumb
    ? `<img loading="lazy" src="${esc(g.thumb)}" alt="${esc(g.name)}">`
    : `<div class="ph">no art</div>`;
  const mech = (a?.mechanics ?? [])
    .map((m) => `<span class="mech">${esc(m)}</span>`)
    .join("");
  return `<a class="gcard" href="${esc(g.url)}" target="_blank" rel="noopener">
    <div class="gshot">${img}<span class="theme">${esc(a?.theme ?? "?")}</span></div>
    <div class="gbody">
      <div class="gnm">${esc(g.name)}</div>
      <div class="gmeta">${esc(a?.provider ?? "")}${a?.style ? " · " + esc(a.style) : ""}</div>
      <div class="gmech">${mech}</div>
    </div></a>`;
}

function cardSection(title: string, games: Enriched[]): string {
  if (!games.length) return "";
  return `<section><h2>${esc(title)} <span class="muted">${games.length}</span></h2>
    <div class="ggrid">${games.map(gameCard).join("\n")}</div></section>`;
}

export async function runAnalysis(): Promise<string> {
  loadEnv();
  const runs = await stakeRuns();
  if (!runs.length)
    throw new Error("no stake snapshot yet — run `grog run stake` first");
  const currentFile = runs[runs.length - 1];
  const stamp = path.basename(path.dirname(currentFile));
  const current = await readSnap(currentFile);
  if (!current) throw new Error("latest snapshot is unreadable");
  const prev = runs.length > 1 ? await readSnap(runs[runs.length - 2]) : null;

  const byCat = (s: Snapshot | null, c: string) =>
    (s?.games ?? []).filter((g) => g.category === c);

  const newReleases = byCat(current, "new-releases");
  const slots = byCat(current, "slots");

  const prevOrigUrls = new Set(
    byCat(prev, "stake-originals").map((g) => g.url),
  );
  const origAll = byCat(current, "stake-originals");
  const newOriginals = prev
    ? origAll.filter((g) => !prevOrigUrls.has(g.url))
    : [];
  const originalsNote = !prev
    ? `Baseline run — ${origAll.length} originals captured, nothing to compare against yet. The next run will diff against this one and only surface genuinely new originals.`
    : newOriginals.length
      ? `${newOriginals.length} new original(s) since the previous run.`
      : "No new originals since the previous run.";

  console.log(
    `analyzing with ${MODEL}${WEB ? " (web)" : ""} — ${newReleases.length} new, ${slots.length} trending, originals ${prev ? newOriginals.length + " new" : "baseline (ignored)"}…`,
  );

  const toEnrich = [...newReleases, ...slots, ...newOriginals];
  console.log(`enriching ${toEnrich.length} game(s)…`);
  const enriched = await enrich(toEnrich);
  const pick = (cat: string) => enriched.filter((g) => g.category === cat);

  console.log("writing trend brief…");
  const brief = await trendBrief(
    enriched.filter((g) => g.category !== "stake-originals"),
  );

  const when = new Date().toLocaleString();
  const capturedAt = current.capturedAt || "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grog — Slot Trend Report</title>
<style>
  :root{--bg:#0a0d17;--surface:#141a2a;--line:#283049;--text:#eef1f8;--muted:#8b94ae;--accent:#2ee6a6;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
  .wrap{max-width:1100px;margin:0 auto;padding:28px 22px 80px}
  h1{font-size:24px;margin:0 0 2px} .sub{color:var(--muted);font-size:13px;margin-bottom:22px}
  .brief{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:6px 22px 18px;margin-bottom:28px}
  .brief h2{font-size:16px;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:6px;margin:20px 0 10px}
  .brief h3{font-size:14px;margin:16px 0 6px}
  .brief ul{margin:6px 0 6px 2px;padding-left:18px} .brief li{margin:3px 0}
  .brief code{background:#0c0f1a;padding:1px 5px;border-radius:5px;font-size:12px}
  h2{font-size:16px;border-bottom:1px solid var(--line);padding-bottom:8px;margin:30px 0 14px}
  h2 .muted{font-size:12px;font-weight:400;background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:1px 9px}
  .muted{color:var(--muted)}
  .note{font-size:13px;color:var(--muted);background:var(--surface);border:1px dashed var(--line);border-radius:10px;padding:10px 14px;margin:8px 0 20px}
  .ggrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
  .gcard{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden;text-decoration:none;color:var(--text);transition:border-color .15s,transform .15s}
  .gcard:hover{border-color:var(--accent);transform:translateY(-2px)}
  .gshot{position:relative;aspect-ratio:4/3;background:#0c0f1a;overflow:hidden}
  .gshot img{width:100%;height:100%;object-fit:cover}
  .gshot .ph{display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:12px}
  .gshot .theme{position:absolute;left:8px;bottom:8px;background:rgba(10,13,23,.82);border:1px solid var(--line);color:var(--accent);font-size:11px;padding:2px 8px;border-radius:20px}
  .gbody{padding:9px 11px 11px}
  .gnm{font-weight:650;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gmeta{color:var(--muted);font-size:11px;margin:2px 0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gmech{display:flex;flex-wrap:wrap;gap:4px}
  .mech{background:#0c0f1a;border:1px solid var(--line);color:var(--muted);font-size:10px;padding:1px 7px;border-radius:20px}
</style></head><body><div class="wrap">
  <h1>🏴‍☠️ Grog — Slot Trend Report</h1>
  <div class="sub">Generated ${esc(when)} · snapshot ${esc(stamp)} · source: Stake · model: ${esc(MODEL)}${WEB ? " + web" : ""}</div>
  <div class="brief">${mdToHtml(brief)}</div>
  ${cardSection("🔥 Trending Slots", pick("slots"))}
  ${cardSection("🆕 New Releases", pick("new-releases"))}
  <section><h2>⭐ Originals</h2><div class="note">${esc(originalsNote)}</div>
    ${prev && newOriginals.length ? `<div class="ggrid">${pick("stake-originals").map(gameCard).join("\n")}</div>` : ""}
  </section>
</div></body></html>`;

  const outDir = path.join(REPORTS_DIR, stamp);
  await mkdir(outDir, { recursive: true });
  const htmlPath = path.join(outDir, "report.html");
  await writeFile(htmlPath, html);
  await writeFile(
    path.join(outDir, "report.json"),
    JSON.stringify(
      {
        stamp,
        generatedAt: new Date().toISOString(),
        capturedAt,
        model: MODEL,
        web: WEB,
        counts: {
          newReleases: newReleases.length,
          slots: slots.length,
          newOriginals: newOriginals.length,
        },
        originalsNote,
        brief,
        games: enriched.map((g) => ({
          name: g.name,
          url: g.url,
          thumb: g.thumb,
          category: g.category,
          ...g.ai,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`report → ${path.relative(ROOT, htmlPath)}`);
  return htmlPath;
}
