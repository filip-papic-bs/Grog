const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  casinos: [],
  selected: new Set(),
  running: false,
  runId: null,
};

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
  const view = tab.dataset.view;
  $$(".view").forEach((v) =>
    v.classList.toggle("is-active", v.id === `view-${view}`),
  );
  if (view === "reports") loadReports();
});

const initials = (name) =>
  name
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 2)
    .toUpperCase() || "??";

function renderCasinos() {
  const grid = $("#casino-grid");
  if (!state.casinos.length) {
    grid.innerHTML = `<div class="skeleton-row">No casino flow files found in <code>casinos/</code>.</div>`;
    return;
  }
  grid.innerHTML = state.casinos
    .map((c) => {
      if (c.status === "soon") {
        return `<div class="casino-card is-soon" aria-disabled="true" title="Under construction">
          <span class="cc-ribbon">🚧 Coming soon</span>
          <div class="cc-top">
            <div class="cc-avatar">${initials(c.label)}</div>
          </div>
          <div class="cc-name">${c.label}</div>
          <div class="cc-meta">under construction</div>
        </div>`;
      }
      const sel = state.selected.has(c.id) ? " is-selected" : "";
      return `<div class="casino-card${sel}" data-casino="${c.id}" role="button" tabindex="0">
        <div class="cc-top">
          <div class="cc-avatar">${initials(c.label)}</div>
          <div class="cc-check">✓</div>
        </div>
        <div class="cc-name">${c.label}</div>
        <div class="cc-meta">casinos/${c.id}.ts</div>
      </div>`;
    })
    .join("");
}

function toggleCasino(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderCasinos();
  updateRunBar();
}

$("#casino-grid").addEventListener("click", (e) => {
  const card = e.target.closest(".casino-card:not(.is-soon)");
  if (card) toggleCasino(card.dataset.casino);
});
$("#casino-grid").addEventListener("keydown", (e) => {
  const card = e.target.closest(".casino-card:not(.is-soon)");
  if (card && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    toggleCasino(card.dataset.casino);
  }
});

function updateRunBar() {
  const n = state.selected.size;
  $("#run-summary").innerHTML = `<span class="count">${n}</span> selected`;
  $("#btn-run").disabled = n === 0 || state.running;
}

function appendLog(line) {
  const body = $("#console-body");
  const span = document.createElement("span");
  let cls = "";
  const t = line.trimStart();
  if (t.startsWith("▶")) cls = "l-head";
  else if (t.startsWith("⚠") || t.startsWith("✖") || /error/i.test(t))
    cls = "l-warn";
  else if (t.startsWith("→") || t.startsWith("■")) cls = "l-step";
  else if (t.startsWith("✔") || t.startsWith("✓") || /snapshot:/.test(t))
    cls = "l-ok";
  span.className = cls;
  span.textContent = line + "\n";
  body.appendChild(span);
  body.scrollTop = body.scrollHeight;
}

function setConsoleState(text, kind) {
  const el = $("#console-state");
  el.textContent = text;
  el.className = "console-state" + (kind ? ` is-${kind}` : "");
}

function attachToRun(runId, { title, clear } = {}) {
  state.running = true;
  state.runId = runId;
  updateRunBar();

  const btn = $("#btn-run");
  btn.classList.add("is-running");
  btn.querySelector(".label").textContent = "Running…";
  const stopBtn = $("#btn-stop");
  stopBtn.hidden = false;
  stopBtn.disabled = false;

  const panel = $("#console-panel");
  panel.hidden = false;
  if (title) $("#console-title").textContent = title;
  if (clear) $("#console-body").innerHTML = "";
  setConsoleState("running", "running");
  openStream(runId);
}

function openStream(runId) {
  const es = new EventSource(`/api/run/${runId}/stream`);
  es.addEventListener("line", (e) => appendLog(e.data.replace(/\\n/g, "\n")));
  es.addEventListener("done", (e) => {
    es.close();
    finishRun(Number(e.data) !== 0);
    loadReports(true);
  });
  es.onerror = async () => {
    es.close();
    if (state.runId !== runId) return;
    let active = null;
    try {
      active = (await (await fetch("/api/state")).json()).activeRun;
    } catch {
      /* server unreachable */
    }
    if (active === runId) {
      $("#console-body").innerHTML = "";
      setConsoleState("reconnecting…", "running");
      setTimeout(() => state.runId === runId && openStream(runId), 800);
    } else {
      finishRun(true);
    }
  };
}

async function runAnalysis() {
  if (state.running || !state.selected.size) return;
  const casinos = [...state.selected];

  const panel = $("#console-panel");
  panel.hidden = false;
  $("#console-body").innerHTML = "";
  $("#console-title").textContent = `run · ${casinos.join(", ")}`;
  setConsoleState("starting…", "running");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ casinos }),
    });
    const data = await res.json();
    if (res.status === 409 && data.runId) {
      appendLog("ℹ a run is already in progress — attaching to it");
      attachToRun(data.runId, { title: "run (resumed)", clear: false });
      return;
    }
    if (!res.ok) throw new Error(data.error || "run rejected");
    attachToRun(data.runId, { clear: false });
  } catch (err) {
    appendLog("⚠ " + err.message);
    finishRun(true);
  }
}

function finishRun(errored) {
  state.running = false;
  state.runId = null;
  updateRunBar();
  const btn = $("#btn-run");
  btn.classList.remove("is-running");
  btn.querySelector(".label").textContent = "Run analysis";
  $("#btn-stop").hidden = true;
  setConsoleState(
    errored ? "finished with errors" : "done ✓",
    errored ? "error" : null,
  );
}

async function stopRun() {
  if (!state.runId) return;
  const btn = $("#btn-stop");
  btn.disabled = true;
  btn.textContent = "stopping…";
  setConsoleState("stopping…", "error");
  try {
    await fetch(`/api/run/${state.runId}/stop`, { method: "POST" });
  } catch {
    /* the stream's done/error will finalize the UI */
  }
  btn.textContent = "■ Stop";
}

$("#btn-run").addEventListener("click", runAnalysis);
$("#btn-stop").addEventListener("click", stopRun);

// ---- reports ---------------------------------------------------------------
let reportsLoaded = false;

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso.slice(0, 16).replace("T", " ");
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function loadReports(silent) {
  $("#report-detail").hidden = true;
  $("#reports-list").hidden = false;
  if (!silent)
    $("#reports-list").innerHTML =
      `<div class="skeleton-row">loading snapshots…</div>`;
  let snaps = [];
  try {
    snaps = await (await fetch("/api/snapshots")).json();
  } catch {
    /* ignore */
  }
  reportsLoaded = true;
  const empty = $("#reports-empty");
  const list = $("#reports-list");
  if (!snaps.length) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = snaps
    .map(
      (
        s,
      ) => `<div class="snap-row" data-casino="${s.casinoSlug}" data-stamp="${s.stamp}">
        <div class="snap-badge">${initials(s.casino)}</div>
        <div class="snap-main">
          <div class="snap-casino">${s.casino}</div>
          <div class="snap-when">${fmtWhen(s.capturedAt)}</div>
        </div>
        <div class="snap-stats">
          <div><div class="n">${s.count}</div><div class="k">games</div></div>
          <div><div class="n">${s.shots}</div><div class="k">shots</div></div>
        </div>
        <div class="snap-go">→</div>
      </div>`,
    )
    .join("");
}

$("#reports-list").addEventListener("click", (e) => {
  const row = e.target.closest(".snap-row");
  if (row) openSnapshot(row.dataset.casino, row.dataset.stamp);
});
$("#btn-back").addEventListener("click", () => {
  $("#report-detail").hidden = true;
  $("#reports-list").hidden = false;
});

async function openSnapshot(casinoSlug, stamp) {
  let snap;
  try {
    snap = await (
      await fetch(
        `/api/snapshot?casino=${encodeURIComponent(casinoSlug)}&stamp=${encodeURIComponent(stamp)}`,
      )
    ).json();
  } catch {
    return;
  }
  $("#reports-list").hidden = true;
  $("#reports-empty").hidden = true;
  const detail = $("#report-detail");
  detail.hidden = false;

  $("#detail-head").innerHTML = `<h3>${snap.casino}</h3>
    <span class="tag">${snap.category || "originals"}</span>
    <span class="tag">${fmtWhen(snap.capturedAt)}</span>
    <span class="tag">${snap.games.length} games</span>`;

  $("#game-grid").innerHTML = snap.games
    .map((g) => {
      const src = g.screenshot ? `/data/${g.screenshot}` : g.thumb || "";
      const img = src
        ? `<img loading="lazy" src="${src}" alt="${esc(g.name)}">`
        : `<div class="ph">no screenshot</div>`;
      const url = g.url
        ? `<a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.url)}</a>`
        : "<span class='muted'>no url</span>";
      return `<div class="game-card"><div class="game-shot">${img}</div>
        <div class="game-body"><div class="game-name">${esc(g.name)}</div>
        <div class="game-url">${url}</div></div></div>`;
    })
    .join("");
  detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

const esc = (s) =>
  (s || "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

async function boot() {
  try {
    state.casinos = await (await fetch("/api/casinos")).json();
  } catch {
    $("#status").classList.add("is-down");
    $(".status-label").textContent = "offline";
    state.casinos = [];
  }
  const ready = state.casinos.filter((c) => c.status === "ready");
  if (ready.length === 1) state.selected.add(ready[0].id);
  renderCasinos();
  updateRunBar();

  try {
    const st = await (await fetch("/api/state")).json();
    if (st.activeRun) {
      $("#console-title").textContent =
        `run (resumed) · ${(st.casinos || []).join(", ")}`;
      attachToRun(st.activeRun, { clear: true });
    }
  } catch {
    /* ignore */
  }
}
boot();
