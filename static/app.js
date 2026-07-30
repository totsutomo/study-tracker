// ---------- tab switching ----------

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    tabPanels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

// ---------- helpers ----------

async function api(path, options = {}, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// ---------- todos ----------

const PRIORITY_LABEL = { high: "高", medium: "中", low: "低" };

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
const WEEKDAY_LABEL = { mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日" };

function recurrenceLabel(recurrence) {
  if (!recurrence) return "";
  const days = recurrence.split(",");
  if (days.length === 7) return " 🔁毎日";
  const weekdaysOnly = ["mon", "tue", "wed", "thu", "fri"];
  if (days.length === 5 && weekdaysOnly.every((d) => days.includes(d))) return " 🔁平日";
  const sorted = WEEKDAY_ORDER.filter((d) => days.includes(d));
  return " 🔁" + sorted.map((d) => WEEKDAY_LABEL[d]).join("");
}

function renderTodoItem(t, list) {
  const li = document.createElement("li");
  if (t.done) li.classList.add("done");
  if (isOverdue(t)) li.classList.add("overdue");
  if (!t.done && t.due_date === todayStr() && !isOverdue(t)) li.classList.add("due-today");
  if (t.priority === "high") li.classList.add("priority-high");
  const dueLabel = t.due_date ? `📅 ${t.due_date}${t.due_time ? " " + t.due_time : ""}` : "";
  const recurLabel = recurrenceLabel(t.recurrence);
  const priorityLabel = t.priority && t.priority !== "medium" ? `[${PRIORITY_LABEL[t.priority] || t.priority}] ` : "";
  li.innerHTML = `
    <input type="checkbox" ${t.done ? "checked" : ""}>
    <span>${priorityLabel}${escapeHtml(t.title)}</span>
    <span class="meta">${t.category || ""} ${dueLabel}${recurLabel}</span>
    ${!t.done && t.category ? `<button class="play-btn" title="記録開始">▶</button>` : ""}
    <button class="delete-btn" title="削除">×</button>
  `;
  li.querySelector("input").addEventListener("click", async () => {
    await api(`/api/todos/${t.id}/toggle`, { method: "POST" });
    loadTodos();
    loadTodoStats();
  });
  const playBtn = li.querySelector(".play-btn");
  if (playBtn) {
    playBtn.addEventListener("click", () => startTimerForTodo(t));
  }
  li.querySelector(".delete-btn").addEventListener("click", async () => {
    await api(`/api/todos/${t.id}`, { method: "DELETE" });
    loadTodos();
  });
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
  if (t.due_date <= weekAhead.toISOString().slice(0, 10)) return "week";
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
    ["overdue", "期限切れ"],
    ["today", "今日"],
    ["week", "今週"],
    ["later", "それ以降"],
    ["none", "期限なし"],
    ["done", "完了"],
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
    groupsEl.innerHTML = "<p class='meta'>該当するタスクがありません</p>";
  }
}

async function loadTodos() {
  allTodos = await api("/api/todos");
  renderTodos();
}

["todo-search", "todo-filter-category", "todo-filter-today"].forEach((id) => {
  document.getElementById(id).addEventListener("input", renderTodos);
});

async function loadTodoStats() {
  const stats = await api("/api/todos/stats");
  const el = document.getElementById("todo-stats");
  const maxDaily = Math.max(1, ...stats.daily.map((d) => d.c));
  const barsHtml = stats.daily
    .map((d) => `
      <div class="stat-bar-row">
        <span class="meta">${d.d.slice(5)}</span>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${(d.c / maxDaily) * 100}%"></div></div>
        <span class="meta">${d.c}件</span>
      </div>
    `)
    .join("");
  el.innerHTML = `
    <p>累計達成: ${stats.done}/${stats.total}件(達成率 ${stats.rate}%)</p>
    ${stats.daily.length ? `<p class="meta">直近7日の完了数</p>${barsHtml}` : ""}
  `;
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
    const dateInput = document.getElementById("todo-due-date");
    const quick = btn.dataset.quick;
    if (quick === "clear") {
      dateInput.value = "";
      return;
    }
    const d = new Date();
    if (quick === "tomorrow") d.setDate(d.getDate() + 1);
    if (quick === "nextweek") d.setDate(d.getDate() + 7);
    dateInput.value = d.toISOString().slice(0, 10);
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

document.querySelectorAll(".weekday-btn").forEach((btn) => {
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

document.querySelectorAll("[data-recur-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const preset = btn.dataset.recurPreset;
    if (preset === "daily") setRecurrenceDays(WEEKDAY_ORDER);
    else if (preset === "weekdays") setRecurrenceDays(["mon", "tue", "wed", "thu", "fri"]);
    else setRecurrenceDays([]);
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
  populateManualLogSubjects(cats);

  const list = document.getElementById("category-list");
  list.innerHTML = "";
  cats.forEach((c) => renderCategoryItem(c, list));

  const addSelect = document.getElementById("todo-category");
  const filterSelect = document.getElementById("todo-filter-category");
  const addCurrent = addSelect.value;
  const filterCurrent = filterSelect.value;
  addSelect.innerHTML = cats.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
  filterSelect.innerHTML =
    `<option value="">カテゴリ: すべて</option>` +
    cats.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
  if (cats.some((c) => c.name === addCurrent)) addSelect.value = addCurrent;
  filterSelect.value = filterCurrent;
}

function renderCategoryItem(cat, list) {
  const li = document.createElement("li");
  li.innerHTML = `
    <input type="text" class="category-name-input" value="${escapeHtml(cat.name)}">
    <button class="delete-btn" title="削除">×</button>
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

document.getElementById("category-form").addEventListener("submit", async (e) => {
  e.preventDefault();
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

document.getElementById("todo-time-toggle").addEventListener("click", () => {
  const timeInput = document.getElementById("todo-due-time");
  const toggleBtn = document.getElementById("todo-time-toggle");
  const showing = timeInput.style.display !== "none";
  if (showing) {
    timeInput.style.display = "none";
    timeInput.value = "";
    toggleBtn.textContent = "+ 時刻を追加";
  } else {
    timeInput.style.display = "";
    toggleBtn.textContent = "− 時刻を削除";
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

document.getElementById("todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("todo-title").value.trim();
  const category = document.getElementById("todo-category").value;
  const priority = document.getElementById("todo-priority").value;
  const due_date = document.getElementById("todo-due-date").value || null;
  const due_time = document.getElementById("todo-due-time").value || null;
  const recurrence =
    selectedRecurrenceDays.size > 0 ? WEEKDAY_ORDER.filter((d) => selectedRecurrenceDays.has(d)).join(",") : null;
  if (!title) return;
  await api("/api/todos", {
    method: "POST",
    body: JSON.stringify({ title, category, priority, due_date, due_time, recurrence }),
  });
  document.getElementById("todo-title").value = "";
  document.getElementById("todo-due-date").value = "";
  document.getElementById("todo-due-time").value = "";
  document.getElementById("todo-due-time").style.display = "none";
  document.getElementById("todo-time-toggle").textContent = "+ 時刻を追加";
  setRecurrenceDays([]);
  closeTodoAddPanel();
  loadTodos();
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- diary ----------

let currentDiaryDate = todayStr();

async function loadDiaryEditor(dateStr) {
  currentDiaryDate = dateStr;
  document.getElementById("diary-date-label").textContent = dateStr;
  const entry = await api(`/api/diary/${dateStr}`);
  document.getElementById("diary-content").value = entry.content || "";
  document.getElementById("diary-status").textContent = "";
}

async function loadDiaryList() {
  const entries = await api("/api/diary");
  const list = document.getElementById("diary-list");
  list.innerHTML = "";
  entries.forEach((e) => {
    const li = document.createElement("li");
    const preview = e.content.length > 30 ? e.content.slice(0, 30) + "..." : e.content;
    li.innerHTML = `<strong>${e.date}</strong><span class="meta">${escapeHtml(preview)}</span>`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => loadDiaryEditor(e.date));
    list.appendChild(li);
  });
}

document.getElementById("diary-save").addEventListener("click", async () => {
  const content = document.getElementById("diary-content").value;
  await api("/api/diary", {
    method: "PUT",
    body: JSON.stringify({ date: currentDiaryDate, content }),
  });
  document.getElementById("diary-status").textContent = "保存しました";
  loadDiaryList();
});

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
    btn.addEventListener("click", () => {
      if (timerSubject) return; // a session is already running
      timerSubject = btn.dataset.subject;
      activeTodoId = null;
      accumulatedMs = 0;
      segmentStart = Date.now();
      isPaused = false;
      openFocusOverlay();
      startTimerTick();
    });
  });
}

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

document.getElementById("manual-log-toggle").addEventListener("click", () => {
  const form = document.getElementById("manual-log-form");
  const opening = form.classList.contains("hidden");
  form.classList.toggle("hidden");
  if (opening) {
    document.getElementById("manual-log-datetime").value = localDatetimeNow();
  }
});

document.getElementById("manual-log-form").addEventListener("submit", async (e) => {
  e.preventDefault();
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

function startTimerForTodo(todo) {
  if (timerSubject) {
    alert("すでにタイマーが動いています");
    return;
  }
  timerSubject = todo.category;
  activeTodoId = todo.id;
  accumulatedMs = 0;
  segmentStart = Date.now();
  isPaused = false;
  openFocusOverlay();
  startTimerTick();
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

// ---------- focus timer (start / pause / resume / stop) ----------

let timerInterval = null;
let timerSubject = null;
let activeTodoId = null;
let accumulatedMs = 0;
let segmentStart = null;
let isPaused = false;

const RING_CIRCUMFERENCE = 2 * Math.PI * 54;
const RING_PERIOD_MS = 25 * 60 * 1000; // ring completes one lap every 25 min, purely decorative

function currentElapsedMs() {
  return accumulatedMs + (segmentStart ? Date.now() - segmentStart : 0);
}

function updateFocusDisplay() {
  const elapsed = currentElapsedMs();
  document.getElementById("focus-timer").textContent = formatElapsed(elapsed);
  const progress = (elapsed % RING_PERIOD_MS) / RING_PERIOD_MS;
  document.getElementById("focus-ring-fill").style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - progress);
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

function openFocusOverlay() {
  const color = colorFor(timerSubject);
  document.getElementById("focus-subject-name").textContent = timerSubject;
  document.getElementById("focus-timer").style.color = color;
  document.getElementById("focus-ring-fill").style.stroke = color;
  document.getElementById("focus-pause-btn").textContent = "一時停止";
  const overlay = document.getElementById("focus-overlay");
  overlay.classList.remove("hidden");
  overlay.classList.remove("paused");
}

function closeFocusOverlay() {
  document.getElementById("focus-overlay").classList.add("hidden");
}

document.getElementById("focus-pause-btn").addEventListener("click", () => {
  if (!timerSubject) return;
  const overlay = document.getElementById("focus-overlay");
  const pauseBtn = document.getElementById("focus-pause-btn");
  if (isPaused) {
    segmentStart = Date.now();
    isPaused = false;
    startTimerTick();
    pauseBtn.textContent = "一時停止";
    overlay.classList.remove("paused");
  } else {
    accumulatedMs += Date.now() - segmentStart;
    segmentStart = null;
    isPaused = true;
    stopTimerTick();
    pauseBtn.textContent = "再開";
    overlay.classList.add("paused");
  }
});

document.getElementById("focus-stop-btn").addEventListener("click", async () => {
  if (!timerSubject) return;
  const totalMs = currentElapsedMs();
  stopTimerTick();
  const elapsedMinutes = Math.max(1, Math.round(totalMs / 60000));
  const subject = timerSubject;
  const todoId = activeTodoId;
  timerSubject = null;
  activeTodoId = null;
  accumulatedMs = 0;
  segmentStart = null;
  isPaused = false;
  closeFocusOverlay();
  await api("/api/study-logs", {
    method: "POST",
    body: JSON.stringify({ subject, minutes: elapsedMinutes }),
  });
  if (todoId && confirm("このタスクを完了にする?")) {
    await api(`/api/todos/${todoId}/toggle`, { method: "POST" });
    loadTodos();
    loadTodoStats();
  }
  loadStudySummary();
  loadStudyLogList();
  loadStudyChart();
  loadGoalProgress();
});

// ---------- daily / weekly chart ----------

const WEEKLY_CHART_WEEKS = 10;

let chartGranularity = localStorage.getItem("studyChartGranularity") === "day" ? "day" : "week";

function last14Dates() {
  const dates = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function mondayOf(d) {
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  return monday.toISOString().slice(0, 10);
}

function lastNWeekStarts(n) {
  const currentMonday = new Date(mondayOf(new Date()));
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(currentMonday);
    d.setDate(d.getDate() - i * 7);
    weeks.push(d.toISOString().slice(0, 10));
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
    detailLabel: (w) => `${monthDayLabel(w)}週`,
  });
}

function renderStudyChart(buckets, byBucket, subjectNames, labelFns) {
  const container = document.getElementById("study-chart");
  const totals = buckets.map((b) => subjectNames.reduce((sum, s) => sum + (byBucket[b][s] || 0), 0));
  const maxTotal = Math.max(60, ...totals);
  const chartW = 320;
  const chartH = 130;
  const padLeft = 26;
  const padBottom = 14;
  const plotW = chartW - padLeft - 2;
  const plotH = chartH - padBottom;
  const barGap = 3;
  const barW = plotW / buckets.length - barGap;

  const gridLines = [0, 0.5, 1]
    .map((frac) => {
      const y = plotH - plotH * frac;
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
      let yCursor = plotH;
      const segments = subjectNames.map((s) => {
        const minutes = byBucket[b][s] || 0;
        if (minutes <= 0) return "";
        const h = (minutes / maxTotal) * plotH;
        const y = yCursor - h;
        yCursor -= h + 1;
        return `<rect x="${x}" y="${y}" width="${Math.max(barW, 0)}" height="${Math.max(h, 0)}" fill="${colorFor(s)}" rx="2" data-bucket="${b}" data-subject="${s}" data-minutes="${minutes}"></rect>`;
      }).join("");
      const axisLabel = labelFns.axisLabel(b);
      return `${segments}<text x="${x + barW / 2}" y="${chartH}" font-size="8" fill="var(--text-muted)" text-anchor="middle">${axisLabel}</text>`;
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
      document.getElementById("study-chart-detail").textContent = `${labelFns.detailLabel(bucket)} ${subject}: ${minutes}分`;
    });
  });
}

function updateChartTitle() {
  document.getElementById("study-chart-title").textContent =
    chartGranularity === "day" ? "直近14日間" : `直近${WEEKLY_CHART_WEEKS}週間`;
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
  if (minutes < 60) return `${minutes}分`;
  return `${(minutes / 60).toFixed(1)}時間`;
}

async function loadGoalProgress() {
  const p = await api("/api/study-logs/progress");
  document.getElementById("stat-today").textContent = formatDuration(p.today_minutes);
  document.getElementById("stat-month").textContent = formatDuration(p.month_minutes);
  document.getElementById("stat-total").textContent = formatDuration(p.total_minutes);

  const weekHours = (p.week_minutes / 60).toFixed(1);
  const monthHours = (p.month_minutes / 60).toFixed(1);
  const weekGoalHours = p.weekly_goal_minutes ? p.weekly_goal_minutes / 60 : null;
  const monthGoalHours = p.monthly_goal_minutes ? p.monthly_goal_minutes / 60 : null;

  document.getElementById("week-progress-label").textContent = weekGoalHours
    ? `${weekHours} / ${weekGoalHours}時間`
    : `${weekHours}時間(目標未設定)`;
  document.getElementById("week-progress-fill").style.width = weekGoalHours
    ? `${Math.min(100, (p.week_minutes / p.weekly_goal_minutes) * 100)}%`
    : "0%";

  document.getElementById("month-progress-label").textContent = monthGoalHours
    ? `${monthHours} / ${monthGoalHours}時間`
    : `${monthHours}時間(目標未設定)`;
  document.getElementById("month-progress-fill").style.width = monthGoalHours
    ? `${Math.min(100, (p.month_minutes / p.monthly_goal_minutes) * 100)}%`
    : "0%";

  document.getElementById("weekly-goal-input").value = weekGoalHours || "";
  document.getElementById("monthly-goal-input").value = monthGoalHours || "";
}

document.getElementById("goal-minutes-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const weeklyHours = parseFloat(document.getElementById("weekly-goal-input").value);
  const monthlyHours = parseFloat(document.getElementById("monthly-goal-input").value);
  const payload = {};
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
    list.innerHTML = "<li>まだ記録がありません</li>";
    return;
  }
  summary.forEach((s) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${s.subject}</span><span class="meta">${s.total_minutes}分</span>`;
    list.appendChild(li);
  });
}

function formatLogDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

function formatLoggedAt(s) {
  const [datePart, timePart] = s.split(" ");
  const [, mo, da] = datePart.split("-");
  const [hh, mm] = timePart.split(":");
  return `${parseInt(mo, 10)}/${parseInt(da, 10)} ${hh}:${mm}`;
}

async function loadStudyLogList() {
  const logs = await api("/api/study-logs");
  const list = document.getElementById("study-log-list");
  list.innerHTML = "";
  logs.slice(0, 20).forEach((l) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="log-icon" style="background:${colorFor(l.subject)}"></span>
      <span class="log-info">
        <span class="log-subject">${escapeHtml(l.subject)}</span>
        <span class="log-time">${formatLoggedAt(l.logged_at)}</span>
      </span>
      <span class="log-duration">${formatLogDuration(l.minutes)}</span>
      <button class="delete-btn" title="削除">×</button>
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

async function loadCountdown() {
  const c = await api("/api/goals/countdown");
  document.getElementById("countdown").innerHTML =
    `英検準1級・C1 目標(留学終了)まで<br><span class="days">${c.days_left}日</span>`;
}

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
      <button class="delete-btn" title="削除">×</button>
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
    goals.length ? `達成率: ${doneCount}/${goals.length} (${pct}%)` : "";
}

document.getElementById("goal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("goal-title").value.trim();
  if (!title) return;
  await api("/api/goals", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  document.getElementById("goal-title").value = "";
  loadGoals();
});

// ---------- init ----------

(async function init() {
  await loadCategories(); // study-buttons and the chart's subject list depend on categories being loaded first
  loadTodos();
  loadTodoStats();
  loadDiaryEditor(todayStr());
  loadDiaryList();
  loadStudySummary();
  loadStudyLogList();
  loadStudyChart();
  loadGoalProgress();
  loadCountdown();
  loadGoals();
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}
