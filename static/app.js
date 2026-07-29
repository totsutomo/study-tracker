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

function renderTodoItem(t, list) {
  const li = document.createElement("li");
  if (t.done) li.classList.add("done");
  if (isOverdue(t)) li.classList.add("overdue");
  if (!t.done && t.due_date === todayStr() && !isOverdue(t)) li.classList.add("due-today");
  if (t.priority === "high") li.classList.add("priority-high");
  const dueLabel = t.due_date ? `📅 ${t.due_date}${t.due_time ? " " + t.due_time : ""}` : "";
  const recurLabel = t.recurrence === "daily" ? " 🔁毎日" : t.recurrence === "weekdays" ? " 🔁平日" : "";
  const priorityLabel = t.priority && t.priority !== "medium" ? `[${PRIORITY_LABEL[t.priority] || t.priority}] ` : "";
  li.innerHTML = `
    <input type="checkbox" ${t.done ? "checked" : ""}>
    <span>${priorityLabel}${escapeHtml(t.title)}</span>
    <span class="meta">${t.category || ""} ${dueLabel}${recurLabel}</span>
    <button class="delete-btn" title="削除">×</button>
  `;
  li.querySelector("input").addEventListener("click", async () => {
    await api(`/api/todos/${t.id}/toggle`, { method: "POST" });
    loadTodos();
    loadTodoStats();
  });
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

document.querySelectorAll(".quick-date-btn").forEach((btn) => {
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
  }
});

document.getElementById("todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("todo-title").value.trim();
  const category = document.getElementById("todo-category").value;
  const priority = document.getElementById("todo-priority").value;
  const due_date = document.getElementById("todo-due-date").value || null;
  const due_time = document.getElementById("todo-due-time").value || null;
  const recurrence = document.getElementById("todo-recurrence").value || null;
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
  document.getElementById("todo-recurrence").value = "";
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

let timerInterval = null;
let timerStart = null;
let timerSubject = null;

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

document.querySelectorAll(".subject-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (timerInterval) return; // already running
    timerSubject = btn.dataset.subject;
    timerStart = Date.now();
    btn.classList.add("active");
    document.getElementById("timer-stop").style.display = "inline-block";
    timerInterval = setInterval(() => {
      document.getElementById("timer-display").textContent = formatElapsed(Date.now() - timerStart);
    }, 1000);
  });
});

document.getElementById("timer-stop").addEventListener("click", async () => {
  if (!timerInterval) return;
  clearInterval(timerInterval);
  timerInterval = null;
  const elapsedMinutes = Math.max(1, Math.round((Date.now() - timerStart) / 60000));
  await api("/api/study-logs", {
    method: "POST",
    body: JSON.stringify({ subject: timerSubject, minutes: elapsedMinutes }),
  });
  document.getElementById("timer-display").textContent = "00:00";
  document.getElementById("timer-stop").style.display = "none";
  document.querySelectorAll(".subject-btn").forEach((b) => b.classList.remove("active"));
  loadStudySummary();
  loadStudyLogList();
});

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

async function loadStudyLogList() {
  const logs = await api("/api/study-logs");
  const list = document.getElementById("study-log-list");
  list.innerHTML = "";
  logs.slice(0, 20).forEach((l) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${l.subject} ${l.minutes}分</span><span class="meta">${l.logged_at}</span>`;
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

loadTodos();
loadTodoStats();
loadDiaryEditor(todayStr());
loadDiaryList();
loadStudySummary();
loadStudyLogList();
loadCountdown();
loadGoals();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}
