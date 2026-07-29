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

async function loadTodos() {
  const todos = await api("/api/todos");
  const list = document.getElementById("todo-list");
  list.innerHTML = "";
  todos.forEach((t) => {
    const li = document.createElement("li");
    if (t.done) li.classList.add("done");
    li.innerHTML = `
      <input type="checkbox" ${t.done ? "checked" : ""}>
      <span>${escapeHtml(t.title)}</span>
      <span class="meta">${t.category || ""}</span>
      <button class="delete-btn" title="削除">×</button>
    `;
    li.querySelector("input").addEventListener("click", async () => {
      await api(`/api/todos/${t.id}/toggle`, { method: "POST" });
      loadTodos();
    });
    li.querySelector(".delete-btn").addEventListener("click", async () => {
      await api(`/api/todos/${t.id}`, { method: "DELETE" });
      loadTodos();
    });
    list.appendChild(li);
  });
}

document.getElementById("todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("todo-title").value.trim();
  const category = document.getElementById("todo-category").value;
  if (!title) return;
  await api("/api/todos", {
    method: "POST",
    body: JSON.stringify({ title, category }),
  });
  document.getElementById("todo-title").value = "";
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
loadDiaryEditor(todayStr());
loadDiaryList();
loadStudySummary();
loadStudyLogList();
loadCountdown();
loadGoals();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}
