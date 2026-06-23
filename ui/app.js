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

function showSpinner(on, text) {
  const s = $("#trend-status");
  s.classList.remove("is-error");
  if (on) {
    $("#trend-status-text").textContent = text || "Analyzing games with AI…";
    s.hidden = false;
  } else {
    s.hidden = true;
  }
}

function showTrendError(msg) {
  const s = $("#trend-status");
  s.classList.add("is-error");
  $("#trend-status-text").textContent = "⚠ " + msg;
  s.hidden = false;
}

let reportVersions = [];

function selectReport(stamp) {
  const r = reportVersions.find((v) => v.stamp === stamp);
  if (!r) return;
  $$(".rv-row").forEach((el) =>
    el.classList.toggle("is-active", el.dataset.stamp === stamp),
  );
  $("#trend-frame").src = r.url + "?t=" + Date.now();
  $("#trend-frame-wrap").hidden = false;
}

async function loadReportFrame(selectStamp) {
  try {
    reportVersions = await (await fetch("/api/reports")).json();
  } catch {
    reportVersions = [];
  }
  const list = $("#report-versions");
  if (!reportVersions.length) {
    list.hidden = true;
    list.innerHTML = "";
    $("#trend-frame-wrap").hidden = true;
    $("#trend-empty").hidden = false;
    return;
  }
  $("#trend-empty").hidden = true;
  list.hidden = false;
  list.innerHTML = reportVersions
    .map((v, i) => {
      const c = v.counts || {};
      const sub = [
        c.slots != null ? c.slots + " trending" : null,
        c.newReleases != null ? c.newReleases + " new" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `<button class="rv-row" data-stamp="${v.stamp}">
        <span class="rv-when">${fmtWhen(v.when)}${i === 0 ? ' <span class="rv-latest">latest</span>' : ""}</span>
        <span class="rv-sub">${sub}</span>
      </button>`;
    })
    .join("");
  const target =
    (selectStamp && reportVersions.find((v) => v.stamp === selectStamp)) ||
    reportVersions[0];
  selectReport(target.stamp);
}

$("#report-versions").addEventListener("click", (e) => {
  const row = e.target.closest(".rv-row");
  if (row) selectReport(row.dataset.stamp);
});

async function loadReports() {
  let st = {};
  try {
    st = await (await fetch("/api/state")).json();
  } catch {
    /* server unreachable */
  }
  if (st.activeRun && (st.casinos || []).includes("analyze")) {
    await awaitTrendRun(st.activeRun);
    return;
  }
  showSpinner(false);
  await loadReportFrame();
}

async function awaitTrendRun(runId) {
  $("#trend-frame-wrap").hidden = true;
  $("#trend-empty").hidden = true;
  showSpinner(true, "Analyzing games with AI… (~20–30s)");

  const r = await new Promise((resolve) => {
    let last = "";
    let errLine = "";
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const es = new EventSource(`/api/run/${runId}/stream`);
    const guard = setTimeout(() => {
      es.close();
      finish({ code: "timeout", last, errLine });
    }, 150_000);
    es.addEventListener("line", (e) => {
      const l = e.data.replace(/\\n/g, " ").trim();
      if (!l || l === "1") return;
      last = l;
      if (!errLine && /error/i.test(l))
        errLine = l.replace(/^Error:\s*/i, "").replace(/\s+at\s.*$/, "");
    });
    es.addEventListener("done", (e) => {
      clearTimeout(guard);
      es.close();
      finish({ code: e.data, last, errLine });
    });
    es.onerror = () => {
      clearTimeout(guard);
      es.close();
      finish({ code: "?", last, errLine });
    };
  });

  if (r.code === "timeout") {
    showTrendError("analysis timed out — restart the server and try again");
  } else if (r.code !== "0" && r.code !== "?") {
    showTrendError(r.errLine || r.last || "analysis failed");
  } else {
    showSpinner(false);
    await loadReportFrame();
  }
}

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
