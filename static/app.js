// ---------- tab switching ----------

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

function switchTab(tabId) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  tabPanels.forEach((p) => p.classList.toggle("active", p.id === tabId));
  if (typeof timerSubject !== "undefined" && timerSubject && !overlayMinimized) {
    minimizeFocusOverlay();
  }
  // タブが非表示(display:none)の間はグリッドの位置が測れないため、Calendarタブが
  // 表示された瞬間に高さを再計算する(updateCalGridHeightはapp.js後方で定義、
  // switchTab自体はクリック時にしか呼ばれないのでhoisting上の問題はない)
  if (tabId === "tab-calendar" && typeof updateCalGridHeight === "function") updateCalGridHeight();
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.getElementById("daily-min-banner").addEventListener("click", () => switchTab("tab-study"));

// ---------- collapsible history sections ----------
// 生ログの一覧(学習ログ履歴・発動ログ履歴・睡眠履歴)は普段あまり見ない情報でスクロールを
// 稼ぐだけだったため、既存の「完了済みToDo」の折りたたみと同じ見た目・挙動でデフォルト非表示にする。
// 戻り値は「件数を渡して見出し文言だけ更新する」関数(呼ぶ側は開閉状態を意識しなくてよい)。
function initCollapsibleSection(headerId, listId, label, defaultExpanded = false) {
  let expanded = defaultExpanded;
  let count = 0;
  const header = document.getElementById(headerId);
  const list = document.getElementById(listId);
  header.classList.add("collapsible");
  function render() {
    header.textContent = `${expanded ? "▼" : "▶"} ${label} (${count})`;
    list.style.display = expanded ? "" : "none";
  }
  header.addEventListener("click", () => {
    expanded = !expanded;
    render();
  });
  render();
  return (newCount) => {
    count = newCount;
    render();
  };
}

const updateStudyLogHeader = initCollapsibleSection("study-log-header", "study-log-list", "Log History");
const updateActivationListHeader = initCollapsibleSection("activation-list-header", "activation-list", "History");
const updateSleepLogHeader = initCollapsibleSection("sleep-log-header", "sleep-log-list", "History");

// ---------- helpers ----------

// api()呼び出し中であることを画面上部の細いバーで示す。「押しても反応がわからない」対策。
// 一瞬で終わるリクエストでチラつかないよう、表示は少し遅らせて出す。
let apiInFlight = 0;
let apiProgressShowTimer = null;

function apiProgressStart() {
  apiInFlight++;
  if (apiInFlight === 1) {
    clearTimeout(apiProgressShowTimer);
    apiProgressShowTimer = setTimeout(() => {
      document.getElementById("top-progress-bar")?.classList.remove("hidden");
    }, 200);
  }
}

function apiProgressEnd() {
  apiInFlight = Math.max(0, apiInFlight - 1);
  if (apiInFlight === 0) {
    clearTimeout(apiProgressShowTimer);
    document.getElementById("top-progress-bar")?.classList.add("hidden");
  }
}

// ---------- 起動時キャッシュ(体感速度改善) ----------
// サーバー(Turso)が正のデータ置き場であることは変えない。直前に取得した内容だけを
// 端末のIndexedDBに保存しておき、起動直後はまずそれを描画→裏で本物のfetchが終わったら
// 上書きする(stale-while-revalidate)。オフライン対応が目的ではないので、
// キャッシュの読み書きが失敗しても本来のfetchには一切影響させない(全部try/catchで握りつぶす)。
const CACHE_DB_NAME = "compass-cache";
const CACHE_STORE_NAME = "api-cache";
let cacheDbPromise = null;

function openCacheDb() {
  if (!cacheDbPromise) {
    cacheDbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("no indexedDB")); return; }
      const req = indexedDB.open(CACHE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(CACHE_STORE_NAME, { keyPath: "path" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return cacheDbPromise;
}

async function cacheGet(path) {
  try {
    const db = await openCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readonly");
      const req = tx.objectStore(CACHE_STORE_NAME).get(path);
      req.onsuccess = () => resolve(req.result ? req.result.data : undefined);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    return undefined;
  }
}

async function cacheSet(path, data) {
  try {
    const db = await openCacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
      tx.objectStore(CACHE_STORE_NAME).put({ path, data });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // キャッシュ書き込みの失敗は無視してよい(次回起動時に恩恵がないだけ)
  }
}

async function api(path, options = {}, retries = 3) {
  apiProgressStart();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(path, {
          headers: { "Content-Type": "application/json" },
          ...options,
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data = await res.json();
        if (!options.method || options.method.toUpperCase() === "GET") {
          cacheSet(path, data); // 起動高速化用キャッシュへの書き込み。失敗してもawaitしない
        }
        return data;
      } catch (err) {
        if (attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }
  } finally {
    apiProgressEnd();
  }
}

// フォームの二重送信防止: 送信ボタンをリクエスト中は無効化し、
// 「反応が無いように見えてもう一度押す」→2重に記録される、を防ぐ。
function guardedSubmit(form, handler) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (form.dataset.submitting === "1") return;
    form.dataset.submitting = "1";
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      await handler(e);
    } finally {
      form.dataset.submitting = "";
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// フォーム外のボタン(就寝/発動ログの開始・終了など)向けの同じ仕組み。
// これらは処理中に押しても状態変数の更新がリクエスト完了後になるため、
// ボタン無効化なしだと連打でレコードが二重に作成されうる。
function guardedClick(el, handler) {
  el.addEventListener("click", async (e) => {
    if (el.dataset.busy === "1") return;
    el.dataset.busy = "1";
    el.disabled = true;
    try {
      await handler(e);
    } finally {
      el.dataset.busy = "";
      el.disabled = false;
    }
  });
}

function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return formatLocalDate(new Date());
}

// ---------- todos ----------

const PRIORITY_LABEL = { high: "High", medium: "Med", low: "Low" };

function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function isOverdue(t) {
  if (t.done || !t.due_date) return false;
  const today = todayStr();
  if (t.due_date < today) return true;
  if (t.due_date === today && t.due_time) return t.due_time < nowHHMM();
  return false;
}

const WEEKDAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

// テキストに混ぜ込む小アイコン。絵文字はOS/端末で見た目がバラつく上ダークモードで浮くため、
// 他のアイコンボタンと同じstroke SVGに統一している(class="inline-icon"でstyle.css側の余白調整)。
const ICONS = {
  repeat:
    '<svg class="inline-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  calendar:
    '<svg class="inline-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  note:
    '<svg class="inline-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  check:
    '<svg class="inline-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  alert:
    '<svg class="inline-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  moon:
    '<svg class="inline-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  clock:
    '<svg class="inline-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  // 再生/削除ボタン用。.inline-iconの既定色(muted寄り)は使わず、ボタン自身のcolorをそのまま継承させる
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7 4 20 12 7 20 7 4"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M18 7l-.9 12.1a2 2 0 0 1-2 1.9H8.9a2 2 0 0 1-2-1.9L6 7"/></svg>',
};


function recurrenceLabel(recurrence) {
  if (!recurrence) return "";
  const days = recurrence.split(",");
  if (days.length === 7) return ` ${ICONS.repeat}Daily`;
  const weekdaysOnly = ["mon", "tue", "wed", "thu", "fri"];
  if (days.length === 5 && weekdaysOnly.every((d) => days.includes(d))) return ` ${ICONS.repeat}Weekdays`;
  const sorted = WEEKDAY_ORDER.filter((d) => days.includes(d));
  return ` ${ICONS.repeat}` + sorted.map((d) => WEEKDAY_LABEL[d]).join("");
}

function computeReschedule(t, kind) {
  // kind: "+30" | "+60" | "tomorrow"
  if (kind === "tomorrow") {
    return { due_date: addDaysToDate(t.due_date, 1), due_time: t.due_time || null };
  }
  const minutes = kind === "+30" ? 30 : 60;
  if (!t.due_time) {
    return { due_date: addDaysToDate(t.due_date, 0), due_time: null };
  }
  const base = new Date(`${t.due_date}T${t.due_time}:00`);
  base.setMinutes(base.getMinutes() + minutes);
  return { due_date: formatLocalDate(base), due_time: String(base.getHours()).padStart(2, "0") + ":" + String(base.getMinutes()).padStart(2, "0") };
}

async function toggleTodoDone(t) {
  await api(`/api/todos/${t.id}/toggle`, { method: "POST" });
  loadTodos();
  loadTodoStats();
}

// スワイプで完了/未完了を切り替えるジェスチャー。ボタン・チェックボックスの上から
// 始まった操作はドラッグとして扱わない(タップの邪魔をしない)。
// しきい値を超えたら完了処理を呼び、そうでなければ元の位置へ戻す。
// 一定以上ドラッグした場合は、指を離した直後に発火するclickイベント(詳細パネルを開く処理)を
// 1回だけ握りつぶす。そうしないとスワイプ操作のたびに詳細パネルも一緒に開いてしまう。
function attachSwipeToComplete(li, content, t, onTap) {
  const threshold = 0.32;
  const dragMinDistance = 6;
  let dragging = false;
  let startX = 0;
  let dx = 0;
  let width = 0;
  let suppressNextClick = false;

  function onDown(e) {
    if (e.target.closest("button, input, a")) return;
    dragging = true;
    startX = e.clientX;
    dx = 0;
    width = li.offsetWidth;
    content.style.transition = "none";
  }
  function onMove(e) {
    if (!dragging) return;
    dx = Math.max(0, e.clientX - startX); // 右方向のスワイプのみ受け付ける
    content.style.transform = `translateX(${dx}px)`;
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    content.style.transition = "transform 0.2s ease";
    if (dx > dragMinDistance) suppressNextClick = true;
    if (dx > width * threshold) {
      content.style.transform = `translateX(${width}px)`;
      setTimeout(() => toggleTodoDone(t), 140);
    } else {
      content.style.transform = "translateX(0)";
    }
    dx = 0;
  }

  content.style.touchAction = "pan-y";
  content.addEventListener("pointerdown", onDown);
  content.addEventListener("pointermove", onMove);
  content.addEventListener("pointerup", onUp);
  content.addEventListener("pointercancel", onUp);

  li.addEventListener("click", () => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    onTap();
  });
}

function renderTodoItem(t, list) {
  const li = document.createElement("li");
  if (t.done) li.classList.add("done");
  const overdue = isOverdue(t);
  if (overdue) li.classList.add("overdue");
  if (!t.done && t.due_date === todayStr() && !overdue) li.classList.add("due-today");
  if (t.priority === "high") li.classList.add("priority-high");
  const dueLabel = t.due_date ? `${ICONS.calendar} ${t.due_date}${t.due_time ? " " + t.due_time : ""}` : "";
  const recurLabel = recurrenceLabel(t.recurrence);
  const priorityLabel = t.priority && t.priority !== "medium" ? `[${PRIORITY_LABEL[t.priority] || t.priority}] ` : "";
  const noteMark = t.note ? ` ${ICONS.note}` : "";
  const showReschedule = !t.done && t.due_date && (overdue || t.due_date === todayStr());
  const dotColor = t.category ? colorFor(t.category) : "var(--border)";
  li.innerHTML = `
    <div class="todo-swipe-bg ${t.done ? "undo" : "complete"}">
      ${t.done ? `${ICONS.repeat} Mark incomplete` : `${ICONS.check} Mark complete`}
    </div>
    <div class="todo-swipe-content">
      <div class="todo-card-top">
        <input type="checkbox" ${t.done ? "checked" : ""}>
        <span class="todo-card-dot" style="background:${dotColor}"></span>
        <div class="todo-card-main">
          <span class="todo-card-title">${priorityLabel}${escapeHtml(t.title)}${noteMark}</span>
          <span class="todo-card-meta">${t.category || ""} ${dueLabel}${recurLabel}</span>
          ${showReschedule ? `
            <div class="reschedule-row">
              <button type="button" class="reschedule-btn" data-kind="+30">+30 min</button>
              <button type="button" class="reschedule-btn" data-kind="+60">+1 hr</button>
              <button type="button" class="reschedule-btn" data-kind="tomorrow">Tomorrow</button>
            </div>
          ` : ""}
        </div>
        <div class="todo-card-actions">
          ${!t.done && t.category ? `<button class="play-btn" title="Start recording">${ICONS.play}</button>` : ""}
          <button class="delete-btn" title="Delete">${ICONS.trash}</button>
        </div>
      </div>
    </div>
  `;
  li.querySelector("input").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTodoDone(t);
  });
  const playBtn = li.querySelector(".play-btn");
  if (playBtn) {
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openStartPanel(t.category, t.id);
    });
  }
  li.querySelector(".delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    await api(`/api/todos/${t.id}`, { method: "DELETE" });
    loadTodos();
  });
  li.querySelectorAll(".reschedule-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { due_date, due_time } = computeReschedule(t, btn.dataset.kind);
      await api(`/api/todos/${t.id}/due`, { method: "PUT", body: JSON.stringify({ due_date, due_time }) });
      loadTodos();
      loadCalendar();
    });
  });
  attachSwipeToComplete(li, li.querySelector(".todo-swipe-content"), t, () => openTodoDetail(t));
  li.classList.add("clickable");
  list.appendChild(li);
}

function todoGroupOf(t) {
  if (t.done) return "done";
  if (!t.due_date) return "none";
  const today = todayStr();
  if (isOverdue(t)) return "overdue";
  if (t.due_date === today) return "today";
  const weekAhead = new Date();
  weekAhead.setDate(weekAhead.getDate() + 7);
  if (t.due_date <= formatLocalDate(weekAhead)) return "week";
  return "later";
}

let allTodos = [];
let doneExpanded = false;

function applyTodoFilters(todos) {
  const search = document.getElementById("todo-search").value.trim().toLowerCase();
  const category = document.getElementById("todo-filter-category").value;
  const todayOnly = document.getElementById("todo-filter-today").checked;
  const today = todayStr();
  return todos.filter((t) => {
    if (search && !t.title.toLowerCase().includes(search)) return false;
    if (category && t.category !== category) return false;
    if (todayOnly && !(t.due_date === today || (!t.due_date && !t.done))) return false;
    return true;
  });
}

function renderTodos() {
  const todos = applyTodoFilters(allTodos);
  const groupsEl = document.getElementById("todo-groups");
  groupsEl.innerHTML = "";

  const groups = { overdue: [], today: [], week: [], later: [], none: [], done: [] };
  todos.forEach((t) => groups[todoGroupOf(t)].push(t));

  const sections = [
    ["overdue", "Overdue"],
    ["today", "Today"],
    ["week", "This week"],
    ["later", "Later"],
    ["none", "No due date"],
    ["done", "Done"],
  ];

  sections.forEach(([key, label]) => {
    if (groups[key].length === 0) return;
    const h = document.createElement("h3");
    if (key === "done") {
      h.classList.add("collapsible");
      h.textContent = `${doneExpanded ? "▼" : "▶"} ${label}(${groups[key].length})`;
      h.addEventListener("click", () => {
        doneExpanded = !doneExpanded;
        renderTodos();
      });
    } else {
      h.textContent = `${label}(${groups[key].length})`;
    }
    groupsEl.appendChild(h);
    const ul = document.createElement("ul");
    ul.className = "list";
    if (key === "done" && !doneExpanded) ul.style.display = "none";
    groups[key].forEach((t) => renderTodoItem(t, ul));
    groupsEl.appendChild(ul);
  });

  if (todos.length === 0) {
    groupsEl.innerHTML = "<p class='meta'>No matching tasks</p>";
  }

  const deferCandidates = [...groups.overdue, ...groups.today].filter((t) => t.priority !== "high");
  const deferBtn = document.getElementById("defer-today-btn");
  deferBtn.classList.toggle("hidden", deferCandidates.length === 0);
  deferBtn.onclick = async () => {
    if (!confirm(`Push ${deferCandidates.length} non-high-priority task(s) to tomorrow?`)) return;
    await Promise.all(
      deferCandidates.map((t) =>
        api(`/api/todos/${t.id}/due`, {
          method: "PUT",
          body: JSON.stringify({ due_date: addDaysToDate(todayStr(), 1), due_time: t.due_time || null }),
        })
      )
    );
    loadTodos();
    loadCalendar();
  };
}

async function loadTodos() {
  allTodos = await api("/api/todos");
  renderTodos();
}

["todo-search", "todo-filter-category", "todo-filter-today"].forEach((id) => {
  document.getElementById(id).addEventListener("input", renderTodos);
});

function renderTodoStats(stats) {
  const el = document.getElementById("todo-stats");
  const maxDaily = Math.max(1, ...stats.daily.map((d) => d.c));
  const barsHtml = stats.daily
    .map((d) => `
      <div class="stat-bar-row">
        <span class="meta">${d.d.slice(5)}</span>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${(d.c / maxDaily) * 100}%"></div></div>
        <span class="meta">${d.c}</span>
      </div>
    `)
    .join("");
  el.innerHTML = `
    <p>Completed: ${stats.done}/${stats.total} (${stats.rate}%)</p>
    ${stats.daily.length ? `<p class="meta">Completions in the last 7 days</p>${barsHtml}` : ""}
  `;
}

async function loadTodoStats() {
  const stats = await api("/api/todos/stats");
  renderTodoStats(stats);
}

const todoAddPanel = document.getElementById("todo-add-panel");
const todoAddBackdrop = document.getElementById("todo-add-backdrop");

function openTodoAddPanel() {
  todoAddPanel.classList.remove("hidden");
  todoAddBackdrop.classList.remove("hidden");
  document.getElementById("todo-title").focus();
}

function closeTodoAddPanel() {
  todoAddPanel.classList.add("hidden");
  todoAddBackdrop.classList.add("hidden");
}

document.getElementById("todo-fab").addEventListener("click", openTodoAddPanel);
document.getElementById("todo-add-close").addEventListener("click", closeTodoAddPanel);
todoAddBackdrop.addEventListener("click", closeTodoAddPanel);

document.querySelectorAll("[data-quick]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const dateInput = document.getElementById(btn.dataset.quickTarget || "todo-due-date");
    const quick = btn.dataset.quick;
    if (quick === "clear") {
      dateInput.value = "";
      return;
    }
    const d = new Date();
    if (quick === "tomorrow") d.setDate(d.getDate() + 1);
    if (quick === "nextweek") d.setDate(d.getDate() + 7);
    dateInput.value = formatLocalDate(d);
  });
});

// ---------- recurrence weekday picker ----------

const selectedRecurrenceDays = new Set();

function setRecurrenceDays(days) {
  selectedRecurrenceDays.clear();
  days.forEach((d) => selectedRecurrenceDays.add(d));
  document.querySelectorAll(".weekday-btn").forEach((btn) => {
    btn.classList.toggle("active", selectedRecurrenceDays.has(btn.dataset.day));
  });
}

document.querySelectorAll("#todo-recurrence-picker .weekday-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const day = btn.dataset.day;
    if (selectedRecurrenceDays.has(day)) {
      selectedRecurrenceDays.delete(day);
    } else {
      selectedRecurrenceDays.add(day);
    }
    btn.classList.toggle("active", selectedRecurrenceDays.has(day));
  });
});

document.querySelectorAll("#todo-form [data-recur-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.recurPreset;
    if (preset === "daily") setRecurrenceDays(WEEKDAY_ORDER);
    else if (preset === "weekdays") setRecurrenceDays(["mon", "tue", "wed", "thu", "fri"]);
    else setRecurrenceDays([]);
  });
});

const selectedDetailRecurrenceDays = new Set();

function setDetailRecurrenceDays(days) {
  selectedDetailRecurrenceDays.clear();
  days.forEach((d) => selectedDetailRecurrenceDays.add(d));
  document.querySelectorAll("#todo-detail-recurrence-picker .weekday-btn").forEach((btn) => {
    btn.classList.toggle("active", selectedDetailRecurrenceDays.has(btn.dataset.day));
  });
}

document.querySelectorAll("#todo-detail-recurrence-picker .weekday-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const day = btn.dataset.day;
    if (selectedDetailRecurrenceDays.has(day)) {
      selectedDetailRecurrenceDays.delete(day);
    } else {
      selectedDetailRecurrenceDays.add(day);
    }
    btn.classList.toggle("active", selectedDetailRecurrenceDays.has(day));
  });
});

document.querySelectorAll("#todo-detail-form [data-recur-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.recurPreset;
    if (preset === "daily") setDetailRecurrenceDays(WEEKDAY_ORDER);
    else if (preset === "weekdays") setDetailRecurrenceDays(["mon", "tue", "wed", "thu", "fri"]);
    else setDetailRecurrenceDays([]);
  });
});

// ---------- category management ----------

const CATEGORY_COLOR_PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9", "#e66767"];
let allCategories = [];
let categoryColorMap = {};

function colorFor(subjectName) {
  return categoryColorMap[subjectName] || "#6b7280";
}

async function loadCategories() {
  const cats = await api("/api/categories");
  allCategories = cats;

  categoryColorMap = {};
  cats.forEach((c, i) => {
    categoryColorMap[c.name] = CATEGORY_COLOR_PALETTE[i % CATEGORY_COLOR_PALETTE.length];
  });

  renderStudyButtons(cats);
  renderStudyFabMenu(cats);
  populateManualLogSubjects(cats);
  populateEventCategorySelect(cats);

  const list = document.getElementById("category-list");
  list.innerHTML = "";
  cats.forEach((c) => renderCategoryItem(c, list));

  const addSelect = document.getElementById("todo-category");
  const detailSelect = document.getElementById("todo-detail-category");
  const filterSelect = document.getElementById("todo-filter-category");
  const addCurrent = addSelect.value;
  const detailCurrent = detailSelect.value;
  const filterCurrent = filterSelect.value;
  const optionsHtml = cats.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
  addSelect.innerHTML = optionsHtml;
  detailSelect.innerHTML = optionsHtml;
  filterSelect.innerHTML = `<option value="">Category: All</option>` + optionsHtml;
  if (cats.some((c) => c.name === addCurrent)) addSelect.value = addCurrent;
  if (cats.some((c) => c.name === detailCurrent)) detailSelect.value = detailCurrent;
  filterSelect.value = filterCurrent;
}

function renderCategoryItem(cat, list) {
  const li = document.createElement("li");
  li.innerHTML = `
    <input type="text" class="category-name-input" value="${escapeHtml(cat.name)}">
    <button class="delete-btn" title="Delete">×</button>
  `;
  const input = li.querySelector("input");
  input.addEventListener("change", async () => {
    const newName = input.value.trim();
    if (!newName || newName === cat.name) {
      input.value = cat.name;
      return;
    }
    await api(`/api/categories/${cat.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: newName }),
    });
    loadCategories();
    loadTodos();
  });
  li.querySelector(".delete-btn").addEventListener("click", async () => {
    await api(`/api/categories/${cat.id}`, { method: "DELETE" });
    loadCategories();
  });
  list.appendChild(li);
}

guardedSubmit(document.getElementById("category-form"), async (e) => {
  const name = document.getElementById("category-name").value.trim();
  if (!name) return;
  await api("/api/categories", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  document.getElementById("category-name").value = "";
  loadCategories();
});

// ---------- settings panel ----------

const settingsPanel = document.getElementById("settings-panel");
const settingsBackdrop = document.getElementById("settings-backdrop");

function openSettingsPanel() {
  settingsPanel.classList.remove("hidden");
  settingsBackdrop.classList.remove("hidden");
}

function closeSettingsPanel() {
  settingsPanel.classList.add("hidden");
  settingsBackdrop.classList.add("hidden");
}

document.getElementById("settings-btn").addEventListener("click", openSettingsPanel);
document.getElementById("settings-close").addEventListener("click", closeSettingsPanel);
settingsBackdrop.addEventListener("click", closeSettingsPanel);

async function updateLastUpdated() {
  const el = document.getElementById("settings-last-updated");
  try {
    const { lastUpdated } = await api("/api/build-info");
    el.textContent = `Last updated: ${new Date(lastUpdated).toLocaleString("en-NZ", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  } catch {
    el.textContent = "Last updated: unavailable";
  }
}
updateLastUpdated();

document.getElementById("todo-time-toggle").addEventListener("click", () => {
  const timeInput = document.getElementById("todo-due-time");
  const notifySelect = document.getElementById("todo-notify");
  const toggleBtn = document.getElementById("todo-time-toggle");
  const showing = timeInput.style.display !== "none";
  if (showing) {
    timeInput.style.display = "none";
    timeInput.value = "";
    notifySelect.style.display = "none";
    notifySelect.value = "";
    toggleBtn.textContent = "+ Add time";
  } else {
    timeInput.style.display = "";
    notifySelect.style.display = "";
    toggleBtn.textContent = "− Remove time";
    timeInput.focus();
    if (timeInput.showPicker) {
      try {
        timeInput.showPicker();
      } catch (err) {
        // showPicker can throw if not called from a direct user gesture on some browsers; ignore
      }
    }
  }
});

document.getElementById("todo-detail-time-toggle").addEventListener("click", () => {
  const timeInput = document.getElementById("todo-detail-due-time");
  const notifySelect = document.getElementById("todo-detail-notify");
  const toggleBtn = document.getElementById("todo-detail-time-toggle");
  const showing = timeInput.style.display !== "none";
  if (showing) {
    timeInput.style.display = "none";
    timeInput.value = "";
    notifySelect.style.display = "none";
    notifySelect.value = "";
    toggleBtn.textContent = "+ Add time";
  } else {
    timeInput.style.display = "";
    notifySelect.style.display = "";
    toggleBtn.textContent = "− Remove time";
    timeInput.focus();
    if (timeInput.showPicker) {
      try {
        timeInput.showPicker();
      } catch (err) {
        // showPicker can throw if not called from a direct user gesture on some browsers; ignore
      }
    }
  }
});

guardedSubmit(document.getElementById("todo-form"), async (e) => {
  const title = document.getElementById("todo-title").value.trim();
  const category = document.getElementById("todo-category").value;
  const priority = document.getElementById("todo-priority").value;
  const due_date = document.getElementById("todo-due-date").value || null;
  const due_time = document.getElementById("todo-due-time").value || null;
  const notifyVal = document.getElementById("todo-notify").value;
  const notify_offset_minutes = due_time && notifyVal !== "" ? parseInt(notifyVal, 10) : null;
  const recurrence =
    selectedRecurrenceDays.size > 0 ? WEEKDAY_ORDER.filter((d) => selectedRecurrenceDays.has(d)).join(",") : null;
  const note = document.getElementById("todo-note").value.trim() || null;
  if (!title) return;
  await api("/api/todos", {
    method: "POST",
    body: JSON.stringify({ title, category, priority, due_date, due_time, recurrence, notify_offset_minutes, note }),
  });
  document.getElementById("todo-title").value = "";
  document.getElementById("todo-due-date").value = "";
  document.getElementById("todo-due-time").value = "";
  document.getElementById("todo-due-time").style.display = "none";
  document.getElementById("todo-notify").value = "";
  document.getElementById("todo-notify").style.display = "none";
  document.getElementById("todo-note").value = "";
  document.getElementById("todo-time-toggle").textContent = "+ Add time";
  setRecurrenceDays([]);
  closeTodoAddPanel();
  loadTodos();
});

// ---------- todo detail panel ----------

let currentDetailTodoId = null;

function openTodoDetail(t) {
  currentDetailTodoId = t.id;
  document.getElementById("todo-detail-title").value = t.title;
  document.getElementById("todo-detail-category").value = t.category || "";
  document.getElementById("todo-detail-priority").value = t.priority || "medium";
  document.getElementById("todo-detail-due-date").value = t.due_date || "";
  const timeInput = document.getElementById("todo-detail-due-time");
  const notifySelect = document.getElementById("todo-detail-notify");
  const toggleBtn = document.getElementById("todo-detail-time-toggle");
  if (t.due_time) {
    timeInput.style.display = "";
    notifySelect.style.display = "";
    toggleBtn.textContent = "− Remove time";
    timeInput.value = t.due_time;
    notifySelect.value = t.notify_offset_minutes != null ? String(t.notify_offset_minutes) : "";
  } else {
    timeInput.style.display = "none";
    notifySelect.style.display = "none";
    toggleBtn.textContent = "+ Add time";
    timeInput.value = "";
    notifySelect.value = "";
  }
  setDetailRecurrenceDays(t.recurrence ? t.recurrence.split(",") : []);
  document.getElementById("todo-detail-note").value = t.note || "";
  document.getElementById("todo-detail-status").textContent = "";
  document.getElementById("todo-detail-panel").classList.remove("hidden");
  document.getElementById("todo-detail-backdrop").classList.remove("hidden");
}

function closeTodoDetail() {
  document.getElementById("todo-detail-panel").classList.add("hidden");
  document.getElementById("todo-detail-backdrop").classList.add("hidden");
  currentDetailTodoId = null;
}

document.getElementById("todo-detail-close").addEventListener("click", closeTodoDetail);
document.getElementById("todo-detail-backdrop").addEventListener("click", closeTodoDetail);

guardedSubmit(document.getElementById("todo-detail-form"), async (e) => {
  if (!currentDetailTodoId) return;
  const title = document.getElementById("todo-detail-title").value.trim();
  const category = document.getElementById("todo-detail-category").value || null;
  const priority = document.getElementById("todo-detail-priority").value;
  const due_date = document.getElementById("todo-detail-due-date").value || null;
  const due_time = document.getElementById("todo-detail-due-time").value || null;
  const notifyVal = document.getElementById("todo-detail-notify").value;
  const notify_offset_minutes = due_time && notifyVal !== "" ? parseInt(notifyVal, 10) : null;
  const recurrence =
    selectedDetailRecurrenceDays.size > 0
      ? WEEKDAY_ORDER.filter((d) => selectedDetailRecurrenceDays.has(d)).join(",")
      : null;
  const note = document.getElementById("todo-detail-note").value.trim() || null;
  if (!title) return;
  await api(`/api/todos/${currentDetailTodoId}`, {
    method: "PUT",
    body: JSON.stringify({ title, category, priority, due_date, due_time, recurrence, notify_offset_minutes, note }),
  });
  document.getElementById("todo-detail-status").textContent = "Saved";
  loadTodos();
  loadCalendar();
  closeTodoDetail();
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- study logs ----------

function renderStudyButtons(cats) {
  const container = document.getElementById("study-buttons");
  container.innerHTML = cats
    .map(
      (c) =>
        `<button type="button" class="subject-btn" data-subject="${escapeHtml(c.name)}" style="--subject-color:${colorFor(c.name)}">${escapeHtml(c.name)}</button>`
    )
    .join("");
  container.querySelectorAll(".subject-btn").forEach((btn) => {
    btn.addEventListener("click", () => openStartPanel(btn.dataset.subject, null));
  });
}

// 画面上部の科目ボタンまで指を伸ばさなくても記録を開始できるよう、下部(親指が届く位置)にも
// 同じ科目一覧をFAB経由のミニメニューとして複製表示する。中身は上部のボタンと完全に同じ動作。
function renderStudyFabMenu(cats) {
  const menu = document.getElementById("study-fab-menu");
  menu.innerHTML = cats
    .map(
      (c) =>
        `<button type="button" class="subject-btn" data-subject="${escapeHtml(c.name)}" style="--subject-color:${colorFor(c.name)}">${escapeHtml(c.name)}</button>`
    )
    .join("");
  menu.querySelectorAll(".subject-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      menu.classList.add("hidden");
      openStartPanel(btn.dataset.subject, null);
    });
  });
}

document.getElementById("study-fab").addEventListener("click", () => {
  document.getElementById("study-fab-menu").classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
  const menu = document.getElementById("study-fab-menu");
  const fab = document.getElementById("study-fab");
  if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== fab) {
    menu.classList.add("hidden");
  }
});

function populateManualLogSubjects(cats) {
  const select = document.getElementById("manual-log-subject");
  const previous = select.value;
  select.innerHTML = cats
    .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)
    .join("");
  if (cats.some((c) => c.name === previous)) select.value = previous;
}

function localDatetimeNow() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

function nowLocalTimestamp() {
  return `${localDatetimeNow().replace("T", " ")}:00`; // "YYYY-MM-DD HH:MM:SS"
}

document.getElementById("manual-log-toggle").addEventListener("click", () => {
  const form = document.getElementById("manual-log-form");
  const opening = form.classList.contains("hidden");
  form.classList.toggle("hidden");
  if (opening) {
    document.getElementById("manual-log-datetime").value = localDatetimeNow();
  }
});

guardedSubmit(document.getElementById("manual-log-form"), async (e) => {
  const subject = document.getElementById("manual-log-subject").value;
  const minutes = parseInt(document.getElementById("manual-log-minutes").value, 10);
  const datetimeLocal = document.getElementById("manual-log-datetime").value; // "YYYY-MM-DDTHH:MM"
  const note = document.getElementById("manual-log-note").value.trim() || null;
  if (!subject || !minutes || !datetimeLocal) return;
  await api("/api/study-logs", {
    method: "POST",
    body: JSON.stringify({
      subject,
      minutes,
      note,
      logged_at: `${datetimeLocal.replace("T", " ")}:00`,
    }),
  });
  e.target.reset();
  document.getElementById("manual-log-form").classList.add("hidden");
  loadStudySummary();
  loadStudyLogList();
  loadStudyChart();
  loadGoalProgress();
});

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

// ---------- session start panel (mode / duration / clock-only) ----------

let pendingStart = null; // { subject, todoId }
let startMode = "countup";
let startTrigger = null;

const startBackdrop = document.getElementById("start-backdrop");
const startPanel = document.getElementById("start-panel");

function openStartPanel(subject, todoId) {
  if (timerSubject) {
    alert("A timer is already running");
    return;
  }
  pendingStart = { subject, todoId };
  document.getElementById("start-subject-name").textContent = subject;
  setStartMode("countup");
  document.getElementById("start-duration-input").value = 25;
  document.getElementById("start-clockonly").checked = false;
  document.getElementById("start-keep-awake").checked = false;
  startTrigger = null;
  document.querySelectorAll("#start-trigger-picker .reason-btn").forEach((b) => {
    b.classList.remove("active");
  });
  startBackdrop.classList.remove("hidden");
  startPanel.classList.remove("hidden");
}

function closeStartPanel() {
  pendingStart = null;
  startBackdrop.classList.add("hidden");
  startPanel.classList.add("hidden");
}

document.getElementById("start-close").addEventListener("click", closeStartPanel);
startBackdrop.addEventListener("click", closeStartPanel);

function setStartMode(mode) {
  startMode = mode;
  document.querySelectorAll("#start-mode-toggle .period-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  document.getElementById("start-duration-row").classList.toggle("hidden", mode !== "countdown");
}

document.querySelectorAll("#start-mode-toggle .period-btn").forEach((btn) => {
  btn.addEventListener("click", () => setStartMode(btn.dataset.mode));
});

document.querySelectorAll("#start-duration-row [data-minutes]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("start-duration-input").value = btn.dataset.minutes;
  });
});

document.querySelectorAll("#start-trigger-picker .reason-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const isSame = startTrigger === btn.dataset.trigger;
    startTrigger = isSame ? null : btn.dataset.trigger;
    document.querySelectorAll("#start-trigger-picker .reason-btn").forEach((b) => {
      b.classList.toggle("active", b === btn && !isSame);
    });
  });
});

document.getElementById("start-begin-btn").addEventListener("click", () => {
  if (!pendingStart) return;
  const { subject, todoId } = pendingStart;
  const clockOnly = document.getElementById("start-clockonly").checked;
  const keepAwake = document.getElementById("start-keep-awake").checked;
  let targetMs = null;
  if (startMode === "countdown") {
    const minutes = parseInt(document.getElementById("start-duration-input").value, 10);
    if (!minutes || minutes <= 0) {
      alert("Please enter a duration (min)");
      return;
    }
    targetMs = minutes * 60000;
    // countdown completion relies on a real system notification (see notifyLocal) to reach the
    // user even if the tab is backgrounded/screen locked; ask for permission up front so it's
    // ready by the time the countdown ends, instead of only via the settings-tab toggle.
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }
  const trigger = startTrigger;
  closeStartPanel();
  beginSession(subject, todoId, startMode, targetMs, clockOnly, trigger, keepAwake);
});

// ---------- focus timer (start / pause / resume / stop / minimize) ----------

let timerInterval = null;
let timerSubject = null;
let activeTodoId = null;
let accumulatedMs = 0;
let segmentStart = null;
let isPaused = false;
let sessionMode = "countup"; // "countup" | "countdown"
let sessionTargetMs = null;
let sessionClockOnly = false;
let sessionKeepAwake = false; // user-selected "don't let the screen sleep" option, independent of clock-only
let sessionCompleted = false;
let overlayMinimized = false;
let sessionStartTrigger = null;

const RING_CIRCUMFERENCE = 2 * Math.PI * 54;
const RING_PERIOD_MS = 25 * 60 * 1000; // countup ring completes one lap every 25 min, purely decorative
const FOCUS_SESSION_KEY = "focusSession";
// longer/heavier than a typical notification buzz so a countdown finishing reads as more
// urgent than a routine ping; still a single fixed pattern (no repeat/loop, browsers don't
// allow web content to keep vibrating after a notification is shown).
const SESSION_END_VIBRATE_PATTERN = [300, 150, 300, 150, 300, 150, 300, 150, 300];

function currentElapsedMs() {
  return accumulatedMs + (segmentStart ? Date.now() - segmentStart : 0);
}

// keeps the server aware of the countdown's true end time so the existing push-notification
// cron (already polling for ToDo/event reminders) can catch completion even if this tab is
// fully backgrounded/suspended and its own setInterval never runs notifyLocal(). Best-effort:
// pass remainingSeconds=null to clear tracking (pause/stop), a number to (re)arm it.
function syncFocusSessionServer(remainingSeconds, subject) {
  api("/api/focus-session/sync", {
    method: "POST",
    body: JSON.stringify({ remaining_seconds: remainingSeconds, subject: subject || null }),
  }).catch(() => {});
}

// JpBlocker(Android側のアプリブロック連携)向けに「今セッション中か」を反映する。上の
// syncFocusSessionServerとは別物(あちらはカウントダウンのみ・push通知の保険用途)。こちらは
// カウントアップ/カウントダウン問わず開始〜終了を送る。一時停止中は呼ばない(ブロック維持のため)。
//
// active:false(セッション終了・破棄)はkeepalive:trueで送る: 破棄ボタン押下直後にPWAを
// 閉じる/タブを切り替えるとページが即破棄され、通常のfetchは送信途中で打ち切られうる。
// その場合サーバー側はsession_activeが1のまま残り、JpBlocker側のマナーモード解除・
// ブロック解除が永久に発火しなくなる(実際に約14時間このバグでスタックした実績あり)。
// keepalive:trueならページが閉じてもブラウザがリクエスト送信を引き継いで完了させる。
function syncSessionActiveFlag(active, subject) {
  api("/api/focus-session/active", {
    method: "POST",
    body: JSON.stringify({ active, subject: subject || null }),
    keepalive: true,
  }).catch(() => {});
}

// 「今フォーカスタイマーが動いている状態」自体をもう一方のデバイス(スマホ⇄PC)へリアルタイムに
// 同期表示するのは難しい(タイマーはローカルのJS変数+localStorageのみで管理、共有DBには
// syncSessionActiveFlag()が送るsession_active等のフラグしかない)ため、代わりに上記フラグを
// 定期ポーリングして「今どこかのデバイスでセッション中か+経過時間」を分かりやすく表示する。
// このデバイス自身がタイマーを動かしている間はミニバー/オーバーレイで既に見えているので出さない。
// 経過時間の表示・更新はupdateActivationBanner()と同じ構成(ポーリングは重い呼び出しなので粗く、
// 見た目のtickはローカル計算で細かく)。
let peerSessionPollInterval = null;
let peerSessionTickInterval = null;
let peerSessionSubject = null;
let peerSessionStartedAt = null; // Date | null

function updatePeerSessionBanner() {
  const banner = document.getElementById("peer-session-banner");
  const label = document.getElementById("peer-session-banner-label");
  if (!peerSessionStartedAt) {
    banner.classList.add("hidden");
    return;
  }
  const elapsedMin = Math.max(0, Math.floor((Date.now() - peerSessionStartedAt.getTime()) / 60000));
  const subjectText = peerSessionSubject ? ` · ${peerSessionSubject}` : "";
  label.innerHTML = `${ICONS.clock}Studying now${subjectText} · ${formatLogDuration(elapsedMin)}`;
  banner.classList.remove("hidden");
}

async function checkPeerSession() {
  if (timerSubject) {
    // this device already has its own timer showing; don't also poll/display the peer banner
    peerSessionStartedAt = null;
    if (peerSessionTickInterval) {
      clearInterval(peerSessionTickInterval);
      peerSessionTickInterval = null;
    }
    updatePeerSessionBanner();
    return;
  }
  let status;
  try {
    status = await api("/api/focus-session/current");
  } catch {
    return; // best-effort; leave the banner as it was on a network hiccup
  }
  if (status && status.active) {
    peerSessionSubject = status.subject || null;
    // Unlike other timestamps in this app (which the client writes in its own local time via
    // nowLocalTimestamp()), session_started_at is written server-side by main.py's datetime.now()
    // - i.e. the server's (UTC) clock, not this device's local time. Parsing it the same way as
    // those client-local strings double-counted this device's UTC offset as elapsed time (e.g.
    // NZ's UTC+12 showed up as a phantom +12h on top of the real elapsed minutes). Appending "Z"
    // tells Date() to parse it as UTC instead of local time.
    peerSessionStartedAt = status.started_at ? new Date(status.started_at.replace(" ", "T") + "Z") : new Date();
    if (!peerSessionTickInterval) {
      peerSessionTickInterval = setInterval(updatePeerSessionBanner, 30000);
    }
  } else {
    peerSessionStartedAt = null;
    if (peerSessionTickInterval) {
      clearInterval(peerSessionTickInterval);
      peerSessionTickInterval = null;
    }
  }
  updatePeerSessionBanner();
}

function startPeerSessionPolling() {
  checkPeerSession();
  if (!peerSessionPollInterval) {
    peerSessionPollInterval = setInterval(checkPeerSession, 30000);
  }
}

// timer state lives in plain JS vars, which a page reload (manual refresh, PWA relaunch,
// server cold-start forcing a reconnect) wipes out; persist it so restoreSession() can rebuild
// the running clock from wall-clock timestamps instead of losing it silently.
function persistSession() {
  if (!timerSubject) {
    localStorage.removeItem(FOCUS_SESSION_KEY);
    return;
  }
  localStorage.setItem(
    FOCUS_SESSION_KEY,
    JSON.stringify({
      subject: timerSubject,
      todoId: activeTodoId,
      accumulatedMs,
      segmentStart,
      isPaused,
      sessionMode,
      sessionTargetMs,
      sessionClockOnly,
      sessionKeepAwake,
      sessionCompleted,
      overlayMinimized,
      sessionStartTrigger,
    })
  );
}

function restoreSession() {
  const raw = localStorage.getItem(FOCUS_SESSION_KEY);
  if (!raw) return;
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    localStorage.removeItem(FOCUS_SESSION_KEY);
    return;
  }
  if (!saved.subject) {
    localStorage.removeItem(FOCUS_SESSION_KEY);
    return;
  }

  timerSubject = saved.subject;
  activeTodoId = saved.todoId;
  accumulatedMs = saved.accumulatedMs;
  segmentStart = saved.segmentStart;
  isPaused = saved.isPaused;
  sessionMode = saved.sessionMode;
  sessionTargetMs = saved.sessionTargetMs;
  sessionClockOnly = saved.sessionClockOnly;
  sessionKeepAwake = !!saved.sessionKeepAwake;
  sessionCompleted = !!saved.sessionCompleted;
  overlayMinimized = saved.overlayMinimized;
  sessionStartTrigger = saved.sessionStartTrigger || null;

  if (overlayMinimized) {
    showMiniBar();
  } else {
    openFocusOverlay();
  }
  syncFocusOpenBodyClass();
  updatePauseUI();
  if (!isPaused) {
    startTimerTick();
    if (sessionClockOnly || sessionKeepAwake) requestWakeLock();
  }
}

function beginSession(subject, todoId, mode, targetMs, clockOnly, trigger, keepAwake) {
  timerSubject = subject;
  activeTodoId = todoId;
  accumulatedMs = 0;
  segmentStart = Date.now();
  isPaused = false;
  sessionMode = mode;
  sessionTargetMs = targetMs;
  sessionClockOnly = clockOnly;
  sessionKeepAwake = !!keepAwake;
  sessionCompleted = false;
  overlayMinimized = false;
  sessionStartTrigger = trigger || null;
  openFocusOverlay();
  startTimerTick();
  persistSession();
  if (clockOnly || keepAwake) {
    requestWakeLock();
  }
  if (mode === "countdown") {
    syncFocusSessionServer(Math.round(targetMs / 1000), subject);
  }
  syncSessionActiveFlag(true, subject);
  checkPeerSession(); // this device now has its own timer showing; hide the peer banner immediately
}

function updateFocusDisplay() {
  const elapsed = currentElapsedMs();
  let displayMs = elapsed;
  let progress;
  let prefix = "";
  if (sessionMode === "countdown") {
    const remaining = sessionTargetMs - elapsed;
    if (remaining <= 0) {
      if (!sessionCompleted) {
        sessionCompleted = true;
        notifySessionEnd(timerSubject);
        persistSession();
      }
      // keep running past the target instead of auto-stopping: there's a real lag between
      // the countdown hitting zero and the user noticing the notification, and that gap was
      // silently getting dropped from the recorded time. Now it just counts up as overtime
      // (reusing the countup ring's lap animation) until the user taps stop themselves.
      const overtime = -remaining;
      displayMs = overtime;
      prefix = "+";
      progress = (overtime % RING_PERIOD_MS) / RING_PERIOD_MS;
    } else {
      displayMs = remaining;
      progress = remaining / sessionTargetMs;
    }
  } else {
    progress = (elapsed % RING_PERIOD_MS) / RING_PERIOD_MS;
  }
  const text = prefix + formatElapsed(displayMs);
  document.getElementById("focus-timer").textContent = text;
  document.getElementById("focus-ring-fill").style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - progress);
  const miniTime = document.getElementById("mini-timer-time");
  if (miniTime) miniTime.textContent = text;
}

function startTimerTick() {
  updateFocusDisplay();
  timerInterval = setInterval(updateFocusDisplay, 1000);
}

function stopTimerTick() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function syncFocusOpenBodyClass() {
  document.body.classList.toggle("focus-open", !!timerSubject && !overlayMinimized);
}

function openFocusOverlay() {
  const color = colorFor(timerSubject);
  document.getElementById("focus-subject-name").textContent = timerSubject;
  document.getElementById("focus-timer").style.color = color;
  document.getElementById("focus-ring-fill").style.stroke = color;
  document.getElementById("focus-pause-btn").textContent = "Pause";
  document.getElementById("focus-clockonly-badge").classList.toggle("hidden", !sessionClockOnly);
  document.getElementById("focus-keepawake-badge").classList.toggle("hidden", !sessionKeepAwake);
  const overlay = document.getElementById("focus-overlay");
  overlay.classList.remove("hidden", "paused");
  overlay.classList.toggle("clock-only", sessionClockOnly);
  hideMiniBar();
  syncFocusOpenBodyClass();
  updateFocusDisplay();
}

function closeFocusOverlay() {
  document.getElementById("focus-overlay").classList.add("hidden");
  syncFocusOpenBodyClass();
}

function minimizeFocusOverlay() {
  if (!timerSubject) return;
  overlayMinimized = true;
  document.getElementById("focus-overlay").classList.add("hidden");
  syncFocusOpenBodyClass();
  showMiniBar();
  if (sessionClockOnly && !isPaused) {
    pauseSession();
  }
  persistSession();
}

function expandFocusOverlay() {
  if (!timerSubject) return;
  overlayMinimized = false;
  hideMiniBar();
  document.getElementById("focus-overlay").classList.remove("hidden");
  syncFocusOpenBodyClass();
  persistSession();
}

document.getElementById("focus-minimize-btn").addEventListener("click", minimizeFocusOverlay);

function showMiniBar() {
  const bar = document.getElementById("mini-timer-bar");
  bar.classList.remove("hidden");
  bar.style.bottom = `${document.getElementById("tabbar").getBoundingClientRect().height}px`;
  document.getElementById("mini-timer-subject").textContent = timerSubject;
  bar.style.setProperty("--subject-color", colorFor(timerSubject));
  updateMiniStatus();
  updateFocusDisplay();
  raiseFabsAboveMiniBar();
}

function hideMiniBar() {
  document.getElementById("mini-timer-bar").classList.add("hidden");
  resetFabPosition();
}

// 計測中はミニタイマーバーが画面下に浮くので、+ボタン(各タブに1つずつ、.fab)が
// それと重ならないよう分だけ底上げする(2026-08-16)。
function raiseFabsAboveMiniBar() {
  const bar = document.getElementById("mini-timer-bar");
  const barHeight = bar.getBoundingClientRect().height;
  document.querySelectorAll(".fab").forEach((fab) => {
    fab.style.bottom = `calc(92px + ${barHeight}px)`;
  });
}

function resetFabPosition() {
  document.querySelectorAll(".fab").forEach((fab) => {
    fab.style.bottom = "";
  });
}

function updateMiniStatus() {
  document.getElementById("mini-timer-status").textContent = isPaused ? "Paused" : "";
  document.getElementById("mini-pause-btn").textContent = isPaused ? "▶" : "⏸";
}

function pauseSession() {
  if (!timerSubject || isPaused) return;
  accumulatedMs += Date.now() - segmentStart;
  segmentStart = null;
  isPaused = true;
  stopTimerTick();
  releaseWakeLock();
  updatePauseUI();
  persistSession();
  // stop server-side tracking while paused, since the countdown isn't actually progressing;
  // resumeSession() re-arms it with the recomputed remaining time.
  if (sessionMode === "countdown" && !sessionCompleted) {
    syncFocusSessionServer(null, null);
  }
}

function resumeSession() {
  if (!timerSubject || !isPaused) return;
  segmentStart = Date.now();
  isPaused = false;
  startTimerTick();
  updatePauseUI();
  persistSession();
  if (sessionClockOnly || sessionKeepAwake) {
    requestWakeLock();
  }
  if (sessionMode === "countdown" && !sessionCompleted) {
    const remainingSeconds = Math.max(0, Math.round((sessionTargetMs - currentElapsedMs()) / 1000));
    syncFocusSessionServer(remainingSeconds, timerSubject);
  }
}

function updatePauseUI() {
  const overlay = document.getElementById("focus-overlay");
  document.getElementById("focus-pause-btn").textContent = isPaused ? "Resume" : "Pause";
  overlay.classList.toggle("paused", isPaused);
  updateMiniStatus();
  updateFocusDisplay();
}

document.getElementById("focus-pause-btn").addEventListener("click", () => {
  if (isPaused) resumeSession();
  else pauseSession();
});

document.getElementById("mini-pause-btn").addEventListener("click", () => {
  if (isPaused) resumeSession();
  else pauseSession();
});

document.getElementById("mini-timer-bar").addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  expandFocusOverlay();
});

// ---------- screen wake lock (clock-only mode / keep-awake option) ----------
// two independent reasons a session might want to hold a wake lock:
// - clock-only sessions are meant to pause when you actually leave (switch app, lock the
//   phone), but the phone's own screen-timeout blanks the display the same way and was
//   silently triggering that same pause. Holding a wake lock stops the OS from timing the
//   screen out on its own; a real app-switch or manual lock-button press still fires
//   visibilitychange and pauses as before.
// - "画面をスリープさせない" (start-keep-awake) is a plain opt-in for any mode: keep the
//   screen on for the duration of the session, no auto-pause behavior attached to it.
let wakeLock = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// visibility change (screen lock / switch to another app): only clock-only sessions auto-pause
// (keep-awake alone doesn't imply "must be looking at the screen"). The OS also force-releases
// any wake lock whenever the tab goes hidden, so re-acquire it once a still-running
// clock-only or keep-awake session becomes visible again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (timerSubject && sessionClockOnly && !isPaused) {
      pauseSession();
    }
  } else if (timerSubject && (sessionClockOnly || sessionKeepAwake) && !isPaused) {
    requestWakeLock();
  }
});

function resetSessionState() {
  stopTimerTick();
  releaseWakeLock();
  const wasCountdown = sessionMode === "countdown";
  timerSubject = null;
  activeTodoId = null;
  accumulatedMs = 0;
  segmentStart = null;
  isPaused = false;
  sessionMode = "countup";
  sessionTargetMs = null;
  sessionClockOnly = false;
  sessionKeepAwake = false;
  sessionCompleted = false;
  overlayMinimized = false;
  sessionStartTrigger = null;
  closeFocusOverlay();
  hideMiniBar();
  localStorage.removeItem(FOCUS_SESSION_KEY);
  if (wasCountdown) {
    syncFocusSessionServer(null, null);
  }
  syncSessionActiveFlag(false, null);
}

function discardSession() {
  if (!timerSubject) return;
  if (!confirm("Discard this session without saving it?")) return;
  resetSessionState();
}

async function finishSession(elapsedMinutes) {
  const subject = timerSubject;
  const todoId = activeTodoId;
  const startTrigger = sessionStartTrigger;
  resetSessionState();
  await api("/api/study-logs", {
    method: "POST",
    body: JSON.stringify({
      subject,
      minutes: elapsedMinutes,
      logged_at: `${localDatetimeNow().replace("T", " ")}:00`,
      start_trigger: startTrigger,
    }),
  });
  if (todoId && confirm("Mark this task complete?")) {
    await api(`/api/todos/${todoId}/toggle`, { method: "POST" });
    loadTodos();
    loadTodoStats();
  }
  loadStudySummary();
  loadStudyLogList();
  loadStudyChart();
  loadGoalProgress();
}

// alert()/vibrate() only reach the user while this tab is focused; a background tab or locked
// screen suppresses both silently, which is why countdown completion went unnoticed. A real
// system notification (via the already-registered service worker) survives that case.
async function notifyLocal(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(title, {
      body,
      icon: "/static/icon-192.png",
      badge: "/static/icon-192.png",
      // the OS-level notification vibration (Android) fires even while this page isn't
      // focused, unlike navigator.vibrate() below which only works in the foreground.
      vibrate: SESSION_END_VIBRATE_PATTERN,
    });
  } catch (e) {
    // notification best-effort; alert() below still covers the foreground case
  }
}

function notifySessionEnd(subject) {
  if (navigator.vibrate) navigator.vibrate(SESSION_END_VIBRATE_PATTERN);
  notifyLocal("Compass", `${subject}: time's up (still recording until you stop)`);
  alert(`${subject}: time's up\nStill recording until you stop`);
}

document.getElementById("focus-stop-btn").addEventListener("click", async () => {
  if (!timerSubject) return;
  const totalMs = currentElapsedMs();
  const elapsedMinutes = Math.max(1, Math.round(totalMs / 60000));
  await finishSession(elapsedMinutes);
});

document.getElementById("mini-stop-btn").addEventListener("click", async () => {
  if (!timerSubject) return;
  const totalMs = currentElapsedMs();
  const elapsedMinutes = Math.max(1, Math.round(totalMs / 60000));
  await finishSession(elapsedMinutes);
});

document.getElementById("focus-discard-btn").addEventListener("click", discardSession);
document.getElementById("mini-discard-btn").addEventListener("click", discardSession);

// ---------- daily / weekly chart ----------

const WEEKLY_CHART_WEEKS = 10;

let chartGranularity = localStorage.getItem("studyChartGranularity") === "day" ? "day" : "week";

function last14Dates() {
  const dates = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(formatLocalDate(d));
  }
  return dates;
}

function mondayOfDate(d) {
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  return monday;
}

function lastNWeekStarts(n) {
  const currentMonday = mondayOfDate(new Date());
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(currentMonday);
    d.setDate(d.getDate() - i * 7);
    weeks.push(formatLocalDate(d));
  }
  return weeks;
}

function monthDayLabel(isoDate) {
  const [, mo, da] = isoDate.split("-");
  return `${parseInt(mo, 10)}/${parseInt(da, 10)}`;
}

async function loadStudyChart() {
  if (chartGranularity === "day") {
    await loadDailyChart();
  } else {
    await loadWeeklyChart();
  }
}

async function loadDailyChart() {
  const raw = await api("/api/study-logs/daily");
  const dates = last14Dates();
  const subjectNames = allCategories.map((c) => c.name);
  raw.forEach((row) => {
    if (!subjectNames.includes(row.subject)) subjectNames.push(row.subject);
  });
  const byBucket = {};
  dates.forEach((d) => {
    byBucket[d] = {};
    subjectNames.forEach((s) => {
      byBucket[d][s] = 0;
    });
  });
  raw.forEach((row) => {
    if (byBucket[row.d]) byBucket[row.d][row.subject] = row.total_minutes;
  });
  renderStudyChart(dates, byBucket, subjectNames, {
    axisLabel: (d) => d.slice(8, 10),
    detailLabel: (d) => d,
  });
}

async function loadWeeklyChart() {
  const raw = await api("/api/study-logs/weekly");
  const weeks = lastNWeekStarts(WEEKLY_CHART_WEEKS);
  const subjectNames = allCategories.map((c) => c.name);
  raw.forEach((row) => {
    if (!subjectNames.includes(row.subject)) subjectNames.push(row.subject);
  });
  const byBucket = {};
  weeks.forEach((w) => {
    byBucket[w] = {};
    subjectNames.forEach((s) => {
      byBucket[w][s] = 0;
    });
  });
  raw.forEach((row) => {
    if (byBucket[row.week_start]) byBucket[row.week_start][row.subject] = row.total_minutes;
  });
  renderStudyChart(weeks, byBucket, subjectNames, {
    axisLabel: monthDayLabel,
    detailLabel: (w) => `Week of ${monthDayLabel(w)}`,
  });
}

function renderStudyChart(buckets, byBucket, subjectNames, labelFns) {
  const container = document.getElementById("study-chart");
  const totals = buckets.map((b) => subjectNames.reduce((sum, s) => sum + (byBucket[b][s] || 0), 0));
  const maxTotal = Math.max(60, ...totals);
  const chartW = 320;
  const chartH = 130;
  const padLeft = 26;
  // 最大値の目盛りラベルがviewBoxの上端ぴったりに描かれて見切れていたため、上にも余白を確保する。
  const padTop = 9;
  const padBottom = 14;
  const plotW = chartW - padLeft - 2;
  const plotH = chartH - padTop - padBottom;
  const barGap = 3;
  const barW = plotW / buckets.length - barGap;

  const gridLines = [0, 0.5, 1]
    .map((frac) => {
      const y = padTop + plotH - plotH * frac;
      const label = Math.round(((maxTotal * frac) / 60) * 10) / 10;
      return `
        <line x1="${padLeft}" y1="${y}" x2="${chartW}" y2="${y}" stroke="var(--border)" stroke-width="1" />
        <text x="${padLeft - 4}" y="${y + 3}" font-size="8" fill="var(--text-muted)" text-anchor="end">${label}h</text>
      `;
    })
    .join("");

  const bars = buckets
    .map((b, i) => {
      const x = padLeft + i * (barW + barGap);
      let yCursor = padTop + plotH;
      const segments = subjectNames.map((s) => {
        const minutes = byBucket[b][s] || 0;
        if (minutes <= 0) return "";
        const h = (minutes / maxTotal) * plotH;
        const y = yCursor - h;
        yCursor -= h + 1;
        return `<rect x="${x}" y="${y}" width="${Math.max(barW, 0)}" height="${Math.max(h, 0)}" fill="${colorFor(s)}" rx="2" data-bucket="${b}" data-subject="${s}" data-minutes="${minutes}"></rect>`;
      }).join("");
      const axisLabel = labelFns.axisLabel(b);
      return `${segments}<text x="${x + barW / 2}" y="${chartH - 1}" font-size="8" fill="var(--text-muted)" text-anchor="middle">${axisLabel}</text>`;
    })
    .join("");

  const legend = subjectNames
    .filter((s) => buckets.some((b) => byBucket[b][s] > 0))
    .map((s) => `<span class="legend-item"><span class="legend-dot" style="background:${colorFor(s)}"></span>${s}</span>`)
    .join("");

  container.innerHTML = `
    <div class="chart-legend">${legend}</div>
    <svg viewBox="0 0 ${chartW} ${chartH}" class="study-svg-chart">${gridLines}${bars}</svg>
  `;

  container.querySelectorAll("rect[data-subject]").forEach((rect) => {
    rect.addEventListener("click", () => {
      const { bucket, subject, minutes } = rect.dataset;
      document.getElementById("study-chart-detail").textContent = `${labelFns.detailLabel(bucket)} ${subject}: ${minutes} min`;
    });
  });
}

function updateChartTitle() {
  document.getElementById("study-chart-title").textContent =
    chartGranularity === "day" ? "Last 14 days" : `Last ${WEEKLY_CHART_WEEKS} weeks`;
}

document.querySelectorAll(".period-btn").forEach((btn) => {
  btn.classList.toggle("active", btn.dataset.granularity === chartGranularity);
  btn.addEventListener("click", () => {
    chartGranularity = btn.dataset.granularity;
    localStorage.setItem("studyChartGranularity", chartGranularity);
    document.querySelectorAll(".period-btn").forEach((b) => b.classList.toggle("active", b === btn));
    updateChartTitle();
    loadStudyChart();
  });
});

updateChartTitle();

// ---------- weekly / monthly goal progress ----------

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} hr`;
}

async function loadGoalProgress() {
  const p = await api("/api/study-logs/progress");
  document.getElementById("stat-today").textContent = formatDuration(p.today_minutes);
  document.getElementById("stat-month").textContent = formatDuration(p.month_minutes);
  document.getElementById("stat-total").textContent = formatDuration(p.total_minutes);

  const dailyMinLabel = document.getElementById("daily-min-label");
  const dailyMinFill = document.getElementById("daily-min-fill");
  const banner = document.getElementById("daily-min-banner");
  const bannerLabel = document.getElementById("daily-min-banner-label");
  const bannerFill = document.getElementById("daily-min-banner-fill");
  if (p.daily_minimum_minutes) {
    const reached = p.today_minutes >= p.daily_minimum_minutes;
    const labelText = `${p.today_minutes} / ${p.daily_minimum_minutes} min${reached ? ` ${ICONS.check}` : ""}`;
    const fillPct = `${Math.min(100, (p.today_minutes / p.daily_minimum_minutes) * 100)}%`;
    dailyMinLabel.innerHTML = labelText;
    dailyMinFill.style.width = fillPct;
    banner.classList.remove("hidden");
    banner.classList.toggle("reached", reached);
    bannerLabel.innerHTML = reached ? `Today's minimum ${labelText}` : `${p.daily_minimum_minutes - p.today_minutes} min left today`;
    bannerFill.style.width = fillPct;
  } else {
    dailyMinLabel.textContent = "Not set";
    dailyMinFill.style.width = "0%";
    banner.classList.add("hidden");
  }
  document.getElementById("daily-goal-input").value = p.daily_minimum_minutes || "";

  const weekHours = (p.week_minutes / 60).toFixed(1);
  const monthHours = (p.month_minutes / 60).toFixed(1);
  const weekGoalHours = p.weekly_goal_minutes ? p.weekly_goal_minutes / 60 : null;
  const monthGoalHours = p.monthly_goal_minutes ? p.monthly_goal_minutes / 60 : null;

  document.getElementById("week-progress-label").textContent = weekGoalHours
    ? `${weekHours} / ${weekGoalHours} hr`
    : `${weekHours} hr (no goal set)`;
  document.getElementById("week-progress-fill").style.width = weekGoalHours
    ? `${Math.min(100, (p.week_minutes / p.weekly_goal_minutes) * 100)}%`
    : "0%";

  document.getElementById("month-progress-label").textContent = monthGoalHours
    ? `${monthHours} / ${monthGoalHours} hr`
    : `${monthHours} hr (no goal set)`;
  document.getElementById("month-progress-fill").style.width = monthGoalHours
    ? `${Math.min(100, (p.month_minutes / p.monthly_goal_minutes) * 100)}%`
    : "0%";

  document.getElementById("weekly-goal-input").value = weekGoalHours || "";
  document.getElementById("monthly-goal-input").value = monthGoalHours || "";

  loadMoodPanel();
}

let selectedMoodScore = 5;
let selectedMoodReason = null;

function moodTierForScore(score) {
  if (score <= 4) return "low";
  if (score >= 7) return "high";
  return "mid";
}

function updateMoodReasonTierVisibility(score) {
  const tier = moodTierForScore(score);
  document.querySelectorAll("#mood-reason-picker .reason-btn").forEach((btn) => {
    const visible = tier === "mid" || btn.dataset.tier === tier || btn.dataset.tier === "both";
    btn.classList.toggle("hidden", !visible);
    if (!visible && selectedMoodReason === btn.dataset.reason) {
      setSelectedMoodReason(null);
    }
  });
}

function setSelectedMoodScore(score) {
  selectedMoodScore = score;
  document.querySelectorAll(".mood-scale-btn").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.score, 10) === score);
  });
  updateMoodReasonTierVisibility(score);
}

function setSelectedMoodReason(reason) {
  selectedMoodReason = reason;
  document.querySelectorAll("#mood-reason-picker .reason-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.reason === reason);
  });
}

function formatMoodEntryLine(entry) {
  const time = (entry.logged_at || "").slice(11, 16);
  const tags = [entry.reason, entry.note].filter(Boolean).join(" / ");
  return `${time} Mood ${entry.score}${tags ? `(${tags})` : ""}`;
}

// PC版のDaily log(mood-log-list)用。直近14日分の個別エントリを新しい順に並べる。
function renderMoodLogList(rows) {
  const list = document.getElementById("mood-log-list");
  if (!list) return;
  list.innerHTML = "";
  if (rows.length === 0) {
    list.innerHTML = "<li>No records yet</li>";
    return;
  }
  rows
    .slice()
    .reverse()
    .forEach((e) => {
      const li = document.createElement("li");
      const time = (e.logged_at || "").slice(11, 16);
      const detail = [e.reason, e.note].filter(Boolean).map(escapeHtml).join(" / ") || "-";
      li.innerHTML = `
        <span class="log-info">
          <span class="log-subject">${e.date.slice(5)} ${time}</span>
          <span class="log-time">${detail}</span>
        </span>
        <span class="log-duration">${e.score}/10</span>
      `;
      list.appendChild(li);
    });
}

async function loadMoodPanel() {
  const rows = await api("/api/mood-logs?days=14");
  const today = todayStr();
  const todayEntries = rows.filter((r) => r.date === today).slice().reverse();

  const status = document.getElementById("mood-today-status");
  const listEl = document.getElementById("mood-today-list");
  if (todayEntries.length > 0) {
    status.textContent = `${todayEntries.length} entries today`;
    listEl.innerHTML = todayEntries.map((e) => `<div class="mood-today-entry">${formatMoodEntryLine(e)}</div>`).join("");
  } else {
    status.textContent = "Not recorded";
    listEl.innerHTML = "";
  }

  // PC(md+)では余白を埋めるため、モバイルでは「点をタップ」しないと出ない
  // 個々のエントリをDaily logとして常時一覧表示する(CSS側でmd+のみ表示)。
  renderMoodLogList(rows);

  const dates = last14Dates();
  const entriesByDate = {};
  rows.forEach((row) => {
    if (!entriesByDate[row.date]) entriesByDate[row.date] = [];
    entriesByDate[row.date].push(row);
  });
  const avgByDate = {};
  Object.keys(entriesByDate).forEach((d) => {
    const scores = entriesByDate[d].map((e) => e.score);
    avgByDate[d] = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
  });

  const dailyStudy = await api("/api/study-logs/daily");
  const minutesByDate = {};
  dailyStudy.forEach((row) => {
    minutesByDate[row.d] = (minutesByDate[row.d] || 0) + row.total_minutes;
  });

  const dailyScreenTime = await api("/api/screen-time/daily?days=14");
  const screenMinutesByDate = {};
  dailyScreenTime.forEach((row) => {
    screenMinutesByDate[row.date] = row.total_minutes;
  });

  renderMoodChart(
    dates,
    dates.map((d) => (d in avgByDate ? avgByDate[d] : null)),
    entriesByDate,
    minutesByDate,
    screenMinutesByDate
  );
  loadMoodStats();
  loadMoodReasonStats();
  loadLowMoodAchievement();
  loadScreenTimeMoodCorrelation();
  loadStudyTriggerStats();
  loadSleepPanel();
}

async function loadMoodStats() {
  const s = await api("/api/mood-logs/stats");
  document.getElementById("mood-stat-week").textContent = s.week_avg != null ? `${s.week_avg}` : "-";
  document.getElementById("mood-stat-month").textContent = s.month_avg != null ? `${s.month_avg}` : "-";
}

async function loadLowMoodAchievement() {
  const s = await api("/api/mood-logs/low-mood-achievement?days=30");
  const el = document.getElementById("mood-stat-low-mood-rate");
  if (s.status === "not_configured") el.textContent = "Not set";
  else if (s.status === "insufficient_data") el.textContent = "Not enough data";
  else el.textContent = `${s.rate}% (${s.achieved_days}/${s.low_mood_days} days)`;
}

async function loadScreenTimeMoodCorrelation() {
  const el = document.getElementById("mood-stat-screen-time-correlation");
  if (!el) return;
  const s = await api("/api/screen-time/mood-correlation?days=30");
  if (s.status === "insufficient_data") {
    el.textContent = "Not enough data";
  } else {
    el.textContent = `Low screen time days: ${s.low_screen_time_avg_minutes} min, mood ${s.low_screen_time_avg_mood} / High screen time days: ${s.high_screen_time_avg_minutes} min, mood ${s.high_screen_time_avg_mood}`;
  }
}

async function loadMoodReasonStats() {
  const rows = await api("/api/mood-logs/reason-stats?days=30");
  const list = document.getElementById("mood-reason-stats");
  list.innerHTML = "";
  if (rows.length === 0) {
    list.classList.add("hidden");
    return;
  }
  list.classList.remove("hidden");
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = `${r.reason} avg ${r.avg_score} (${r.count})`;
    list.appendChild(li);
  });
}

function renderMoodChart(dates, scores, entriesByDate, minutesByDate, screenMinutesByDate) {
  const container = document.getElementById("mood-chart");
  const chartW = 320;
  const chartH = 70;
  // スコア10(最高値)の点がviewBox上端ぴったりに来て半分クリップされていたため、上にも余白を確保する。
  const padTop = 5;
  const padBottom = 12;
  const padX = 8;
  const plotH = chartH - padTop - padBottom;
  const plotW = chartW - padX * 2;
  const stepX = dates.length > 1 ? plotW / (dates.length - 1) : 0;
  const xs = dates.map((_, i) => padX + i * stepX);

  const minutesValues = dates.map((d) => (minutesByDate && minutesByDate[d]) || 0);
  const maxMinutes = Math.max(60, ...minutesValues);
  const barW = Math.max(stepX * 0.5, 2);
  const bars = dates
    .map((d, i) => {
      const minutes = minutesValues[i];
      if (minutes <= 0) return "";
      const h = (minutes / maxMinutes) * plotH;
      return `<rect x="${xs[i] - barW / 2}" y="${padTop + plotH - h}" width="${barW}" height="${h}" fill="var(--accent-dim)" rx="1"></rect>`;
    })
    .join("");

  const axisLabels = dates
    .map((d, i) => `<text x="${xs[i]}" y="${chartH - 1}" font-size="7" fill="var(--text-muted)" text-anchor="middle">${d.slice(8, 10)}</text>`)
    .join("");

  // スクリーンタイム(JpBlocker連携、Part B)。棒(勉強時間)とは別軸で独立にスケーリングし、
  // 点線で重ねて描画する(棒と同じ軸だと勉強時間より一桁大きくなりがちで潰れるため)。
  let screenTimePath = "";
  if (screenMinutesByDate) {
    const screenValues = dates.map((d) => screenMinutesByDate[d]);
    const hasScreenData = screenValues.some((v) => v != null);
    if (hasScreenData) {
      const maxScreenMinutes = Math.max(60, ...screenValues.filter((v) => v != null));
      let d2 = "";
      let drawing2 = false;
      dates.forEach((d, i) => {
        const minutes = screenValues[i];
        if (minutes == null) {
          drawing2 = false;
          return;
        }
        const y = padTop + plotH - (minutes / maxScreenMinutes) * plotH;
        d2 += `${drawing2 ? "L" : "M"}${xs[i]},${y} `;
        drawing2 = true;
      });
      screenTimePath = d2
        ? `<path d="${d2.trim()}" fill="none" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="3,2" stroke-linecap="round" stroke-linejoin="round"></path>`
        : "";
    }
  }

  let pathD = "";
  let drawing = false;
  const dots = [];
  dates.forEach((d, i) => {
    const score = scores[i];
    if (score == null) {
      drawing = false;
      return;
    }
    const y = padTop + plotH - ((score - 1) / 9) * plotH;
    pathD += `${drawing ? "L" : "M"}${xs[i]},${y} `;
    drawing = true;
    dots.push(`<circle cx="${xs[i]}" cy="${y}" r="4" fill="var(--accent)" data-date="${d}" data-score="${score}"></circle>`);
  });

  const path = pathD
    ? `<path d="${pathD.trim()}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>`
    : "";

  container.innerHTML = `<svg viewBox="0 0 ${chartW} ${chartH}" class="study-svg-chart">${bars}${screenTimePath}${path}${dots.join("")}${axisLabels}</svg>`;

  container.querySelectorAll("circle[data-date]").forEach((circle) => {
    circle.addEventListener("click", () => {
      const { date: d, score } = circle.dataset;
      const entries = (entriesByDate[d] || []).slice().reverse();
      const detail = document.getElementById("mood-chart-detail");
      const screenMinutes = screenMinutesByDate ? screenMinutesByDate[d] : null;
      const screenText = screenMinutes != null ? ` / Screen time ${screenMinutes} min` : "";
      if (entries.length === 0) {
        detail.textContent = `${d} Mood avg: ${score}/10${screenText}`;
        return;
      }
      const lines = entries.map((e) => formatMoodEntryLine(e));
      detail.textContent = `${d} Mood avg: ${score}/10 / ${lines.join(" / ")}${screenText}`;
    });
  });
}

document.querySelectorAll(".mood-scale-btn").forEach((btn) => {
  btn.addEventListener("click", () => setSelectedMoodScore(parseInt(btn.dataset.score, 10)));
});

document.querySelectorAll("#mood-reason-picker .reason-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const isSame = selectedMoodReason === btn.dataset.reason;
    setSelectedMoodReason(isSame ? null : btn.dataset.reason);
  });
});

document.getElementById("mood-save-btn").addEventListener("click", async () => {
  const score = selectedMoodScore;
  const noteInput = document.getElementById("mood-note");
  const note = noteInput.value.trim();
  await api("/api/mood-logs", {
    method: "POST",
    body: JSON.stringify({
      date: todayStr(),
      score,
      note: note || null,
      reason: selectedMoodReason,
      logged_at: nowLocalTimestamp(),
    }),
  });
  noteInput.value = "";
  setSelectedMoodScore(5);
  setSelectedMoodReason(null);
  loadMoodPanel();
});

guardedSubmit(document.getElementById("goal-minutes-form"), async (e) => {
  const dailyMinutes = parseInt(document.getElementById("daily-goal-input").value, 10);
  const weeklyHours = parseFloat(document.getElementById("weekly-goal-input").value);
  const monthlyHours = parseFloat(document.getElementById("monthly-goal-input").value);
  const payload = {};
  if (!isNaN(dailyMinutes)) payload.daily_minimum_minutes = dailyMinutes;
  if (!isNaN(weeklyHours)) payload.weekly_goal_minutes = Math.round(weeklyHours * 60);
  if (!isNaN(monthlyHours)) payload.monthly_goal_minutes = Math.round(monthlyHours * 60);
  await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
  loadGoalProgress();
});

// ---------- summary & log list ----------

async function loadStudySummary() {
  const summary = await api("/api/study-logs/summary");
  const list = document.getElementById("study-summary");
  list.innerHTML = "";
  if (summary.length === 0) {
    list.innerHTML = "<li>No records yet</li>";
    return;
  }
  summary.forEach((s) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${s.subject}</span><span class="meta">${s.total_minutes} min</span>`;
    list.appendChild(li);
  });
}

function formatLogDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

function formatLoggedAt(s) {
  const [datePart, timePart] = s.split(" ");
  const [, mo, da] = datePart.split("-");
  const [hh, mm] = timePart.split(":");
  return `${parseInt(mo, 10)}/${parseInt(da, 10)} ${hh}:${mm}`;
}

// vocab-app由来のログはstart_triggerが"vocab-app:review"のような形式で入っている
// (main.pyのcreate_vocab_study_log参照)。ここからreview/reading/newsのタブ名を取り出す。
function vocabAppModeLabel(startTrigger) {
  if (!startTrigger || !startTrigger.startsWith("vocab-app:")) return null;
  return startTrigger.slice("vocab-app:".length) || null;
}

async function loadStudyLogList() {
  const logs = await api("/api/study-logs");
  const list = document.getElementById("study-log-list");
  list.innerHTML = "";
  updateStudyLogHeader(logs.length);
  logs.slice(0, 20).forEach((l) => {
    const li = document.createElement("li");
    const modeLabel = vocabAppModeLabel(l.start_trigger);
    li.innerHTML = `
      <span class="log-icon" style="background:${colorFor(l.subject)}"></span>
      <span class="log-info">
        <span class="log-subject">${escapeHtml(l.subject)}${modeLabel ? ` <span class="log-mode">· ${escapeHtml(modeLabel)}</span>` : ""}</span>
        <span class="log-time">${formatLoggedAt(l.logged_at)}</span>
      </span>
      <span class="log-duration">${formatLogDuration(l.minutes)}</span>
      <button class="delete-btn" title="Delete">×</button>
    `;
    li.querySelector(".delete-btn").addEventListener("click", async () => {
      await api(`/api/study-logs/${l.id}`, { method: "DELETE" });
      loadStudyLogList();
      loadStudySummary();
      loadStudyChart();
      loadGoalProgress();
    });
    list.appendChild(li);
  });
}

// ---------- goals ----------

let lastCountdown = null;

function renderCountdown(c) {
  lastCountdown = c;
  document.getElementById("countdown").innerHTML =
    `Until ${escapeHtml(c.label)}<br><span class="days">${c.days_left} days</span>`;
  // 起動画面の「あと◯◯日」にも同じ値を反映する(同じAPIを二重に叩かないよう共用)
  const bootDays = document.getElementById("boot-goal-days");
  if (bootDays) bootDays.textContent = c.days_left;
  const bootLabel = document.getElementById("boot-goal-label");
  if (bootLabel) bootLabel.textContent = `Until ${c.label}`;
}

async function loadCountdown() {
  const c = await api("/api/goals/countdown");
  renderCountdown(c);
}

document.getElementById("countdown-edit-toggle").addEventListener("click", () => {
  const form = document.getElementById("countdown-edit-form");
  const opening = form.classList.contains("hidden");
  form.classList.toggle("hidden");
  if (opening && lastCountdown) {
    document.getElementById("countdown-edit-label").value = lastCountdown.label;
    document.getElementById("countdown-edit-date").value = lastCountdown.target_date;
  }
});

guardedSubmit(document.getElementById("countdown-edit-form"), async (e) => {
  const label = document.getElementById("countdown-edit-label").value.trim();
  const targetDate = document.getElementById("countdown-edit-date").value;
  if (!label || !targetDate) return;
  await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ countdown_label: label, countdown_target_date: targetDate }),
  });
  document.getElementById("countdown-edit-form").classList.add("hidden");
  loadCountdown();
});

async function loadGoals() {
  const goals = await api("/api/goals");
  const list = document.getElementById("goal-list");
  list.innerHTML = "";
  goals.forEach((g) => {
    const li = document.createElement("li");
    if (g.done) li.classList.add("done");
    li.innerHTML = `
      <input type="checkbox" ${g.done ? "checked" : ""}>
      <span>${escapeHtml(g.title)}</span>
      <button class="delete-btn" title="Delete">×</button>
    `;
    li.querySelector("input").addEventListener("click", async () => {
      await api(`/api/goals/${g.id}/toggle`, { method: "POST" });
      loadGoals();
    });
    li.querySelector(".delete-btn").addEventListener("click", async () => {
      await api(`/api/goals/${g.id}`, { method: "DELETE" });
      loadGoals();
    });
    list.appendChild(li);
  });
  const doneCount = goals.filter((g) => g.done).length;
  const pct = goals.length ? Math.round((doneCount / goals.length) * 100) : 0;
  document.getElementById("goal-progress").textContent =
    goals.length ? `Achieved: ${doneCount}/${goals.length} (${pct}%)` : "";
}

guardedSubmit(document.getElementById("goal-form"), async (e) => {
  const title = document.getElementById("goal-title").value.trim();
  if (!title) return;
  await api("/api/goals", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  document.getElementById("goal-title").value = "";
  loadGoals();
});

// ---------- activation logs ----------

let activationActiveLog = null;
let activationTickInterval = null;

function updateActivationBanner() {
  const banner = document.getElementById("activation-banner");
  const label = document.getElementById("activation-banner-label");
  if (!activationActiveLog) {
    banner.classList.add("hidden");
    return;
  }
  const triggered = new Date(activationActiveLog.triggered_at.replace(" ", "T"));
  const elapsedMin = Math.max(0, Math.floor((Date.now() - triggered.getTime()) / 60000));
  label.innerHTML = `${ICONS.alert} Active · elapsed ${formatLogDuration(elapsedMin)}`;
  banner.classList.remove("hidden");
}

async function loadActivationActive() {
  activationActiveLog = await api("/api/activation-logs/active");
  const btn = document.getElementById("activation-btn");
  const statusEl = document.getElementById("activation-current-status");
  const settingsStatusEl = document.getElementById("settings-activation-status");
  const settingsReturnBtn = document.getElementById("settings-activation-return-btn");
  if (activationActiveLog) {
    btn.classList.add("active");
    btn.title = "Tap to log return";
    const noteText = activationActiveLog.note ? ` ${activationActiveLog.note}` : "";
    const label = `Active: ${formatLoggedAt(activationActiveLog.triggered_at)}〜${noteText}`;
    statusEl.textContent = label;
    settingsStatusEl.textContent = label;
    settingsReturnBtn.classList.remove("hidden");
    if (!activationTickInterval) {
      activationTickInterval = setInterval(updateActivationBanner, 30000);
    }
  } else {
    btn.classList.remove("active");
    btn.title = "";
    statusEl.textContent = "";
    settingsStatusEl.textContent = "Not currently active";
    settingsReturnBtn.classList.add("hidden");
    if (activationTickInterval) {
      clearInterval(activationTickInterval);
      activationTickInterval = null;
    }
  }
  updateActivationBanner();
}

async function returnActivation() {
  if (!activationActiveLog) return;
  await api(`/api/activation-logs/${activationActiveLog.id}/return`, {
    method: "PUT",
    body: JSON.stringify({ returned_at: nowLocalTimestamp() }),
  });
  refreshActivation();
}

async function loadActivationStats() {
  const s = await api("/api/activation-logs/stats");
  document.getElementById("activation-stat-week").textContent = `${s.week_count}`;
  document.getElementById("activation-stat-month").textContent = `${s.month_count}`;
  document.getElementById("activation-stat-total").textContent = `${s.total_count}`;
}

async function loadActivationPostReturnStats() {
  const s = await api("/api/activation-logs/post-return-stats?days=30");
  const el = document.getElementById("activation-post-return-stats");
  if (!el) return;
  el.textContent =
    s.count > 0
      ? `Study after return (last 30 days): avg ${s.avg_minutes} min (${s.count})`
      : "Study after return (last 30 days): no data";
}

async function loadActivationMoodReasons() {
  const rows = await api("/api/activation-logs/mood-reasons?days=30");
  const list = document.getElementById("activation-mood-reasons");
  list.innerHTML = "";
  if (rows.length === 0) {
    list.classList.add("hidden");
    return;
  }
  list.classList.remove("hidden");
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = `${r.mood_reason} ${r.count}`;
    list.appendChild(li);
  });
}

async function loadStudyTriggerStats() {
  const rows = await api("/api/study-logs/trigger-stats?days=30");
  const list = document.getElementById("study-trigger-stats");
  list.innerHTML = "";
  if (rows.length === 0) {
    list.classList.add("hidden");
    return;
  }
  list.classList.remove("hidden");
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = `${r.start_trigger} ${r.count}`;
    list.appendChild(li);
  });
}

async function loadActivationList() {
  const logs = await api("/api/activation-logs?limit=30");
  const list = document.getElementById("activation-list");
  list.innerHTML = "";
  updateActivationListHeader(logs.length);
  if (logs.length === 0) {
    list.innerHTML = "<li>No records</li>";
    return;
  }
  logs.forEach((l) => {
    const li = document.createElement("li");
    const returnedPart = l.returned_at ? `→ ${formatLoggedAt(l.returned_at)}` : "In progress";
    const noteMark = l.note ? `<span class="meta">${escapeHtml(l.note)}</span>` : "";
    let postReturnMark = "";
    if (l.returned_at) {
      const label =
        l.post_return_minutes > 0 ? `${l.post_return_minutes} min studied after return` : "No study logged";
      postReturnMark = `<span class="meta">${label}</span>`;
    }
    li.innerHTML = `
      <span class="log-info">
        <span>${formatLoggedAt(l.triggered_at)} ${returnedPart}</span>
        ${noteMark}
        ${postReturnMark}
      </span>
      <button class="delete-btn" title="Delete">×</button>
    `;
    li.querySelector(".delete-btn").addEventListener("click", async () => {
      await api(`/api/activation-logs/${l.id}`, { method: "DELETE" });
      loadActivationList();
      loadActivationActive();
      loadActivationStats();
      loadActivationPostReturnStats();
      loadActivationMoodReasons();
      loadCalendar();
    });
    list.appendChild(li);
  });
}

function refreshActivation() {
  loadActivationActive();
  loadActivationList();
  loadActivationStats();
  loadActivationPostReturnStats();
  loadActivationMoodReasons();
  loadCalendar();
}

const activationPanel = document.getElementById("activation-panel");
const activationBackdrop = document.getElementById("activation-backdrop");
let activationSelectedMood = null;
let activationSelectedReason = null;

document.querySelectorAll("#activation-mood-picker .mood-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const isSame = activationSelectedMood === btn.dataset.mood;
    activationSelectedMood = isSame ? null : btn.dataset.mood;
    document.querySelectorAll("#activation-mood-picker .mood-btn").forEach((b) => {
      b.classList.toggle("active", b === btn && !isSame);
    });
    const reasonPicker = document.getElementById("activation-reason-picker");
    reasonPicker.classList.toggle("hidden", activationSelectedMood !== "heavy");
    if (activationSelectedMood !== "heavy") {
      activationSelectedReason = null;
      document.querySelectorAll("#activation-reason-picker .reason-btn").forEach((b) => b.classList.remove("active"));
    }
  });
});

document.querySelectorAll("#activation-reason-picker .reason-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const isSame = activationSelectedReason === btn.dataset.reason;
    activationSelectedReason = isSame ? null : btn.dataset.reason;
    document.querySelectorAll("#activation-reason-picker .reason-btn").forEach((b) => {
      b.classList.toggle("active", b === btn && !isSame);
    });
  });
});

function openActivationPanel() {
  activationPanel.classList.remove("hidden");
  activationBackdrop.classList.remove("hidden");
  document.getElementById("activation-time-preview").textContent = `Time: ${nowHHMM()}`;
  document.getElementById("activation-note").value = "";
  activationSelectedMood = null;
  activationSelectedReason = null;
  document.querySelectorAll("#activation-mood-picker .mood-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll("#activation-reason-picker .reason-btn").forEach((b) => b.classList.remove("active"));
  document.getElementById("activation-reason-picker").classList.add("hidden");
  document.getElementById("activation-note").focus();
}

function closeActivationPanel() {
  activationPanel.classList.add("hidden");
  activationBackdrop.classList.add("hidden");
}

document.getElementById("activation-close").addEventListener("click", closeActivationPanel);
activationBackdrop.addEventListener("click", closeActivationPanel);

guardedClick(document.getElementById("activation-btn"), async () => {
  if (activationActiveLog) {
    await returnActivation();
  } else {
    openActivationPanel();
  }
});

guardedClick(document.getElementById("settings-activation-return-btn"), returnActivation);
document.getElementById("activation-banner").addEventListener("click", openSettingsPanel);

guardedSubmit(document.getElementById("activation-form"), async (e) => {
  const note = document.getElementById("activation-note").value.trim() || null;
  await api("/api/activation-logs", {
    method: "POST",
    body: JSON.stringify({
      triggered_at: nowLocalTimestamp(),
      note,
      mood: activationSelectedMood,
      mood_reason: activationSelectedReason,
    }),
  });
  closeActivationPanel();
  refreshActivation();
});

document.getElementById("activation-export-btn").addEventListener("click", async () => {
  const since = `${addDaysToDate(todayStr(), -6)} 00:00:00`;
  const { text, count } = await api(`/api/activation-logs/export?since=${encodeURIComponent(since)}`);
  const textarea = document.getElementById("activation-export-text");
  textarea.value = count ? text : "No records in the last 7 days";
  textarea.classList.remove("hidden");
  document.getElementById("activation-copy-btn").classList.toggle("hidden", count === 0);
});

document.getElementById("activation-copy-btn").addEventListener("click", async () => {
  const textarea = document.getElementById("activation-export-text");
  const copyBtn = document.getElementById("activation-copy-btn");
  try {
    await navigator.clipboard.writeText(textarea.value);
    copyBtn.textContent = "Copied";
  } catch {
    textarea.select();
    copyBtn.textContent = "Please copy manually";
  }
  setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
});

// ---------- sleep logs ----------

let sleepActiveLog = null;
let sleepTickInterval = null;

// サボりモード(発動ログ)のバナー・アイコン点滅と同じ「今この状態だとひと目でわかる」表現を、
// 睡眠モードにも用意する。ただし睡眠は焦らせる状態ではないので、色はdangerではなくaccent、
// 点滅もゆっくりめ(呼吸のように)にして、サボりモードとトーンを分ける。
function updateSleepBanner() {
  const banner = document.getElementById("sleep-banner");
  const label = document.getElementById("sleep-banner-label");
  if (!sleepActiveLog) {
    banner.classList.add("hidden");
    return;
  }
  const bedtime = new Date(sleepActiveLog.bedtime_at.replace(" ", "T"));
  const elapsedMin = Math.max(0, Math.floor((Date.now() - bedtime.getTime()) / 60000));
  label.innerHTML = `${ICONS.moon} Sleeping · elapsed ${formatLogDuration(elapsedMin)}`;
  banner.classList.remove("hidden");
}

function toDatetimeLocalValue(s) {
  return s ? s.replace(" ", "T").slice(0, 16) : "";
}

function fromDatetimeLocalValue(v) {
  return v ? `${v.replace("T", " ")}:00` : null;
}

function sleepDurationMinutes(bedtimeAt, wakeAt) {
  if (!wakeAt) return null;
  const bed = new Date(bedtimeAt.replace(" ", "T"));
  const wake = new Date(wakeAt.replace(" ", "T"));
  return Math.round((wake.getTime() - bed.getTime()) / 60000);
}

async function loadSleepActive() {
  sleepActiveLog = await api("/api/sleep-logs/active");
  const btn = document.getElementById("sleep-btn");
  const settingsStatusEl = document.getElementById("settings-sleep-status");
  const settingsWakeBtn = document.getElementById("settings-sleep-wake-btn");
  if (sleepActiveLog) {
    btn.classList.add("active");
    btn.title = "Tap to log wake-up";
    settingsStatusEl.textContent = `Sleeping since: ${formatLoggedAt(sleepActiveLog.bedtime_at)}〜`;
    settingsWakeBtn.classList.remove("hidden");
    if (!sleepTickInterval) {
      sleepTickInterval = setInterval(updateSleepBanner, 30000);
    }
  } else {
    btn.classList.remove("active");
    btn.title = "";
    settingsStatusEl.textContent = "Not currently sleeping";
    settingsWakeBtn.classList.add("hidden");
    if (sleepTickInterval) {
      clearInterval(sleepTickInterval);
      sleepTickInterval = null;
    }
  }
  updateSleepBanner();
}

document.getElementById("sleep-banner").addEventListener("click", openSettingsPanel);

async function wakeUp() {
  if (!sleepActiveLog) return;
  await api(`/api/sleep-logs/${sleepActiveLog.id}`, {
    method: "PUT",
    body: JSON.stringify({ wake_at: nowLocalTimestamp() }),
  });
  loadSleepActive();
  loadSleepPanel();
}

async function loadSleepPanel() {
  const [logs, stats] = await Promise.all([
    api("/api/sleep-logs?limit=30"),
    api("/api/sleep-logs/stats?days=30"),
  ]);
  renderSleepStats(logs, stats);
  renderSleepLogList(logs);
}

function renderSleepStats(logs, stats) {
  const lastNightEl = document.getElementById("sleep-stat-last-night");
  const avgEl = document.getElementById("sleep-stat-avg");
  const lastCompleted = logs.find((l) => l.wake_at);
  lastNightEl.textContent = lastCompleted
    ? formatLogDuration(sleepDurationMinutes(lastCompleted.bedtime_at, lastCompleted.wake_at))
    : "-";
  avgEl.textContent = stats.count > 0 ? `${formatLogDuration(Math.round(stats.avg_minutes))} (${stats.count})` : "No data";
}

function renderSleepLogList(logs) {
  const list = document.getElementById("sleep-log-list");
  list.innerHTML = "";
  updateSleepLogHeader(logs.length);
  if (logs.length === 0) {
    list.innerHTML = "<li>No records</li>";
    return;
  }
  logs.forEach((l) => {
    const li = document.createElement("li");
    const minutes = sleepDurationMinutes(l.bedtime_at, l.wake_at);
    const durationLabel = minutes != null ? ` (${formatLogDuration(minutes)})` : " (sleeping)";
    li.innerHTML = `
      <span class="log-info">
        <span>${formatLoggedAt(l.bedtime_at)} → ${l.wake_at ? formatLoggedAt(l.wake_at) : "..."}${durationLabel}</span>
      </span>
      <button class="edit-btn icon-btn" title="Edit">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
        </svg>
      </button>
      <button class="delete-btn" title="Delete">×</button>
      <div class="sleep-edit-row hidden">
        <input type="datetime-local" class="sleep-edit-bedtime" value="${toDatetimeLocalValue(l.bedtime_at)}">
        <input type="datetime-local" class="sleep-edit-wake" value="${toDatetimeLocalValue(l.wake_at)}">
        <button type="button" class="quick-date-btn sleep-edit-save">Save</button>
      </div>
    `;
    li.querySelector(".edit-btn").addEventListener("click", () => {
      li.querySelector(".sleep-edit-row").classList.toggle("hidden");
    });
    li.querySelector(".sleep-edit-save").addEventListener("click", async () => {
      const bedtimeVal = li.querySelector(".sleep-edit-bedtime").value;
      const wakeVal = li.querySelector(".sleep-edit-wake").value;
      await api(`/api/sleep-logs/${l.id}`, {
        method: "PUT",
        body: JSON.stringify({
          bedtime_at: fromDatetimeLocalValue(bedtimeVal),
          wake_at: fromDatetimeLocalValue(wakeVal),
        }),
      });
      loadSleepActive();
      loadSleepPanel();
    });
    li.querySelector(".delete-btn").addEventListener("click", async () => {
      await api(`/api/sleep-logs/${l.id}`, { method: "DELETE" });
      loadSleepActive();
      loadSleepPanel();
    });
    list.appendChild(li);
  });
}

const bedtimePanel = document.getElementById("bedtime-panel");
const bedtimeBackdrop = document.getElementById("bedtime-backdrop");

function closeBedtimePanel() {
  bedtimePanel.classList.add("hidden");
  bedtimeBackdrop.classList.add("hidden");
}

document.getElementById("bedtime-close").addEventListener("click", closeBedtimePanel);
bedtimeBackdrop.addEventListener("click", closeBedtimePanel);

function toggleBedtimeCarryoverEmpty() {
  const list = document.getElementById("bedtime-carryover-list");
  document.getElementById("bedtime-carryover-empty").classList.toggle("hidden", list.children.length > 0);
}

async function renderBedtimeCarryoverList() {
  const todos = await api("/api/todos");
  const today = todayStr();
  const carryover = todos.filter((t) => !t.done && t.due_date === today);
  const list = document.getElementById("bedtime-carryover-list");
  list.innerHTML = "";
  carryover.forEach((t) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="log-info"><span>${escapeHtml(t.title)}</span></span>
      <div class="bedtime-actions">
        <button type="button" class="reschedule-btn" data-action="tomorrow">To tomorrow</button>
        <button type="button" class="reschedule-btn" data-action="keep">Keep as is</button>
        <button type="button" class="reschedule-btn danger-text" data-action="delete">Delete</button>
      </div>
    `;
    li.querySelector('[data-action="tomorrow"]').addEventListener("click", async () => {
      await api(`/api/todos/${t.id}/due`, {
        method: "PUT",
        body: JSON.stringify({ due_date: addDaysToDate(t.due_date, 1), due_time: t.due_time || null }),
      });
      li.remove();
      loadTodos();
      loadCalendar();
      toggleBedtimeCarryoverEmpty();
    });
    li.querySelector('[data-action="keep"]').addEventListener("click", () => {
      li.remove();
      toggleBedtimeCarryoverEmpty();
    });
    li.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      await api(`/api/todos/${t.id}`, { method: "DELETE" });
      li.remove();
      loadTodos();
      toggleBedtimeCarryoverEmpty();
    });
    list.appendChild(li);
  });
  toggleBedtimeCarryoverEmpty();
}

async function openBedtimePanel() {
  bedtimePanel.classList.remove("hidden");
  bedtimeBackdrop.classList.remove("hidden");
  document.getElementById("bedtime-step1").classList.remove("hidden");
  document.getElementById("bedtime-step2").classList.add("hidden");
  document.getElementById("bedtime-add-title").value = "";
  document.getElementById("bedtime-added-list").innerHTML = "";
  await renderBedtimeCarryoverList();
}

document.getElementById("bedtime-step1-next").addEventListener("click", () => {
  document.getElementById("bedtime-step1").classList.add("hidden");
  document.getElementById("bedtime-step2").classList.remove("hidden");
});

guardedSubmit(document.getElementById("bedtime-add-form"), async (e) => {
  const titleInput = document.getElementById("bedtime-add-title");
  const title = titleInput.value.trim();
  if (!title) return;
  await api("/api/todos", {
    method: "POST",
    body: JSON.stringify({ title, due_date: addDaysToDate(todayStr(), 1) }),
  });
  titleInput.value = "";
  const li = document.createElement("li");
  li.innerHTML = `<span class="log-info"><span>${escapeHtml(title)}</span></span>`;
  document.getElementById("bedtime-added-list").appendChild(li);
  loadTodos();
  loadCalendar();
});

document.getElementById("bedtime-step2-done").addEventListener("click", closeBedtimePanel);

guardedClick(document.getElementById("sleep-btn"), async () => {
  if (sleepActiveLog) {
    await wakeUp();
  } else {
    await api("/api/sleep-logs", {
      method: "POST",
      body: JSON.stringify({ bedtime_at: nowLocalTimestamp() }),
    });
    await loadSleepActive();
    loadSleepPanel();
    openBedtimePanel();
  }
});

guardedClick(document.getElementById("settings-sleep-wake-btn"), wakeUp);

// ---------- calendar (events) ----------

function populateEventCategorySelect(cats) {
  ["event-category", "event-detail-category"].forEach((id) => {
    const select = document.getElementById(id);
    const previous = select.value;
    select.innerHTML =
      `<option value="">Category: None</option>` +
      cats.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
    if (cats.some((c) => c.name === previous)) select.value = previous;
  });
}

let calYear, calMonth; // calMonth is 1-based
let calViewMode = "month"; // "month" | "week"
let calWeekStart = null; // ISO date (Monday), used when calViewMode === "week"
// カレンダーを開いた瞬間に「今日の予定」が見えるよう、常に今日をデフォルト選択にしておく。
let selectedCalDate = todayStr();
let calEventsCache = [];
let calTodosCache = [];
let calStudyDaysCache = new Set();
let calActivationDaysCache = new Set();
let calMinAchievedDaysCache = new Set();
// 上記キャッシュが現時点でどの月("YYYY-M")のデータを含んでいるかの記録。月⇔週の切り替えのたびに
// 同じ月を再フェッチしていた無駄をなくすため(2026-08-16)。
let calCachedMonthKeys = new Set();
const CAL_HOUR_HEIGHT = 52; // px per hour in the week time grid

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoDate(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate(); // m (1-based) as monthIndex gives last day of month m
}

function addDaysToDate(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return formatLocalDate(d);
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  return addDaysToDate(dateStr, -dow);
}

const CAL_WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CAL_MONTH_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatCalDetailTitle(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const label = `${CAL_MONTH_EN[d.getMonth()]} ${d.getDate()} (${CAL_WEEKDAY_EN[d.getDay()]})`;
  return dateStr === todayStr() ? `${label} · Today` : label;
}

// 予定タブは起動時にアクティブでないため後回しにされがちで、実際に開いたときに
// 空のグリッドがしばらく表示されてから埋まる、という遅さの原因になっていた。
// 月表示(起動直後の既定値)に限って、ToDoタブと同じくキャッシュから先に描画しておく。
async function hydrateCalendarFromCache() {
  if (calViewMode === "week") return false;
  const [events, todos, studyDays, activationDays, minAchievedDays] = await Promise.all([
    cacheGet(`/api/events?year=${calYear}&month=${calMonth}`),
    cacheGet("/api/todos"),
    cacheGet(`/api/study-logs/days?year=${calYear}&month=${calMonth}`),
    cacheGet(`/api/activation-logs/days?year=${calYear}&month=${calMonth}`),
    cacheGet(`/api/study-logs/minimum-achieved-days?year=${calYear}&month=${calMonth}`),
  ]);
  if (!events && !todos) return false;
  try {
    document.getElementById("cal-month-label").textContent = `${CAL_MONTH_EN[calMonth - 1]} ${calYear}`;
    calEventsCache = events || [];
    calTodosCache = (todos || []).filter((t) => t.due_date);
    calStudyDaysCache = new Set(studyDays || []);
    calActivationDaysCache = new Set(activationDays || []);
    calMinAchievedDaysCache = new Set(minAchievedDays || []);
    document.getElementById("cal-weekday-row").classList.remove("hidden");
    document.getElementById("cal-grid").classList.remove("hidden");
    document.getElementById("cal-week-view").classList.add("hidden");
    renderCalGrid();
    renderCalDayDetail();
    return true;
  } catch (err) {
    console.error("hydrate calendar failed:", err);
    return false;
  }
}

// calViewMode/calYear/calMonth/calWeekStartが指す期間を表示するために必要な月キー("YYYY-M")の集合。
// 週表示は月をまたぐと2つになる。
function neededCalMonthKeys() {
  if (calViewMode === "week") {
    const weekEnd = addDaysToDate(calWeekStart, 6);
    const startD = new Date(calWeekStart + "T00:00:00");
    const endD = new Date(weekEnd + "T00:00:00");
    return new Set([
      `${startD.getFullYear()}-${startD.getMonth() + 1}`,
      `${endD.getFullYear()}-${endD.getMonth() + 1}`,
    ]);
  }
  return new Set([`${calYear}-${calMonth}`]);
}

function updateCalMonthLabel() {
  if (calViewMode === "week") {
    const weekEnd = addDaysToDate(calWeekStart, 6);
    const startD = new Date(calWeekStart + "T00:00:00");
    const endD = new Date(weekEnd + "T00:00:00");
    document.getElementById("cal-month-label").textContent =
      startD.getMonth() === endD.getMonth()
        ? `${CAL_MONTH_EN[startD.getMonth()]} ${startD.getDate()}〜${endD.getDate()}, ${startD.getFullYear()}`
        : `${CAL_MONTH_EN[startD.getMonth()]} ${startD.getDate()} 〜 ${CAL_MONTH_EN[endD.getMonth()]} ${endD.getDate()}, ${startD.getFullYear()}`;
  } else {
    document.getElementById("cal-month-label").textContent = `${CAL_MONTH_EN[calMonth - 1]} ${calYear}`;
  }
}

// グリッド/週タイムグリッドの描画+表示切り替えだけを行う(データ取得はしない)。
// 既にcalXxxCacheが必要な月をカバーしている場合はloadCalendar()を経由せずこれだけ呼べばいい。
function renderCalendarView() {
  const isWeek = calViewMode === "week";
  document.getElementById("cal-weekday-row").classList.toggle("hidden", isWeek);
  document.getElementById("cal-grid").classList.toggle("hidden", isWeek);
  document.getElementById("cal-week-view").classList.toggle("hidden", !isWeek);

  if (isWeek) {
    renderWeekTimeGrid();
  } else {
    renderCalGrid();
  }
  renderCalDayDetail();
}

async function loadCalendar() {
  const monthKeys = neededCalMonthKeys();
  updateCalMonthLabel();
  if (calViewMode === "week") {
    const [eventLists, todos, studyDayLists, activationDayLists, minAchievedDayLists] = await Promise.all([
      Promise.all(
        [...monthKeys].map((key) => {
          const [y, m] = key.split("-").map(Number);
          return api(`/api/events?year=${y}&month=${m}`);
        })
      ),
      api("/api/todos"),
      Promise.all(
        [...monthKeys].map((key) => {
          const [y, m] = key.split("-").map(Number);
          return api(`/api/study-logs/days?year=${y}&month=${m}`);
        })
      ),
      Promise.all(
        [...monthKeys].map((key) => {
          const [y, m] = key.split("-").map(Number);
          return api(`/api/activation-logs/days?year=${y}&month=${m}`);
        })
      ),
      Promise.all(
        [...monthKeys].map((key) => {
          const [y, m] = key.split("-").map(Number);
          return api(`/api/study-logs/minimum-achieved-days?year=${y}&month=${m}`);
        })
      ),
    ]);
    calEventsCache = eventLists.flat();
    calTodosCache = todos.filter((t) => t.due_date);
    calStudyDaysCache = new Set(studyDayLists.flat());
    calActivationDaysCache = new Set(activationDayLists.flat());
    calMinAchievedDaysCache = new Set(minAchievedDayLists.flat());
  } else {
    const [events, todos, studyDays, activationDays, minAchievedDays] = await Promise.all([
      api(`/api/events?year=${calYear}&month=${calMonth}`),
      api("/api/todos"),
      api(`/api/study-logs/days?year=${calYear}&month=${calMonth}`),
      api(`/api/activation-logs/days?year=${calYear}&month=${calMonth}`),
      api(`/api/study-logs/minimum-achieved-days?year=${calYear}&month=${calMonth}`),
    ]);
    calEventsCache = events;
    calTodosCache = todos.filter((t) => t.due_date);
    calStudyDaysCache = new Set(studyDays);
    calActivationDaysCache = new Set(activationDays);
    calMinAchievedDaysCache = new Set(minAchievedDays);
  }

  calCachedMonthKeys = monthKeys;
  renderCalendarView();
}

// セル幅に余裕のあるPC(md+)では、1件+「+N件」に丸めず何件かそのまま表示できる。
// styleのbreakpoint(768px)と合わせておく。
const CAL_EVENT_MEDIA_QUERY = window.matchMedia("(min-width: 768px)");
function calEventDisplayCap() {
  return CAL_EVENT_MEDIA_QUERY.matches ? 3 : 1;
}
// ウィンドウ幅がbreakpointをまたいだ場合に再描画(タブレット回転・ウィンドウリサイズ対応)
CAL_EVENT_MEDIA_QUERY.addEventListener("change", () => {
  if (document.getElementById("tab-calendar").classList.contains("active")) renderCalGrid();
});

// PC(md+)では月グリッド(5〜6週分)がビューポートより縦に長くなり、下端を見るのに
// スクロールが必要になる問題への対応(2026-08-29)。header/バナー等の高さは可変で
// 固定値を引き算できないため、実際にグリッドが始まる位置を都度測ってビューポート内に
// 収まる高さを算出し、.cal-gridに直接セットする(CSS側はgrid-auto-rows:1frで行に均等分配)。
function updateCalGridHeight() {
  const grid = document.getElementById("cal-grid");
  if (!grid) return;
  if (!CAL_EVENT_MEDIA_QUERY.matches) {
    grid.style.height = ""; // モバイルは従来通りaspect-ratio任せ(この関数は何もしない)
    return;
  }
  const top = grid.getBoundingClientRect().top;
  if (top <= 0) return; // タブが非表示(display:none)でまだ測れない場合はスキップ
  // 40pxは.cal-boardの下padding(10px)+margin(18px)+少し余裕、を差し引いてぴったり収める
  const available = window.innerHeight - top - 40;
  grid.style.height = `${Math.max(available, 420)}px`;
}

window.addEventListener("resize", () => {
  if (document.getElementById("tab-calendar").classList.contains("active")) updateCalGridHeight();
});

function renderCalGrid() {
  const grid = document.getElementById("cal-grid");
  const firstOfMonth = new Date(calYear, calMonth - 1, 1);
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // 0 = Monday
  const totalDays = daysInMonth(calYear, calMonth);
  const prevMonthDays = daysInMonth(calMonth === 1 ? calYear - 1 : calYear, calMonth === 1 ? 12 : calMonth - 1);

  const cells = [];
  for (let i = firstWeekday - 1; i >= 0; i--) {
    cells.push({ day: prevMonthDays - i, otherMonth: true, date: null });
  }
  for (let d = 1; d <= totalDays; d++) {
    cells.push({ day: d, otherMonth: false, date: isoDate(calYear, calMonth, d) });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ day: nextDay++, otherMonth: true, date: null });
  }

  const today = todayStr();

  grid.innerHTML = cells
    .map((c, i) => {
      if (c.otherMonth) {
        return `<div class="cal-day other-month"><span class="cal-day-num">${c.day}</span></div>`;
      }
      const dayEvents = calEventsCache.filter((e) => e.occurrence_date === c.date);
      const dayTodos = calTodosCache.filter((t) => t.due_date === c.date);
      // 予定(events)は「何日に何があるか」がドットだと分からないという指摘を受け、
      // 名前をそのまま短縮テキストで表示する。ToDoの期限は件数が多く/カレンダー上では
      // ToDo画面ほど重要でないため、従来通りドットのまま(2026-08-16)。
      // セル幅に余裕のあるPC(md+)では1件+「+N件」に丸めず最大3件まで表示する(2026-08-29)。
      const eventCap = calEventDisplayCap();
      let eventMark = "";
      if (dayEvents.length > 0) {
        const shown = dayEvents.slice(0, eventCap);
        const restCount = dayEvents.length - shown.length;
        eventMark = `<div class="cal-events">${shown
          .map(
            (e) =>
              `<span class="cal-event-label" style="color:${colorFor(e.category || "")}">${escapeHtml(e.title)}</span>`,
          )
          .join("")}${restCount > 0 ? `<span class="cal-event-more">+${restCount} more</span>` : ""}</div>`;
      }
      const todoMark = dayTodos.length ? `<span class="cal-todo-dot"></span>` : "";
      const studyMark = calStudyDaysCache.has(c.date) ? `<span class="cal-log-dot"></span>` : "";
      const activationMark = calActivationDaysCache.has(c.date) ? `<span class="cal-activation-dot"></span>` : "";
      const minAchievedMark = calMinAchievedDaysCache.has(c.date) ? `<span class="cal-min-mark">${ICONS.check}</span>` : "";
      const classes = ["cal-day"];
      const weekdayCol = i % 7;
      if (weekdayCol === 5) classes.push("sat");
      if (weekdayCol === 6) classes.push("sun");
      if (c.date === today) classes.push("today");
      if (c.date === selectedCalDate) classes.push("selected");
      return `
        <div class="${classes.join(" ")}" data-date="${c.date}">
          <span class="cal-day-num">${c.day}</span>
          ${eventMark}
          <div class="cal-day-marks">${todoMark}${studyMark}${activationMark}${minAchievedMark}</div>
        </div>
      `;
    })
    .join("");

  grid.querySelectorAll(".cal-day[data-date]").forEach((el) => {
    el.addEventListener("click", () => {
      selectedCalDate = el.dataset.date;
      renderCalGrid();
      renderCalDayDetail();
    });
  });

  updateCalGridHeight();
}

function layoutDayEvents(events) {
  const sorted = [...events].sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
  const cols = []; // end time (minutes) of the last event placed in each column
  const placed = sorted.map((e) => {
    const start = timeToMinutes(e.start_time);
    const end = Math.max(timeToMinutes(e.end_time), start + 15);
    let col = cols.findIndex((endMin) => endMin <= start);
    if (col === -1) {
      col = cols.length;
      cols.push(end);
    } else {
      cols[col] = end;
    }
    return { ev: e, start, end, col };
  });
  const totalCols = cols.length || 1;
  return placed.map((p) => ({ ...p, totalCols }));
}

function renderWeekTimeGrid() {
  const header = document.getElementById("cal-week-header");
  const axis = document.getElementById("cal-time-axis");
  const columns = document.getElementById("cal-week-columns");
  const body = document.getElementById("cal-week-body");

  body.style.setProperty("--cal-hour-height", `${CAL_HOUR_HEIGHT}px`);
  const totalHeight = 24 * CAL_HOUR_HEIGHT;
  axis.style.height = `${totalHeight}px`;
  columns.style.height = `${totalHeight}px`;

  const today = todayStr();
  const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days = Array.from({ length: 7 }, (_, i) => addDaysToDate(calWeekStart, i));

  header.innerHTML =
    `<div class="cal-week-header-spacer"></div>` +
    days
      .map((d, i) => {
        const classes = ["cal-week-daycol"];
        if (i === 5) classes.push("sat");
        if (i === 6) classes.push("sun");
        if (d === today) classes.push("today");
        if (d === selectedCalDate) classes.push("selected");
        return `
          <div class="${classes.join(" ")}" data-date="${d}">
            <span class="cal-week-day-name">${weekdayNames[i]}</span>
            <span class="cal-week-day-num">${Number(d.slice(8, 10))}</span>
          </div>
        `;
      })
      .join("");

  header.querySelectorAll(".cal-week-daycol").forEach((el) => {
    el.addEventListener("click", () => {
      selectedCalDate = el.dataset.date;
      renderWeekTimeGrid();
      renderCalDayDetail();
    });
  });

  axis.innerHTML = Array.from({ length: 24 }, (_, h) => `<span class="cal-time-slot" style="top:${h * CAL_HOUR_HEIGHT}px">${pad2(h)}:00</span>`).join("");

  columns.innerHTML = days
    .map((d, i) => {
      const classes = ["cal-week-col"];
      if (d === today) classes.push("today");
      const dayEvents = calEventsCache.filter((e) => e.occurrence_date === d);
      const blocks = layoutDayEvents(dayEvents)
        .map(({ ev, start, end, col, totalCols }) => {
          const top = (start / 60) * CAL_HOUR_HEIGHT;
          const height = Math.max(((end - start) / 60) * CAL_HOUR_HEIGHT - 2, 16);
          const width = 100 / totalCols;
          const left = col * width;
          const color = colorFor(ev.category || "");
          return `
            <div class="cal-event-block" data-id="${ev.id}"
                 style="top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);background:${color}3d;border-left-color:${color}">
              <span class="cal-event-block-title">${escapeHtml(ev.title)}</span>
              <span class="cal-event-block-time">${ev.start_time}〜${ev.end_time}</span>
            </div>
          `;
        })
        .join("");
      return `<div class="${classes.join(" ")}" data-date="${d}">${blocks}</div>`;
    })
    .join("");

  columns.querySelectorAll(".cal-event-block").forEach((el) => {
    el.addEventListener("click", () => {
      const ev = calEventsCache.find((e) => String(e.id) === el.dataset.id);
      if (ev) openEventDetail(ev);
    });
  });

  const existingNowLine = columns.querySelector(".cal-now-line");
  if (existingNowLine) existingNowLine.remove();
  if (days.includes(today)) {
    const now = new Date();
    const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * CAL_HOUR_HEIGHT;
    const nowLine = document.createElement("div");
    nowLine.className = "cal-now-line";
    nowLine.style.top = `${nowTop}px`;
    columns.appendChild(nowLine);
  }

  const scrollBox = document.getElementById("cal-week-scroll");
  let scrollToMinutes;
  if (days.includes(today)) {
    scrollToMinutes = new Date().getHours() * 60;
  } else if (calEventsCache.length) {
    const earliest = Math.min(...calEventsCache.map((e) => timeToMinutes(e.start_time)));
    scrollToMinutes = earliest;
  } else {
    scrollToMinutes = 8 * 60;
  }
  scrollBox.scrollTop = Math.max((scrollToMinutes / 60) * CAL_HOUR_HEIGHT - 80, 0);
}

function renderCalDayDetail() {
  const title = document.getElementById("cal-detail-title");
  const eventList = document.getElementById("cal-event-list");
  const todoList = document.getElementById("cal-todo-list");
  if (!selectedCalDate) {
    title.textContent = "Select a date";
    eventList.innerHTML = "";
    todoList.innerHTML = "";
    return;
  }
  title.textContent = formatCalDetailTitle(selectedCalDate);

  const dayEvents = calEventsCache
    .filter((e) => e.occurrence_date === selectedCalDate)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  eventList.innerHTML = "";
  if (dayEvents.length === 0) {
    eventList.innerHTML = "<li>No events</li>";
  }
  dayEvents.forEach((ev) => {
    const li = document.createElement("li");
    const noteMark = ev.note ? ` ${ICONS.note}` : "";
    li.innerHTML = `
      <span class="log-icon" style="background:${colorFor(ev.category || "")}"></span>
      <span class="log-info">
        <span class="log-subject">${escapeHtml(ev.title)}${noteMark}</span>
        <span class="log-time">${ev.start_time}〜${ev.end_time}${ev.recurrence ? ` ${ICONS.repeat}` : ""}</span>
      </span>
      <button class="delete-btn" title="Delete">×</button>
    `;
    li.querySelector(".delete-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (ev.recurrence && !confirm("This is a recurring event. Delete the entire series?")) return;
      await api(`/api/events/${ev.id}`, { method: "DELETE" });
      loadCalendar();
    });
    li.classList.add("clickable");
    li.addEventListener("click", () => openEventDetail(ev));
    eventList.appendChild(li);
  });

  const dayTodos = calTodosCache.filter((t) => t.due_date === selectedCalDate);
  todoList.innerHTML = "";
  if (dayTodos.length === 0) {
    todoList.innerHTML = "<li>No tasks due</li>";
  }
  dayTodos.forEach((t) => {
    const li = document.createElement("li");
    if (t.done) li.classList.add("done");
    li.innerHTML = `
      <input type="checkbox" ${t.done ? "checked" : ""}>
      <span>${escapeHtml(t.title)}</span>
      <span class="meta">${t.due_time || ""}</span>
    `;
    li.querySelector("input").addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/todos/${t.id}/toggle`, { method: "POST" });
      loadTodos();
      loadTodoStats();
      loadCalendar();
    });
    li.classList.add("clickable");
    li.addEventListener("click", () => openTodoDetail(t));
    todoList.appendChild(li);
  });
}

// 月/週を移動した先に「今日」が含まれていればそれを選択、含まれなければ
// 表示範囲の先頭日を選択する(前後に移動しても詳細欄が空にならないように)。
function defaultCalSelection() {
  const today = todayStr();
  if (calViewMode === "week") {
    const weekEnd = addDaysToDate(calWeekStart, 6);
    return today >= calWeekStart && today <= weekEnd ? today : calWeekStart;
  }
  return today.startsWith(`${calYear}-${pad2(calMonth)}`) ? today : isoDate(calYear, calMonth, 1);
}

function calGoPrev() {
  if (calViewMode === "week") {
    calWeekStart = addDaysToDate(calWeekStart, -7);
  } else {
    calMonth -= 1;
    if (calMonth < 1) {
      calMonth = 12;
      calYear -= 1;
    }
  }
  selectedCalDate = defaultCalSelection();
  loadCalendar();
}

function calGoNext() {
  if (calViewMode === "week") {
    calWeekStart = addDaysToDate(calWeekStart, 7);
  } else {
    calMonth += 1;
    if (calMonth > 12) {
      calMonth = 1;
      calYear += 1;
    }
  }
  selectedCalDate = defaultCalSelection();
  loadCalendar();
}

document.getElementById("cal-prev").addEventListener("click", calGoPrev);
document.getElementById("cal-next").addEventListener("click", calGoNext);

// スワイプでの月/週送り
(() => {
  const board = document.querySelector(".cal-board");
  let touchStartX = 0;
  let touchStartY = 0;
  let swiping = false;

  board.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      swiping = true;
    },
    { passive: true }
  );

  board.addEventListener(
    "touchend",
    (e) => {
      if (!swiping) return;
      swiping = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;
      const SWIPE_THRESHOLD = 40;
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) {
        calGoNext();
      } else {
        calGoPrev();
      }
    },
    { passive: true }
  );
})();

document.querySelectorAll("#cal-view-toggle .cal-view-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.view;
    if (mode === calViewMode) return;
    calViewMode = mode;
    document.querySelectorAll("#cal-view-toggle .cal-view-btn").forEach((b) => b.classList.toggle("active", b === btn));
    if (calViewMode === "week") {
      calWeekStart = mondayOf(selectedCalDate || todayStr());
    } else {
      const anchor = new Date(calWeekStart + "T00:00:00");
      calYear = anchor.getFullYear();
      calMonth = anchor.getMonth() + 1;
    }
    // 月⇔週の切り替え先が既にキャッシュ済みの月なら、APIを叩き直さず描画だけやり直す
    // (切り替えるたびに毎回全件再取得していたのが「切り替えが遅い」の原因だった、2026-08-16)。
    const needed = neededCalMonthKeys();
    const alreadyCached = [...needed].every((k) => calCachedMonthKeys.has(k));
    updateCalMonthLabel();
    if (alreadyCached) {
      renderCalendarView();
    } else {
      loadCalendar();
    }
  });
});

// ---------- event add form ----------

const eventAddPanel = document.getElementById("event-add-panel");
const eventAddBackdrop = document.getElementById("event-add-backdrop");

function openEventAddPanel() {
  eventAddPanel.classList.remove("hidden");
  eventAddBackdrop.classList.remove("hidden");
  document.getElementById("event-date").value = selectedCalDate || todayStr();
  document.getElementById("event-title").focus();
}

function closeEventAddPanel() {
  eventAddPanel.classList.add("hidden");
  eventAddBackdrop.classList.add("hidden");
}

document.getElementById("event-fab").addEventListener("click", openEventAddPanel);
document.getElementById("event-add-close").addEventListener("click", closeEventAddPanel);
eventAddBackdrop.addEventListener("click", closeEventAddPanel);

const selectedEventRecurrenceDays = new Set();

function setEventRecurrenceDays(days) {
  selectedEventRecurrenceDays.clear();
  days.forEach((d) => selectedEventRecurrenceDays.add(d));
  document.querySelectorAll("#event-recurrence-picker .weekday-btn").forEach((btn) => {
    btn.classList.toggle("active", selectedEventRecurrenceDays.has(btn.dataset.day));
  });
}

document.querySelectorAll("#event-recurrence-picker .weekday-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const day = btn.dataset.day;
    if (selectedEventRecurrenceDays.has(day)) {
      selectedEventRecurrenceDays.delete(day);
    } else {
      selectedEventRecurrenceDays.add(day);
    }
    btn.classList.toggle("active", selectedEventRecurrenceDays.has(day));
  });
});

document.querySelectorAll("#event-form [data-recur-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.recurPreset;
    if (preset === "daily") setEventRecurrenceDays(WEEKDAY_ORDER);
    else if (preset === "weekdays") setEventRecurrenceDays(["mon", "tue", "wed", "thu", "fri"]);
    else setEventRecurrenceDays([]);
  });
});

const selectedEventDetailRecurrenceDays = new Set();

function setEventDetailRecurrenceDays(days) {
  selectedEventDetailRecurrenceDays.clear();
  days.forEach((d) => selectedEventDetailRecurrenceDays.add(d));
  document.querySelectorAll("#event-detail-recurrence-picker .weekday-btn").forEach((btn) => {
    btn.classList.toggle("active", selectedEventDetailRecurrenceDays.has(btn.dataset.day));
  });
}

document.querySelectorAll("#event-detail-recurrence-picker .weekday-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const day = btn.dataset.day;
    if (selectedEventDetailRecurrenceDays.has(day)) {
      selectedEventDetailRecurrenceDays.delete(day);
    } else {
      selectedEventDetailRecurrenceDays.add(day);
    }
    btn.classList.toggle("active", selectedEventDetailRecurrenceDays.has(day));
  });
});

document.querySelectorAll("#event-detail-form [data-recur-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.recurPreset;
    if (preset === "daily") setEventDetailRecurrenceDays(WEEKDAY_ORDER);
    else if (preset === "weekdays") setEventDetailRecurrenceDays(["mon", "tue", "wed", "thu", "fri"]);
    else setEventDetailRecurrenceDays([]);
  });
});

guardedSubmit(document.getElementById("event-form"), async (e) => {
  const title = document.getElementById("event-title").value.trim();
  const category = document.getElementById("event-category").value || null;
  const evDate = document.getElementById("event-date").value;
  const startTime = document.getElementById("event-start-time").value;
  const endTime = document.getElementById("event-end-time").value;
  const recurrenceUntilInput = document.getElementById("event-recurrence-until").value || null;
  const notifyVal = document.getElementById("event-notify").value;
  const notify_offset_minutes = notifyVal !== "" ? parseInt(notifyVal, 10) : null;
  const note = document.getElementById("event-note").value.trim() || null;
  if (!title || !evDate || !startTime || !endTime) return;
  const recurrence = selectedEventRecurrenceDays.size ? [...selectedEventRecurrenceDays].join(",") : null;
  await api("/api/events", {
    method: "POST",
    body: JSON.stringify({
      title,
      category,
      date: evDate,
      start_time: startTime,
      end_time: endTime,
      recurrence,
      recurrence_until: recurrence ? recurrenceUntilInput : null,
      notify_offset_minutes,
      note,
    }),
  });
  e.target.reset();
  setEventRecurrenceDays([]);
  closeEventAddPanel();
  loadCalendar();
});

// ---------- event detail panel ----------

let currentDetailEventId = null;

function openEventDetail(ev) {
  currentDetailEventId = ev.id;
  document.getElementById("event-detail-title").value = ev.title;
  document.getElementById("event-detail-category").value = ev.category || "";
  document.getElementById("event-detail-date").value = ev.date;
  document.getElementById("event-detail-start-time").value = ev.start_time;
  document.getElementById("event-detail-end-time").value = ev.end_time;
  document.getElementById("event-detail-notify").value =
    ev.notify_offset_minutes === null || ev.notify_offset_minutes === undefined ? "" : String(ev.notify_offset_minutes);
  document.getElementById("event-detail-recurrence-until").value = ev.recurrence_until || "";
  setEventDetailRecurrenceDays(ev.recurrence ? ev.recurrence.split(",") : []);
  document.getElementById("event-detail-note").value = ev.note || "";
  document.getElementById("event-detail-status").textContent = "";
  document.getElementById("event-detail-panel").classList.remove("hidden");
  document.getElementById("event-detail-backdrop").classList.remove("hidden");
}

function closeEventDetail() {
  document.getElementById("event-detail-panel").classList.add("hidden");
  document.getElementById("event-detail-backdrop").classList.add("hidden");
  currentDetailEventId = null;
}

document.getElementById("event-detail-close").addEventListener("click", closeEventDetail);
document.getElementById("event-detail-backdrop").addEventListener("click", closeEventDetail);

guardedSubmit(document.getElementById("event-detail-form"), async (e) => {
  if (!currentDetailEventId) return;
  const title = document.getElementById("event-detail-title").value.trim();
  const category = document.getElementById("event-detail-category").value || null;
  const evDate = document.getElementById("event-detail-date").value;
  const startTime = document.getElementById("event-detail-start-time").value;
  const endTime = document.getElementById("event-detail-end-time").value;
  const recurrenceUntilInput = document.getElementById("event-detail-recurrence-until").value || null;
  const notifyVal = document.getElementById("event-detail-notify").value;
  const notify_offset_minutes = notifyVal !== "" ? parseInt(notifyVal, 10) : null;
  const note = document.getElementById("event-detail-note").value.trim() || null;
  if (!title || !evDate || !startTime || !endTime) return;
  const recurrence = selectedEventDetailRecurrenceDays.size ? [...selectedEventDetailRecurrenceDays].join(",") : null;
  await api(`/api/events/${currentDetailEventId}`, {
    method: "PUT",
    body: JSON.stringify({
      title,
      category,
      date: evDate,
      start_time: startTime,
      end_time: endTime,
      recurrence,
      recurrence_until: recurrence ? recurrenceUntilInput : null,
      notify_offset_minutes,
      note,
    }),
  });
  document.getElementById("event-detail-status").textContent = "Saved";
  closeEventDetail();
  loadCalendar();
});

// ---------- push notifications ----------

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window;
}

async function getPushSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function updatePushStatus() {
  const statusEl = document.getElementById("push-status");
  const btn = document.getElementById("push-toggle-btn");
  if (!pushSupported()) {
    statusEl.textContent = "This device/browser doesn't support notifications";
    btn.disabled = true;
    return;
  }
  const sub = await getPushSubscription();
  statusEl.textContent = sub ? "Notifications are on" : "Notifications are off";
  btn.textContent = sub ? "Turn off notifications" : "Turn on notifications";
  btn.disabled = false;
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    alert("Notification permission was not granted");
    return;
  }
  const { publicKey } = await api("/api/push/vapid-public-key");
  if (!publicKey) {
    alert("Server-side notification setup isn't complete");
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
}

async function disablePush() {
  const sub = await getPushSubscription();
  if (!sub) return;
  await api("/api/push/unsubscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint: sub.endpoint, keys: {} }),
  });
  await sub.unsubscribe();
}

document.getElementById("push-toggle-btn").addEventListener("click", async () => {
  const sub = await getPushSubscription();
  if (sub) {
    await disablePush();
  } else {
    await enablePush();
  }
  updatePushStatus();
});

updatePushStatus();

// ---------- data export ----------

document.getElementById("export-data-btn").addEventListener("click", () => {
  window.location.href = "/api/export";
});

// 起動直後に見えるToDoタブ(一覧・統計・カウントダウン)だけ、前回取得したキャッシュを
// 即座に描画する。本物の読み込み(critical group)はこの後も従来通り必ず走るので、
// ここで描けなくても・描いた内容が古くても実害はない(すぐ上書きされる)。
async function hydrateFromCache() {
  const [todos, stats, countdown] = await Promise.all([
    cacheGet("/api/todos"),
    cacheGet("/api/todos/stats"),
    cacheGet("/api/goals/countdown"),
  ]);
  let hydrated = false;
  try {
    if (todos) { allTodos = todos; renderTodos(); hydrated = true; }
  } catch (err) { console.error("hydrate todos failed:", err); }
  try {
    if (stats) { renderTodoStats(stats); hydrated = true; }
  } catch (err) { console.error("hydrate todo stats failed:", err); }
  try {
    if (countdown) { renderCountdown(countdown); hydrated = true; }
  } catch (err) { console.error("hydrate countdown failed:", err); }
  return hydrated;
}

// ---------- init ----------

(async function init() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth() + 1;

  if (await hydrateFromCache()) {
    document.getElementById("boot-loading")?.classList.add("hidden");
  }
  hydrateCalendarFromCache(); // 予定タブを開いた瞬間に空グリッドが見えないよう先読み。critical groupは待たない

  await loadCategories(); // study-buttons and the chart's subject list depend on categories being loaded first
  restoreSession();
  startPeerSessionPolling(); // "studying on another device" banner; own timer (if any) already restored above

  // 起動画面は「最初に表示されるToDoタブに必要な分」+「起動画面自体に出す目標カウントダウン」
  // だけ待って閉じる。残り12件は起動画面の裏でバックグラウンド読み込みを続け、届き次第
  // 各セクションに反映される。以前は15件すべてが揃うまで真っ暗な起動画面のままだったため、
  // 体感の読み込み時間が実際より長くなっていた。キャッシュがあれば上でスピナーは既に
  // 消えているが、ここで最新データに必ず上書きするので正しさは変わらない。
  const criticalResults = await Promise.allSettled([loadTodos(), loadTodoStats(), loadCountdown()]);
  criticalResults.filter((r) => r.status === "rejected").forEach((r) => console.error("init load failed:", r.reason));
  document.getElementById("boot-loading")?.classList.add("hidden");

  const backgroundResults = await Promise.allSettled([
    loadStudySummary(),
    loadStudyLogList(),
    loadStudyChart(),
    loadGoalProgress(),
    loadGoals(),
    loadActivationActive(),
    loadActivationList(),
    loadActivationStats(),
    loadActivationPostReturnStats(),
    loadActivationMoodReasons(),
    loadSleepActive(),
    loadCalendar(),
  ]);
  backgroundResults.filter((r) => r.status === "rejected").forEach((r) => console.error("init load failed:", r.reason));
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}
