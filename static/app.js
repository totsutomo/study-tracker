// ---------- tab switching ----------

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

// タブの切り替えをブラウザの履歴に積み、Alt+←/→・マウスの戻る/進む・Androidの戻るで
// 前のタブへ戻れるようにする(2026-09-28)。popstateからの呼び出しは履歴を積まない
function switchTab(tabId, { fromHistory = false } = {}) {
  const prevTab = document.querySelector(".tab-panel.active")?.id;
  if (!fromHistory && prevTab !== tabId) history.pushState({ tab: tabId }, "");
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  tabPanels.forEach((p) => p.classList.toggle("active", p.id === tabId));
  if (typeof timerSubject !== "undefined" && timerSubject && !overlayMinimized) {
    minimizeFocusOverlay();
  }
  // タブが非表示(display:none)の間はグリッドの位置が測れないため、Calendarタブが
  // 表示された瞬間に高さを再計算する(updateCalGridHeightはapp.js後方で定義、
  // switchTab自体はクリック時にしか呼ばれないのでhoisting上の問題はない)
  if (tabId === "tab-calendar" && typeof updateCalGridHeight === "function") updateCalGridHeight();
  if (tabId === "tab-todo" && typeof loadTodayPanel === "function") loadTodayPanel();
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

history.replaceState({ tab: document.querySelector(".tab-panel.active")?.id }, "");
window.addEventListener("popstate", (e) => {
  if (e.state?.tab) switchTab(e.state.tab, { fromHistory: true });
});

document.getElementById("daily-min-banner").addEventListener("click", () => switchTab("tab-study"));
document.getElementById("screen-budget-banner").addEventListener("click", () => switchTab("tab-study"));

// Ctrl+数字でタブバーの並び順通りに切り替える(重複表示されているデスクトップ/モバイル navから
// タブIDの並びだけ重複排除して使う)。PWAとしてインストールした場合はブラウザのタブ切替
// ショートカットと衝突しないが、通常のブラウザタブ内で開いている場合はブラウザ側が
// 先取りすることがある。
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !/^[1-9]$/.test(e.key)) return;
  const orderedTabIds = [...new Set([...tabButtons].map((b) => b.dataset.tab))];
  const targetTabId = orderedTabIds[Number(e.key) - 1];
  if (!targetTabId) return;
  e.preventDefault();
  switchTab(targetTabId);
});

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

// 同じGETが同時に複数の場所から呼ばれた時(例: Stop後のグラフ更新と「今日の勉強時間」パネルが
// どちらも/api/study-logs/dailyと/progressを取りに行く)は、1本の通信を共有する(2026-09-29)。
// サーバーはTursoの返事待ちの間ほかのリクエストを実質1件ずつしか捌けず、重複分がそのまま待ち時間になっていた
const inflightGets = new Map();

function api(path, options = {}, retries = 3) {
  const isGet = !options.method || options.method.toUpperCase() === "GET";
  if (!isGet) return apiRequest(path, options, retries);
  const existing = inflightGets.get(path);
  if (existing) return existing;
  const p = apiRequest(path, options, retries).finally(() => inflightGets.delete(path));
  inflightGets.set(path, p);
  return p;
}

async function apiRequest(path, options = {}, retries = 3) {
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

// 上のキャッシュを使ったstale-while-revalidateの汎用版(2026-09-28)。前回取得した内容があれば
// まずそれでrender→サーバーの最新が届いたらもう一度render。renderは最大2回呼ばれる前提で書くこと。
// サーバーの方が先に返ってきた場合は、古いキャッシュで上書きしないよう描画を捨てる。
// サーバー取得に失敗した時は、キャッシュで描けていればエラーにしない(古くても何も出ないよりまし)。
async function apiCached(path, render) {
  let fresh = false;
  let paintedFromCache = false;
  cacheGet(path).then((data) => {
    if (fresh || data === undefined) return;
    try {
      render(data);
      paintedFromCache = true;
    } catch (err) {
      console.error(`cache render failed: ${path}`, err);
    }
  });
  let data;
  try {
    data = await api(path);
  } catch (err) {
    if (paintedFromCache) {
      console.error(`refresh failed, keeping cached view: ${path}`, err);
      return undefined;
    }
    throw err;
  }
  fresh = true;
  render(data);
  return data;
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

// 保存失敗を知らせる非ブロッキング通知(2026-09-05導入)。楽観的更新の失敗時、
// alert()だとその瞬間フォーカスを奪って別操作の邪魔になるため、自動で消える控えめな表示にする。
let toastTimer = null;
// action = { label, onClick } を渡すと「元に戻す」のようなボタン付きのトーストになる
function showToast(message, action = null, durationMs = 4000) {
  let el = document.getElementById("toast-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-banner";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("has-action", !!action);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      el.classList.remove("show");
      action.onClick();
    });
    el.appendChild(btn);
  }
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), durationMs);
}

// 取り消せる削除(2026-09-27): ゴミ箱ボタンは▶・スキップの隣にあり押し間違えやすいので、
// 画面からは即消すがサーバーへのDELETEは5秒待ち、その間は「Undo」で戻せるようにする。
// アプリを閉じる/切り替える(visibilityState=hidden)時点で待機中の削除は即送信する。
const UNDO_WINDOW_MS = 5000;
let pendingDeletes = [];

function undoableDelete(message, { apply, revert, commit }) {
  apply();
  const entry = { done: false };
  entry.run = async () => {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    pendingDeletes = pendingDeletes.filter((e) => e !== entry);
    try {
      await commit();
    } catch (err) {
      revert();
      showToast("保存に失敗しました。もう一度お試しください");
    }
  };
  entry.timer = setTimeout(entry.run, UNDO_WINDOW_MS);
  pendingDeletes.push(entry);
  showToast(message, {
    label: "Undo",
    onClick: () => {
      if (entry.done) return;
      entry.done = true;
      clearTimeout(entry.timer);
      pendingDeletes = pendingDeletes.filter((e) => e !== entry);
      revert();
    },
  }, UNDO_WINDOW_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") pendingDeletes.slice().forEach((e) => e.run());
});

// 楽観的更新の共通処理(2026-09-05導入): サーバーの応答を待ってから画面を更新するのではなく、
// 成功する前提でローカル状態を即座に書き換えて再描画し(apply)、保存(request)は裏で進める。
// 失敗したらrevertで元の状態に戻し、トーストで知らせる。1件のオブジェクトの更新/配列からの
// 追加・削除など、呼び出し側でapply/revertに必要な情報を閉じ込めて渡す想定。
async function optimistic(apply, revert, request) {
  apply();
  try {
    return await request();
  } catch (err) {
    revert();
    showToast("保存に失敗しました。もう一度お試しください");
    throw err;
  }
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
  if (t.done || t.skipped || !t.due_date) return false;
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
  // スキップ(「翌日に持ち越さないが削除もしない」)用。メディアプレイヤーの「次へ送る」アイコンを流用
  skip:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 4 15 12 5 20"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
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

// 完了・スキップは相互排他(サーバー側の仕様に合わせる: [main.py](../main.py)の
// toggle_todo/skip_todo参照)。楽観的に即時反映し、繰り返しToDoを完了/スキップした時だけ
// (次回分が1件増えるため)裏でloadTodos()を呼んで拾う。それ以外は再取得しない。
async function toggleTodoDone(t) {
  const prev = { done: t.done, completed_at: t.completed_at, skipped: t.skipped, skipped_at: t.skipped_at };
  await optimistic(
    () => {
      t.done = t.done ? 0 : 1;
      t.completed_at = t.done ? new Date().toISOString() : null;
      if (t.done) { t.skipped = 0; t.skipped_at = null; }
      renderTodos();
    },
    () => { Object.assign(t, prev); renderTodos(); },
    async () => {
      await api(`/api/todos/${t.id}/toggle`, { method: "POST" });
      loadTodoStats();
      if (t.recurrence && t.done) loadTodos();
    },
  );
}

async function toggleTodoSkip(t) {
  const prev = { done: t.done, completed_at: t.completed_at, skipped: t.skipped, skipped_at: t.skipped_at };
  await optimistic(
    () => {
      t.skipped = t.skipped ? 0 : 1;
      t.skipped_at = t.skipped ? new Date().toISOString() : null;
      if (t.skipped) { t.done = 0; t.completed_at = null; }
      renderTodos();
    },
    () => { Object.assign(t, prev); renderTodos(); },
    async () => {
      await api(`/api/todos/${t.id}/skip`, { method: "POST" });
      loadTodoStats();
      if (t.recurrence && t.skipped) loadTodos();
    },
  );
}

function deleteTodo(t) {
  const idx = allTodos.indexOf(t);
  undoableDelete(`Deleted "${t.title}"`, {
    apply: () => { if (idx !== -1) allTodos.splice(idx, 1); renderTodos(); },
    revert: () => { if (idx !== -1 && !allTodos.includes(t)) allTodos.splice(idx, 0, t); renderTodos(); },
    commit: async () => { await api(`/api/todos/${t.id}`, { method: "DELETE" }); loadTodoStats(); },
  });
}

// スワイプで完了⇄未完了(右)・スキップ⇄解除(左)を切り替えるジェスチャー。ボタン・チェックボックスの
// 上から始まった操作はドラッグとして扱わない(タップの邪魔をしない)。
// しきい値を超えたらそれぞれの処理を呼び、そうでなければ元の位置へ戻す。
// 一定以上ドラッグした場合は、指を離した直後に発火するclickイベント(詳細パネルを開く処理)を
// 1回だけ握りつぶす。そうしないとスワイプ操作のたびに詳細パネルも一緒に開いてしまう。
function attachSwipeGestures(li, content, completeBg, skipBg, t, onTap) {
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
    dx = e.clientX - startX; // 右=完了トグル、左=スキップトグル
    completeBg.style.display = dx >= 0 ? "flex" : "none";
    skipBg.style.display = dx < 0 ? "flex" : "none";
    content.style.transform = `translateX(${dx}px)`;
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    content.style.transition = "transform 0.2s ease";
    if (Math.abs(dx) > dragMinDistance) suppressNextClick = true;
    if (dx > width * threshold) {
      content.style.transform = `translateX(${width}px)`;
      setTimeout(() => toggleTodoDone(t), 140);
    } else if (dx < -width * threshold) {
      content.style.transform = `translateX(-${width}px)`;
      setTimeout(() => toggleTodoSkip(t), 140);
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

// カードの後ろ倒しボタン(PC)と詳細パネルのボタン(スマホ)の両方から使う
async function rescheduleTodo(t, kind) {
  const { due_date, due_time } = computeReschedule(t, kind);
  const prev = { due_date: t.due_date, due_time: t.due_time };
  await optimistic(
    () => { t.due_date = due_date; t.due_time = due_time; renderTodos(); },
    () => { Object.assign(t, prev); renderTodos(); },
    async () => {
      await api(`/api/todos/${t.id}/due`, { method: "PUT", body: JSON.stringify({ due_date, due_time }) });
      loadCalendar();
    },
  );
}

function canReschedule(t) {
  return !t.done && !t.skipped && t.due_date && (isOverdue(t) || t.due_date === todayStr());
}

function renderTodoItem(t, list) {
  const li = document.createElement("li");
  // id無し=追加直後に手元で先に出した仮の行(サーバーのidが届くまで操作させない。2026-09-29)
  if (t.id == null) {
    li.classList.add("todo-pending");
    li.inert = true;
  }
  if (t.done) li.classList.add("done");
  if (t.skipped) li.classList.add("skipped");
  const overdue = isOverdue(t);
  if (overdue) li.classList.add("overdue");
  if (!t.done && !t.skipped && t.due_date === todayStr() && !overdue) li.classList.add("due-today");
  if (t.priority === "high") li.classList.add("priority-high");
  // 今日が期限のものは「Today」見出しの下に並ぶので日付は重複。時刻があれば時刻だけ残す(2026-09-27)
  const dueLabel = !t.due_date ? ""
    : t.due_date === todayStr() ? (t.due_time ? `${ICONS.clock} ${t.due_time}` : "")
    : `${ICONS.calendar} ${t.due_date}${t.due_time ? " " + t.due_time : ""}`;
  const recurLabel = recurrenceLabel(t.recurrence);
  const priorityLabel = t.priority && t.priority !== "medium" ? `[${PRIORITY_LABEL[t.priority] || t.priority}] ` : "";
  const noteMark = t.note ? ` ${ICONS.note}` : "";
  const showReschedule = canReschedule(t);
  const dotColor = t.category ? colorFor(t.category) : "var(--border)";
  li.innerHTML = `
    <div class="todo-swipe-bg ${t.done ? "undo" : "complete"}">
      ${t.done ? `${ICONS.repeat} Mark incomplete` : `${ICONS.check} Mark complete`}
    </div>
    <div class="todo-swipe-bg skip-bg ${t.skipped ? "unskip" : "skip"}">
      ${t.skipped ? `${ICONS.repeat} Unskip` : `${ICONS.skip} Skip`}
    </div>
    <div class="todo-swipe-content">
      <div class="todo-card-top">
        <input type="checkbox" ${t.done ? "checked" : ""}>
        <span class="todo-card-dot" style="background:${dotColor}"></span>
        <div class="todo-card-main">
          <span class="todo-card-title" title="${escapeHtml(t.title)}">${priorityLabel}${escapeHtml(t.title)}${noteMark}</span>
          <span class="todo-card-meta">${t.category || ""} ${dueLabel}${recurLabel}${t.skipped ? " · Skipped" : ""}${countsAsStudyTodo(t) ? "" : " · Not counted"}</span>
        </div>
        <div class="todo-card-actions">
          ${showReschedule ? `
            <div class="reschedule-row">
              <button type="button" class="reschedule-btn" data-kind="+30">+30 min</button>
              <button type="button" class="reschedule-btn" data-kind="+60">+1 hr</button>
              <button type="button" class="reschedule-btn" data-kind="tomorrow">Tomorrow</button>
            </div>
          ` : ""}
          ${!t.done && !t.skipped && t.category ? `<button class="play-btn" title="Start recording">${ICONS.play}</button>` : ""}
          ${!t.done ? `<button class="skip-btn" title="${t.skipped ? "Unskip" : "Skip (don't carry over, keep record)"}">${ICONS.skip}</button>` : ""}
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
  const skipBtn = li.querySelector(".skip-btn");
  if (skipBtn) {
    skipBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTodoSkip(t);
    });
  }
  li.querySelector(".delete-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteTodo(t);
  });
  li.querySelectorAll(".reschedule-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      rescheduleTodo(t, btn.dataset.kind);
    });
  });
  attachSwipeGestures(
    li,
    li.querySelector(".todo-swipe-content"),
    li.querySelector(".todo-swipe-bg:not(.skip-bg)"),
    li.querySelector(".skip-bg"),
    t,
    () => openTodoDetail(t)
  );
  li.classList.add("clickable");
  list.appendChild(li);
}

function todoGroupOf(t) {
  if (t.done) return "done";
  if (t.skipped) return "skipped";
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
let skippedExpanded = false;

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

  const groups = { overdue: [], today: [], week: [], later: [], none: [], done: [], skipped: [] };
  todos.forEach((t) => groups[todoGroupOf(t)].push(t));

  const sections = [
    ["overdue", "Overdue"],
    ["today", "Today"],
    ["week", "This week"],
    ["later", "Later"],
    ["none", "No due date"],
    ["done", "Done"],
    ["skipped", "Skipped"],
  ];
  const collapsedState = { done: doneExpanded, skipped: skippedExpanded };

  sections.forEach(([key, label]) => {
    if (groups[key].length === 0) return;
    const h = document.createElement("h3");
    if (key === "done" || key === "skipped") {
      h.classList.add("collapsible");
      h.textContent = `${collapsedState[key] ? "▼" : "▶"} ${label}(${groups[key].length})`;
      h.addEventListener("click", () => {
        if (key === "done") doneExpanded = !doneExpanded;
        else skippedExpanded = !skippedExpanded;
        renderTodos();
      });
    } else {
      h.textContent = `${label}(${groups[key].length})`;
    }
    groupsEl.appendChild(h);
    const ul = document.createElement("ul");
    ul.className = "list";
    if ((key === "done" || key === "skipped") && !collapsedState[key]) ul.style.display = "none";
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
    const prevList = deferCandidates.map((t) => ({ t, due_date: t.due_date }));
    await optimistic(
      () => { deferCandidates.forEach((t) => { t.due_date = addDaysToDate(todayStr(), 1); }); renderTodos(); },
      () => { prevList.forEach(({ t, due_date }) => { t.due_date = due_date; }); renderTodos(); },
      async () => {
        await Promise.all(
          deferCandidates.map((t) =>
            api(`/api/todos/${t.id}/due`, {
              method: "PUT",
              body: JSON.stringify({ due_date: t.due_date, due_time: t.due_time || null }),
            })
          )
        );
        loadCalendar();
      },
    );
  };
}

async function loadTodos() {
  allTodos = await api("/api/todos");
  renderTodos();
}

// 期限(due_date/due_time)を過ぎても未完了・未スキップのまま残っているToDoは、次にアプリを
// 開いた時に警告した上で自動的にスキップ扱いにする(いつまでも一覧に残り続けて埋もれるのを防ぐ)。
// isOverdue()は既にdone/skippedを除外しているので、ここでの対象はまだ手つかずの期限切れのみ。
// 戻り値はスキップした件数(呼び出し元が他の表示を取り直すかの判断に使う)
async function autoSkipOverdueTodos() {
  const overdue = allTodos.filter((t) => t.id != null && !t.done && !t.skipped && isOverdue(t));
  if (overdue.length === 0) return 0;
  alert(
    overdue.length === 1
      ? `期限切れのためスキップしました:\n・${overdue[0].title}`
      : `期限切れのため${overdue.length}件をスキップしました:\n${overdue.map((t) => `・${t.title}`).join("\n")}`
  );
  let anyRecurring = false;
  await Promise.allSettled(
    overdue.map((t) =>
      api(`/api/todos/${t.id}/skip?reason=overdue`, { method: "POST" })
        .then(() => {
          t.skipped = true;
          t.done = false;
          if (t.recurrence) anyRecurring = true;
        })
        .catch((err) => console.error("auto-skip failed:", err))
    )
  );
  // 繰り返しToDoは/skip側で次回分の行がサーバーに追加生成されるため、その分を拾うために再取得する
  if (anyRecurring) {
    loadTodos();
  } else {
    renderTodos();
  }
  loadTodoStats();
  return overdue.length;
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
    ${stats.missed ? `<p class="meta">${stats.missed} missed (overdue, counted as not done)</p>` : ""}
    ${stats.skipped ? `<p class="meta">${stats.skipped} skipped by choice (not counted)</p>` : ""}
    ${stats.daily.length ? `<p class="meta">Completions in the last 7 days</p>${barsHtml}` : ""}
  `;
}

async function loadTodoStats() {
  const stats = await api("/api/todos/stats");
  renderTodoStats(stats);
}

// ---------- ToDoタブ横の「今日の予定」「今日の勉強時間」(PC幅のみ表示, 2026-09-27) ----------
// PCではToDoが数件だと右側が空白だらけだったため、その日の行動に直結する情報で埋める。
// 予定は「始めるきっかけ」、科目別の勉強時間は「やった分がすぐ見えるごほうび」として置く。
async function loadTodayPanel() {
  const today = todayStr();
  const [y, m] = today.split("-").map(Number);
  const [eventsRes, dailyRes, progressRes] = await Promise.allSettled([
    api(`/api/events?year=${y}&month=${m}`),
    api("/api/study-logs/daily"),
    api("/api/study-logs/progress"),
  ]);
  renderTodaySchedule(eventsRes.status === "fulfilled" ? eventsRes.value.filter((e) => e.date === today) : null);
  renderTodayStudy(
    dailyRes.status === "fulfilled" ? dailyRes.value.filter((r) => r.d === today && r.total_minutes > 0) : null,
    progressRes.status === "fulfilled" ? progressRes.value : null,
  );
}

function renderTodaySchedule(events) {
  const el = document.getElementById("today-schedule");
  if (events === null) {
    el.innerHTML = `<p class="today-empty">Couldn't load events</p>`;
    return;
  }
  events.sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));
  el.innerHTML = `
    ${events.map((e, i) => `
      <button type="button" class="today-event" data-i="${i}">
        <span class="today-event-time">${e.start_time || "All day"}</span>
        <i style="background:${colorFor(e.category)}"></i>
        <span class="today-event-title">${escapeHtml(e.title)}</span>
      </button>`).join("") || `<p class="today-empty">No events today</p>`}
    <button type="button" class="link-btn" id="today-add-event">+ Add event</button>
  `;
  el.querySelectorAll(".today-event").forEach((btn) => {
    btn.addEventListener("click", () => openEventDetail(events[Number(btn.dataset.i)]));
  });
  el.querySelector("#today-add-event").addEventListener("click", () => {
    openEventAddPanel();
    document.getElementById("event-date").value = todayStr();
  });
}

function renderTodayStudy(rows, progress) {
  const el = document.getElementById("today-study");
  if (rows === null || progress === null) {
    el.innerHTML = `<p class="today-empty">Couldn't load study time</p>`;
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.total_minutes));
  el.innerHTML = `
    <div class="today-study-total">${progress.today_minutes} <span>${progress.daily_minimum_minutes ? `/ ${progress.daily_minimum_minutes} ` : ""}min</span></div>
    ${rows.map((r) => `
      <div class="today-study-row">
        <span class="today-study-subject">${escapeHtml(r.subject)}</span>
        <span class="today-study-bar"><i style="width:${(r.total_minutes / max) * 100}%;background:${colorFor(r.subject)}"></i></span>
        <span class="today-study-min">${r.total_minutes} min</span>
      </div>`).join("") || `<p class="today-empty">Nothing yet today</p>`}
  `;
}

document.getElementById("today-study").addEventListener("click", () => switchTab("tab-study"));

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

// preferCache: 起動時用。前回のカテゴリーが端末に残っていればそれで即描画して返り、
// 最新の取得は裏で続ける(起動処理全体がこの1往復を待たされないように、2026-09-28)。
// カテゴリーを編集した直後など、最新を確実に反映したい呼び出し元は従来通りawaitで待てる。
async function loadCategories({ preferCache = false } = {}) {
  if (preferCache) {
    const cached = await cacheGet("/api/categories");
    if (cached) {
      applyCategories(cached);
      api("/api/categories").then(applyCategories).catch((err) => console.error("categories refresh failed:", err));
      return;
    }
  }
  applyCategories(await api("/api/categories"));
}

// スマホ利用時間・ToDo達成率の計算に入るToDoか(main.pyのSTUDY_TODO_FILTERと同じ判定)
// カテゴリ未取得の間や、counts_as_study列が無い古いキャッシュでは印を出さない(誤って「Not counted」と出さないため)
function countsAsStudyTodo(t) {
  if (!allCategories.length) return true;
  const cat = allCategories.find((c) => c.name === t.category);
  if (!cat) return false;
  return cat.counts_as_study === undefined || !!cat.counts_as_study;
}

function applyCategories(cats) {
  allCategories = cats;

  categoryColorMap = {};
  cats.forEach((c, i) => {
    categoryColorMap[c.name] = CATEGORY_COLOR_PALETTE[i % CATEGORY_COLOR_PALETTE.length];
  });

  renderQuickSubjects(cats);
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
  // 追加・編集フォームは「カテゴリなし」を先頭(=初期値)に置く。選び忘れた生活ToDo(玉ねぎを買う等)が
  // 先頭のEnglish扱いになって勉強の達成率に混ざるのを防ぐため(2026-10-02)
  const noCategoryOption = `<option value="">No category</option>`;
  addSelect.innerHTML = noCategoryOption + optionsHtml;
  detailSelect.innerHTML = noCategoryOption + optionsHtml;
  filterSelect.innerHTML = `<option value="">Category: All</option>` + optionsHtml;
  addSelect.value = "";
  if (cats.some((c) => c.name === addCurrent)) addSelect.value = addCurrent;
  if (cats.some((c) => c.name === detailCurrent)) detailSelect.value = detailCurrent;
  filterSelect.value = filterCurrent;
  renderTodos(); // カテゴリの「Study」設定が変わると各ToDoの「Not counted」表示も変わるため
}

function renderCategoryItem(cat, list) {
  const li = document.createElement("li");
  li.innerHTML = `
    <input type="text" class="category-name-input" value="${escapeHtml(cat.name)}">
    <label class="checkbox-label" title="このカテゴリのToDoをスマホ利用時間・ToDo達成率の計算に含める">
      <input type="checkbox" class="category-study-toggle" ${cat.counts_as_study ? "checked" : ""}> Study
    </label>
    <button class="delete-btn" title="Delete">×</button>
  `;
  const input = li.querySelector(".category-name-input");
  const studyToggle = li.querySelector(".category-study-toggle");
  studyToggle.addEventListener("change", async () => {
    const prev = cat.counts_as_study;
    cat.counts_as_study = studyToggle.checked ? 1 : 0;
    renderTodos(); // 「Not counted」表示を即時に切り替える
    try {
      await api(`/api/categories/${cat.id}`, {
        method: "PUT",
        body: JSON.stringify({ counts_as_study: studyToggle.checked }),
      });
    } catch (err) {
      cat.counts_as_study = prev;
      studyToggle.checked = !!prev;
      renderTodos();
      showToast("設定の変更に失敗しました。もう一度お試しください");
    }
  });
  input.addEventListener("change", async () => {
    const newName = input.value.trim();
    if (!newName || newName === cat.name) {
      input.value = cat.name;
      return;
    }
    const oldName = cat.name;
    cat.name = newName; // 体感を即時にする。選択肢(todo-category等)の再構築はfinallyのloadCategoriesに任せる
    try {
      await api(`/api/categories/${cat.id}`, { method: "PUT", body: JSON.stringify({ name: newName }) });
      loadTodos();
    } catch (err) {
      cat.name = oldName;
      showToast("カテゴリ名の変更に失敗しました。もう一度お試しください");
    } finally {
      loadCategories();
    }
  });
  li.querySelector(".delete-btn").addEventListener("click", async () => {
    // 科目ボタン・フィルターから丸ごと消えるので、設定画面での押し間違いに備えて確認を挟む(2026-09-27)
    if (!confirm(`Delete the category "${cat.name}"?`)) return;
    const idx = allCategories.indexOf(cat);
    li.remove();
    if (idx !== -1) allCategories.splice(idx, 1);
    try {
      await api(`/api/categories/${cat.id}`, { method: "DELETE" });
    } catch (err) {
      showToast("削除に失敗しました。もう一度お試しください");
    } finally {
      loadCategories();
    }
  });
  list.appendChild(li);
}

guardedSubmit(document.getElementById("category-form"), async (e) => {
  const name = document.getElementById("category-name").value.trim();
  if (!name) return;
  document.getElementById("category-name").value = "";
  try {
    await api("/api/categories", { method: "POST", body: JSON.stringify({ name }) });
  } catch (err) {
    document.getElementById("category-name").value = name;
    showToast(`「${name}」の追加に失敗しました。もう一度お試しください`);
  } finally {
    loadCategories();
  }
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
  const category = document.getElementById("todo-category").value || null;
  const priority = document.getElementById("todo-priority").value;
  const due_date = document.getElementById("todo-due-date").value || null;
  const due_time = document.getElementById("todo-due-time").value || null;
  const notifyVal = document.getElementById("todo-notify").value;
  const notify_offset_minutes = due_time && notifyVal !== "" ? parseInt(notifyVal, 10) : null;
  const recurrence =
    selectedRecurrenceDays.size > 0 ? WEEKDAY_ORDER.filter((d) => selectedRecurrenceDays.has(d)).join(",") : null;
  const note = document.getElementById("todo-note").value.trim() || null;
  if (!title) return;
  const payload = { title, category, priority, due_date, due_time, recurrence, notify_offset_minutes, note };
  // 保存を待たずフォームを閉じる(「受け付けた」感を即座に出す)。保存自体はこの後裏で進む
  document.getElementById("todo-title").value = "";
  document.getElementById("todo-category").value = ""; // 毎回「カテゴリなし」に戻す(前回の科目を引き継がない)
  document.getElementById("todo-due-date").value = "";
  document.getElementById("todo-due-time").value = "";
  document.getElementById("todo-due-time").style.display = "none";
  document.getElementById("todo-notify").value = "";
  document.getElementById("todo-notify").style.display = "none";
  document.getElementById("todo-note").value = "";
  document.getElementById("todo-time-toggle").textContent = "+ Add time";
  setRecurrenceDays([]);
  closeTodoAddPanel();
  // 保存と一覧の取り直しを待たず、仮の行として先に一覧へ出す(2026-09-29)
  const tempTodo = {
    ...payload, id: null, done: 0, skipped: 0, created_at: null, completed_at: null,
    notified_at: null, skipped_at: null, skip_reason: null,
  };
  allTodos = [tempTodo, ...allTodos];
  renderTodos();
  try {
    await api("/api/todos", { method: "POST", body: JSON.stringify(payload) });
    loadTodos();
  } catch (err) {
    allTodos = allTodos.filter((t) => t !== tempTodo);
    renderTodos();
    showToast(`「${title}」の追加に失敗しました。もう一度お試しください`);
  }
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
  document.getElementById("todo-detail-reschedule").classList.toggle("hidden", !canReschedule(t));
  const skipBtn = document.getElementById("todo-detail-skip");
  skipBtn.classList.toggle("hidden", !!t.done);
  skipBtn.textContent = t.skipped ? "Unskip" : "Skip";
  document.getElementById("todo-detail-panel").classList.remove("hidden");
  document.getElementById("todo-detail-backdrop").classList.remove("hidden");
}

function closeTodoDetail() {
  document.getElementById("todo-detail-panel").classList.add("hidden");
  document.getElementById("todo-detail-backdrop").classList.add("hidden");
  currentDetailTodoId = null;
}

document.getElementById("todo-detail-close").addEventListener("click", closeTodoDetail);

function currentDetailTodo() {
  return allTodos.find((x) => x.id === currentDetailTodoId);
}

document.querySelectorAll("[data-detail-reschedule]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const t = currentDetailTodo();
    if (!t) return;
    closeTodoDetail();
    rescheduleTodo(t, btn.dataset.detailReschedule);
  });
});

document.getElementById("todo-detail-skip").addEventListener("click", () => {
  const t = currentDetailTodo();
  if (!t) return;
  closeTodoDetail();
  toggleTodoSkip(t);
});

document.getElementById("todo-detail-delete").addEventListener("click", () => {
  const t = currentDetailTodo();
  if (!t) return;
  closeTodoDetail();
  deleteTodo(t);
});
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
  const payload = { title, category, priority, due_date, due_time, recurrence, notify_offset_minutes, note };
  const todoId = currentDetailTodoId;
  const t = allTodos.find((x) => x.id === todoId);
  const prev = t ? { ...t } : null;
  document.getElementById("todo-detail-status").textContent = "Saved";
  closeTodoDetail();
  await optimistic(
    () => { if (t) { Object.assign(t, payload); renderTodos(); } },
    () => { if (t && prev) { Object.assign(t, prev); renderTodos(); } },
    async () => {
      await api(`/api/todos/${todoId}`, { method: "PUT", body: JSON.stringify(payload) });
      loadCalendar();
    },
  );
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- study logs ----------

// ⚡メニューの「Study」に科目を並べる(2026-10-02)。以前はStudyタブ上部の科目ボタンと
// 右下▶のミニメニューの2か所にあったが、記録の入口を⚡1か所にまとめたため、ここだけにした
function renderQuickSubjects(cats) {
  const container = document.getElementById("quick-subjects");
  container.innerHTML = cats
    .map(
      (c) =>
        `<button type="button" class="subject-btn" data-subject="${escapeHtml(c.name)}" style="--subject-color:${colorFor(c.name)}">${escapeHtml(c.name)}</button>`
    )
    .join("");
  container.querySelectorAll(".subject-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeQuickPanel();
      openStartPanel(btn.dataset.subject, null);
    });
  });
}

function localDatetimeNow() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

function nowLocalTimestamp() {
  return `${localDatetimeNow().replace("T", " ")}:00`; // "YYYY-MM-DD HH:MM:SS"
}

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
  // 前回その科目で選んだモード・時間・チェック項目を復元する(毎回選び直す手間を省く、2026-09-27)。
  // 「きっかけ」は毎回その時の理由を記録するためのものなので、あえて復元しない
  const prefs = loadStartPrefs(subject);
  setStartMode(prefs.mode);
  document.getElementById("start-duration-input").value = prefs.minutes;
  document.getElementById("start-clockonly").checked = prefs.clockOnly;
  document.getElementById("start-keep-awake").checked = prefs.keepAwake;
  document.getElementById("start-reset-on-reopen").checked = prefs.resetOnReopen;
  startTrigger = null;
  document.querySelectorAll("#start-trigger-picker .reason-btn").forEach((b) => {
    b.classList.remove("active");
  });
  startBackdrop.classList.remove("hidden");
  startPanel.classList.remove("hidden");
  // パネル内にフォーカスがないと下のEnter→Startが効かない(キーイベントがパネルに届かない)ため
  document.getElementById("start-begin-btn").focus({ preventScroll: true });
}

function closeStartPanel() {
  pendingStart = null;
  startBackdrop.classList.add("hidden");
  startPanel.classList.add("hidden");
}

document.getElementById("start-close").addEventListener("click", closeStartPanel);
startBackdrop.addEventListener("click", closeStartPanel);

// 端末ごとの使い勝手の記憶なのでlocalStorageで十分(画面スリープ防止などは端末によって欲しい値が違う)
const START_PREFS_KEY = "startPrefs";
const DEFAULT_START_PREFS = { mode: "countup", minutes: 25, clockOnly: false, keepAwake: false, resetOnReopen: false };

function loadStartPrefs(subject) {
  try {
    const all = JSON.parse(localStorage.getItem(START_PREFS_KEY) || "{}");
    return { ...DEFAULT_START_PREFS, ...(all[subject] || {}) };
  } catch {
    return { ...DEFAULT_START_PREFS };
  }
}

function saveStartPrefs(subject, prefs) {
  try {
    const all = JSON.parse(localStorage.getItem(START_PREFS_KEY) || "{}");
    all[subject] = prefs;
    localStorage.setItem(START_PREFS_KEY, JSON.stringify(all));
  } catch {
    // 保存できなくても開始自体は続ける
  }
}

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
  const resetOnReopen = document.getElementById("start-reset-on-reopen").checked;
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
  saveStartPrefs(subject, {
    mode: startMode,
    minutes: parseInt(document.getElementById("start-duration-input").value, 10) || DEFAULT_START_PREFS.minutes,
    clockOnly,
    keepAwake,
    resetOnReopen,
  });
  closeStartPanel();
  beginSession(subject, todoId, startMode, targetMs, clockOnly, trigger, keepAwake, resetOnReopen);
});

// このパネルが開いている間はEnterでStartを押したことにする(数値入力にフォーカスがあっても同様)
startPanel.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  document.getElementById("start-begin-btn").click();
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
// user-selected "reset to 0:00 instead of restoring elapsed time" option. Applied both on a real
// page reload (restoreSession(), below) and on returning from the background (visibilitychange,
// near pauseSession()) — a reload alone isn't enough in practice, since switching to another app
// and back rarely reloads the page at all (the browser/PWA process just stays alive).
let sessionResetOnReopen = false;
let lastResetOnReopenAt = 0; // debounce: avoid a double reset+toast if both triggers fire close together
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

// pause/resumeを別デバイス側の表示(下のpeer-session-banner、およびFocusGuardの常駐バッジ)に
// 伝える。syncSessionActiveFlag()のactiveはpause中もtrueのまま保つ(ブロック維持のため)ので、
// 「pause中かどうか」自体はこちらで別に送る。elapsedMsはpause/resumeを押した瞬間の
// currentElapsedMs()(pause中はaccumulatedMsそのもの)。
// pause(true)はclock-onlyセッションのvisibilitychangeハンドラ(バックグラウンド移行の瞬間)から
// 同期的に呼ばれる = ページが送信途中で破棄されうるタイミングと重なる。keepaliveなしだと
// このfetchが送信完了前にタブ/PWAが閉じられて失われ、サーバー側はsession_paused=falseのまま
// 残り、peer-session-bannerが「Paused」ではなく経過時間表示のまま延々スタックする
// (syncSessionActiveFlagで既に対策済みの同じバグ系統、2026-09-07に発現を確認)。
function syncFocusSessionPause(paused, elapsedMs) {
  api("/api/focus-session/pause", {
    method: "POST",
    body: JSON.stringify({ paused, elapsed_ms: Math.round(elapsedMs) }),
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
let peerSessionPaused = false;

function updatePeerSessionBanner() {
  const banner = document.getElementById("peer-session-banner");
  const label = document.getElementById("peer-session-banner-label");
  if (!peerSessionStartedAt) {
    banner.classList.add("hidden");
    return;
  }
  const subjectText = peerSessionSubject ? ` · ${peerSessionSubject}` : "";
  // paused中はstarted_atからの単純経過計算が実時間とズレていく(pause中も時計が動き続ける
  // ため)ので、経過分数を出さず止まっていることが分かる表示に切り替える。resumeされると
  // サーバー側がstarted_atを巻き戻してくれる(main.py focus_session_pause参照)ので、次の
  // ポーリングで元の経過分数表示に自然に戻る。
  if (peerSessionPaused) {
    label.innerHTML = `${ICONS.clock}${peerSessionSubject || "Studying"} · Paused`;
    banner.classList.remove("hidden");
    return;
  }
  const elapsedMin = Math.max(0, Math.floor((Date.now() - peerSessionStartedAt.getTime()) / 60000));
  label.innerHTML = `${ICONS.clock}${peerSessionSubject || "Studying"} · ${formatLogDuration(elapsedMin)}`;
  banner.title = `Studying now on another device${subjectText}`;
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
    peerSessionPaused = !!status.paused;
    // Unlike other timestamps in this app (which the client writes in its own local time via
    // nowLocalTimestamp()), session_started_at is written server-side by main.py's datetime.now()
    // - i.e. the server's (UTC) clock, not this device's local time. Parsing it the same way as
    // those client-local strings double-counted this device's UTC offset as elapsed time (e.g.
    // NZ's UTC+12 showed up as a phantom +12h on top of the real elapsed minutes). Appending "Z"
    // tells Date() to parse it as UTC instead of local time.
    // ↑の"Z"方式はサーバーがUTCで動くRender前提で、ローカル運用(PCがNZ時間)では経過が常に0分になっていた。
    // サーバーが経過秒数(elapsed_seconds)を返す場合はそれを優先する(2026-09-27)
    if (typeof status.elapsed_seconds === "number") {
      peerSessionStartedAt = new Date(Date.now() - status.elapsed_seconds * 1000);
    } else {
      peerSessionStartedAt = status.started_at ? new Date(status.started_at.replace(" ", "T") + "Z") : new Date();
    }
    if (!peerSessionTickInterval) {
      peerSessionTickInterval = setInterval(updatePeerSessionBanner, 30000);
    }
  } else {
    peerSessionStartedAt = null;
    peerSessionPaused = false;
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
      sessionResetOnReopen,
      sessionCompleted,
      overlayMinimized,
      sessionStartTrigger,
    })
  );
}

// Shared by restoreSession() (a genuine page reload) and the visibilitychange handler below
// (returning from the background without a reload — by far the more common "reopen" in practice,
// e.g. switching to another app and back). Resets elapsed time to 0 while keeping the same
// subject/session running, re-arms the countdown push-notification tracking, and toasts about it.
function applyResetOnReopenIfNeeded() {
  if (!sessionResetOnReopen || !timerSubject) return false;
  const now = Date.now();
  if (now - lastResetOnReopenAt < 2000) return false; // both triggers landing together shouldn't double-fire
  lastResetOnReopenAt = now;
  accumulatedMs = 0;
  segmentStart = isPaused ? null : now;
  sessionCompleted = false;
  persistSession();
  if (sessionMode === "countdown") {
    syncFocusSessionServer(isPaused ? null : Math.round(sessionTargetMs / 1000), timerSubject);
  }
  updateFocusDisplay();
  showToast("タイマーをリセットしました");
  return true;
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
  sessionResetOnReopen = !!saved.sessionResetOnReopen;
  sessionCompleted = !!saved.sessionCompleted;
  overlayMinimized = saved.overlayMinimized;
  sessionStartTrigger = saved.sessionStartTrigger || null;

  applyResetOnReopenIfNeeded();

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

function beginSession(subject, todoId, mode, targetMs, clockOnly, trigger, keepAwake, resetOnReopen) {
  timerSubject = subject;
  activeTodoId = todoId;
  accumulatedMs = 0;
  segmentStart = Date.now();
  isPaused = false;
  sessionMode = mode;
  sessionTargetMs = targetMs;
  sessionClockOnly = clockOnly;
  sessionKeepAwake = !!keepAwake;
  sessionResetOnReopen = !!resetOnReopen;
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
  document.getElementById("mini-timer-subject").textContent = timerSubject;
  bar.style.setProperty("--subject-color", colorFor(timerSubject));
  updateMiniStatus();
  updateFocusDisplay();
  positionMiniBar();
}

// 下部タブバーはスマホ幅でだけ表示されるので、その高さは表示中にウィンドウ幅が変わると変わる。
// 以前は表示した瞬間の高さを固定していたため、狭いウィンドウで開始してから広げると、
// PC表示で消えたタブバーの分(約53px)だけバーの下に隙間が残っていた(2026-09-27)。
// 2026-10-02からはミニタイマーバーを睡眠・サボりの帯と一緒にnow-dockへ積み、dockごと動かす。
// 高さはCSS変数にも入れ、本文の下余白・トースト・⚡メニューの位置がそれを参照する
function positionNowDock() {
  const tabbarH = document.getElementById("tabbar").getBoundingClientRect().height;
  const dock = document.getElementById("now-dock");
  dock.style.bottom = `${tabbarH}px`;
  const root = document.documentElement.style;
  root.setProperty("--tabbar-h", `${tabbarH}px`);
  root.setProperty("--dock-h", `${dock.getBoundingClientRect().height}px`);
}

function positionMiniBar() {
  positionNowDock();
}

window.addEventListener("resize", positionNowDock);

function hideMiniBar() {
  document.getElementById("mini-timer-bar").classList.add("hidden");
  positionNowDock();
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
  // let other devices (peer banner / FocusGuard badge) know this session is paused, since
  // session_active itself intentionally stays "on" through a pause (see syncSessionActiveFlag).
  syncFocusSessionPause(true, accumulatedMs);
  // stop server-side tracking while paused, since the countdown isn't actually progressing;
  // resumeSession() re-arms it with the recomputed remaining time.
  if (sessionMode === "countdown" && !sessionCompleted) {
    syncFocusSessionServer(null, null);
  }
}

function resumeSession() {
  if (!timerSubject || !isPaused) return;
  // accumulatedMs is still the correct total elapsed time here (segmentStart is null while
  // paused, so nothing needs to be added) - tell other devices' displays to catch up before
  // flipping segmentStart back on below.
  syncFocusSessionPause(false, accumulatedMs);
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
  } else {
    // coming back from the background (switching to another app, unlocking the phone, ...) is
    // the realistic "reopening the timer" case in practice — a genuine page reload (handled by
    // restoreSession() at boot) is much rarer, since the browser/PWA process usually just stays
    // alive while backgrounded.
    applyResetOnReopenIfNeeded();
    if (timerSubject && (sessionClockOnly || sessionKeepAwake) && !isPaused) {
      requestWakeLock();
    }
    // the peer-session-banner's own setInterval keeps running while this tab is hidden, but
    // background tabs get their timers throttled (sometimes to once a minute or more) or
    // fully frozen by the browser, so a peer session that ended while this tab was in the
    // background could sit stale on screen for a long time after switching back. Force an
    // immediate re-check here so returning to the tab never shows outdated "studying now" info.
    checkPeerSession();
    refreshIfDayChanged();
    flushPendingStudyLogs();
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

// ---------- 未送信の学習記録(finishSessionの保険) ----------
// 記録の送信は通常のfetchなので、Stop直後にPWAを閉じる/サーバーが一時的に応答しないと
// 失われうる(終了フラグの方はkeepaliveで届くため「セッションは終わったのに記録が無い」になる)。
// 送る前に端末へ控え、届いたら消す。届かなかった分は起動時・アプリに戻った時に再送する。
const PENDING_STUDY_LOGS_KEY = "pendingStudyLogs";

function readPendingStudyLogs() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_STUDY_LOGS_KEY) || "[]");
  } catch {
    return [];
  }
}

function writePendingStudyLogs(list) {
  try {
    if (list.length) localStorage.setItem(PENDING_STUDY_LOGS_KEY, JSON.stringify(list));
    else localStorage.removeItem(PENDING_STUDY_LOGS_KEY);
  } catch {
    // 保存できない環境でも送信自体は続ける
  }
}

function addPendingStudyLog(log) {
  writePendingStudyLogs([...readPendingStudyLogs(), log]);
}

function removePendingStudyLog(log) {
  writePendingStudyLogs(
    readPendingStudyLogs().filter(
      (x) => !(x.subject === log.subject && x.minutes === log.minutes && x.logged_at === log.logged_at)
    )
  );
}

// dedupe:true = 「実は前回届いていたが応答だけ失われた」ケースで再送しても二重登録しない
// (同じ科目・分数・記録時刻の行が既にあればサーバー側で既存行を返す、main.py参照)
async function sendPendingStudyLog(log) {
  const result = await api("/api/study-logs", {
    method: "POST",
    body: JSON.stringify({ ...log, dedupe: true }),
    keepalive: true,
  });
  removePendingStudyLog(log);
  return result;
}

let flushingPendingStudyLogs = false;
async function flushPendingStudyLogs() {
  if (flushingPendingStudyLogs) return;
  const list = readPendingStudyLogs();
  if (!list.length) return;
  flushingPendingStudyLogs = true;
  let sent = 0;
  try {
    for (const log of list) {
      try {
        await sendPendingStudyLog(log);
        sent++;
      } catch {
        // 次の機会に再送
      }
    }
  } finally {
    flushingPendingStudyLogs = false;
  }
  if (sent) {
    showToast(`未送信だった学習記録を${sent}件保存しました`);
    loadStudySummary();
    loadStudyLogList();
    loadStudyChart();
    loadActivityHeatmap();
    loadGoalProgress();
    loadTodayPanel();
  }
}

// ---------- 学習記録の先行反映(2026-09-29) ----------
// Stop直後、サーバーの返事を待たずに「今日の時間」・グラフ・サマリー・一覧・ヒートマップへ終えた分を足す。
// 各表示は端末キャッシュ(apiCachedが使うもの)から描かれるので、キャッシュ側を書き換えてから描き直す。
// こうしておくと、この後のapiCachedが最初にキャッシュで描く時も足した後の数字が出る(古い数字に戻らない)。
// キャッシュが無い項目(一度も開いていない表示)は何もしない。
async function patchCachedAndRender(path, patch, render) {
  const data = await cacheGet(path);
  if (data === undefined) return undefined;
  let next;
  try {
    next = patch(data);
  } catch (err) {
    console.error(`local patch failed: ${path}`, err);
    return undefined;
  }
  await cacheSet(path, next);
  try {
    render(next);
  } catch (err) {
    console.error(`local render failed: ${path}`, err);
  }
  return next;
}

function addToSubjectRow(rows, keyName, keyValue, subject, minutes) {
  const copy = rows.map((r) => ({ ...r }));
  const row = copy.find((r) => r[keyName] === keyValue && r.subject === subject);
  if (row) row.total_minutes += minutes;
  else copy.push({ [keyName]: keyValue, subject, total_minutes: minutes });
  return copy;
}

// 全部の書き換えが終わってから返す(finishSessionはこれを待ってから再読み込みを始める。
// 先に再読み込みが走ると、サーバーの最新で描いた直後に古いキャッシュ+αで上書きしかねないため)
async function applyStudyLogLocally(log) {
  const { subject, minutes } = log;
  if (!minutes) return;
  const day = log.logged_at.slice(0, 10);
  const weekStart = formatLocalDate(mondayOfDate(new Date(`${day}T00:00:00`)));
  const heatmapPath = `/api/study-logs/heatmap?days=${HEATMAP_WEEKS * 7 + 7}`;

  const [progress, daily] = await Promise.all([
    patchCachedAndRender(
      "/api/study-logs/progress",
      (p) => ({
        ...p,
        today_minutes: p.today_minutes + minutes,
        week_minutes: p.week_minutes + minutes,
        month_minutes: p.month_minutes + minutes,
        total_minutes: p.total_minutes + minutes,
      }),
      renderGoalProgress,
    ),
    patchCachedAndRender(
      dailyChartPath(studyChartDays()),
      (rows) => addToSubjectRow(rows, "d", day, subject, minutes),
      (rows) => { if (chartGranularity === "day") renderDailyChart(rows, studyChartDays()); },
    ),
    patchCachedAndRender(
      "/api/study-logs/weekly",
      (rows) => addToSubjectRow(rows, "week_start", weekStart, subject, minutes),
      (rows) => { if (chartGranularity !== "day") renderWeeklyChart(rows); },
    ),
    patchCachedAndRender(
      "/api/study-logs/summary",
      (rows) => {
        const copy = rows.map((r) => ({ ...r }));
        const row = copy.find((r) => r.subject === subject);
        if (row) row.total_minutes += minutes;
        else copy.push({ subject, total_minutes: minutes });
        return copy;
      },
      renderStudySummary,
    ),
    patchCachedAndRender(
      "/api/study-logs",
      (logs) => [{
        id: null, subject, minutes, note: log.note, logged_at: log.logged_at,
        start_trigger: log.start_trigger, count: null, unit: null, page_start: null, page_end: null,
      }, ...logs],
      renderStudyLogList,
    ),
    patchCachedAndRender(
      heatmapPath,
      (rows) => {
        const copy = rows.map((r) => ({ ...r }));
        const row = copy.find((r) => r.date === day);
        if (row) row.compass_minutes += minutes;
        else copy.push({ date: day, vocab_minutes: 0, drill_count: 0, compass_minutes: minutes, stack_minutes: 0 });
        return copy;
      },
      (rows) => {
        const byDate = {};
        rows.forEach((row) => { byDate[row.date] = row; });
        renderActivityHeatmap(byDate);
      },
    ),
  ]);
  // ToDoタブ横の「今日の勉強時間」はdailyとprogressの両方から描く
  if (progress && daily) {
    try {
      renderTodayStudy(daily.filter((r) => r.d === day && r.total_minutes > 0), progress);
    } catch (err) {
      console.error("local render failed: today study", err);
    }
  }
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
  // ToDoから開始したセッションは、後で「タスク完了にする?」にNoと答えても
  // 何を勉強したか(ToDoのタイトル)がログに残るよう、resetSessionState()でactiveTodoIdが
  // 消える前にタイトルを控えておく
  const linkedTodo = todoId ? allTodos.find((x) => x.id === todoId) : null;
  // resetSessionState()はlocalStorageのセッション本体を消すので、その前に「未送信の記録」として
  // 端末に控えておく。Stop直後にPWAを閉じて送信が打ち切られても、次回起動時に再送される
  // (2026-09-28、英語セッションが終了フラグだけ届いて記録本体が消えた件への対策)
  const pending = {
    subject,
    minutes: elapsedMinutes,
    note: linkedTodo ? linkedTodo.title : null,
    logged_at: `${localDatetimeNow().replace("T", " ")}:00`,
    start_trigger: startTrigger,
  };
  addPendingStudyLog(pending);
  resetSessionState();
  // タイマー画面はresetSessionState()で既に閉じている(体感即時)。ここから先の保存は裏で進める
  const logPromise = sendPendingStudyLog(pending).catch(() =>
    showToast(`「${subject}」の記録を送れませんでした。端末に保存したので次回起動時に再送します`)
  );
  // サーバーの保存と再集計を待つと表示が変わるまで数秒〜十数秒かかるため、終えた分を手元の
  // 表示に先に足しておく。正しい数字はこの後の再読み込みで上書きされる(2026-09-29)
  const localApplyPromise = applyStudyLogLocally(pending).catch((err) => console.error("local apply failed", err));
  if (todoId && confirm("Mark this task complete?")) {
    const t = allTodos.find((x) => x.id === todoId);
    if (t) {
      toggleTodoDone(t); // 内部で楽観的に即時反映+裏で保存(失敗時は自動でロールバック)
    } else {
      api(`/api/todos/${todoId}/toggle`, { method: "POST" }).then(() => { loadTodos(); loadTodoStats(); });
    }
  }
  await localApplyPromise;
  await logPromise;
  loadStudySummary();
  loadStudyLogList();
  loadStudyChart();
  loadActivityHeatmap();
  loadHourlyChart();
  loadGoalProgress();
  loadScreenBudget(); // 学習分がスマホ利用予算のボーナスに反映されるため
  loadTodayPanel();
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

async function stopAndSaveSession() {
  if (!timerSubject) return;
  const totalMs = currentElapsedMs();
  const elapsedMinutes = Math.max(1, Math.round(totalMs / 60000));
  await finishSession(elapsedMinutes);
}

document.getElementById("focus-stop-btn").addEventListener("click", stopAndSaveSession);
document.getElementById("mini-stop-btn").addEventListener("click", stopAndSaveSession);

document.getElementById("focus-discard-btn").addEventListener("click", discardSession);
document.getElementById("mini-discard-btn").addEventListener("click", discardSession);

// ---------- daily / weekly chart ----------

const WEEKLY_CHART_WEEKS = 10;

let chartGranularity = localStorage.getItem("studyChartGranularity") === "day" ? "day" : "week";

// 広いPC幅(style.cssの.study-dashが2列になる1280px以上)では、Day表示を28日分にして
// グラフも横長すぎない縦横比で描く。右側の余白をなくした分、棒を増やせるため(2026-10-02)
const STUDY_WIDE_MQ = window.matchMedia("(min-width: 1280px)");
function studyChartDays() {
  return STUDY_WIDE_MQ.matches ? 28 : 14;
}

function last14Dates() {
  return lastNDates(14);
}

function lastNDates(n) {
  const dates = [];
  for (let i = n - 1; i >= 0; i--) {
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

const HEATMAP_WEEKS = 18; // 直近18週分(約4ヶ月)。GitHub contribution graph相当

async function loadActivityHeatmap() {
  await apiCached(`/api/study-logs/heatmap?days=${HEATMAP_WEEKS * 7 + 7}`, (raw) => {
    const byDate = {};
    raw.forEach((row) => { byDate[row.date] = row; });
    renderActivityHeatmap(byDate);
  });
}

// 3アプリ(Compass純正/vocab-app/drill-tracker)分の活動を1マス=1日のGitHub風グリッドで表示。
// 「今日やったこと」を1画面で明白にするのが狙いなので、内訳ではなく合計の強度だけで色分けする。
function renderActivityHeatmap(byDate) {
  const container = document.getElementById("activity-heatmap");
  const today = new Date();
  const startMonday = mondayOfDate(today);
  startMonday.setDate(startMonday.getDate() - (HEATMAP_WEEKS - 1) * 7);

  const weeks = [];
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(startMonday);
      date.setDate(date.getDate() + w * 7 + d);
      days.push(date);
    }
    weeks.push(days);
  }

  const scoreOf = (row) => {
    if (!row) return 0;
    return row.compass_minutes + row.vocab_minutes + (row.stack_minutes ?? 0) + row.drill_count * 3; // drillは1問≒3分相当の重み付け目安
  };
  const maxScore = Math.max(1, ...Object.values(byDate).map(scoreOf));

  const levelOf = (score) => {
    if (score <= 0) return 0;
    const ratio = score / maxScore;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };

  const cols = weeks
    .map((days) => {
      const cells = days
        .map((date) => {
          if (date > today) return `<div class="heatmap-cell heatmap-cell-empty"></div>`;
          const iso = formatLocalDate(date);
          const row = byDate[iso];
          const level = levelOf(scoreOf(row));
          return `<div class="heatmap-cell" data-level="${level}" data-date="${iso}" title="${iso}"></div>`;
        })
        .join("");
      return `<div class="heatmap-col">${cells}</div>`;
    })
    .join("");

  container.innerHTML = `<div class="heatmap-grid">${cols}</div>`;

  container.querySelectorAll(".heatmap-cell[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => {
      const iso = cell.dataset.date;
      const row = byDate[iso];
      const parts = [];
      if (row?.compass_minutes) parts.push(`Compass ${row.compass_minutes}min`);
      if (row?.vocab_minutes) parts.push(`Vocab ${row.vocab_minutes}min`);
      if (row?.stack_minutes) parts.push(`Cards ${row.stack_minutes}min`);
      if (row?.drill_count) parts.push(`Drill ${row.drill_count} problems`);
      document.getElementById("activity-heatmap-detail").textContent =
        parts.length ? `${iso}: ${parts.join(" / ")}` : `${iso}: no activity`;
    });
  });
}

async function loadStudyChart() {
  if (chartGranularity === "day") {
    await loadDailyChart();
  } else {
    await loadWeeklyChart();
  }
}

// 前回キャッシュの描画が遅れて届いた時に、既に切り替え済みの日/週グラフを上書きしないためのガード
// 14日分はほかの場所(「今日の勉強時間」パネル等)と同じURLのままにして、通信とキャッシュを共有する
function dailyChartPath(days) {
  return days === 14 ? "/api/study-logs/daily" : `/api/study-logs/daily?days=${days}`;
}

async function loadDailyChart() {
  const days = studyChartDays();
  await apiCached(dailyChartPath(days), (raw) => {
    if (chartGranularity === "day" && days === studyChartDays()) renderDailyChart(raw, days);
  });
}

function renderDailyChart(raw, days = studyChartDays()) {
  const dates = lastNDates(days);
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
  await apiCached("/api/study-logs/weekly", (raw) => {
    if (chartGranularity !== "day") renderWeeklyChart(raw);
  });
}

function renderWeeklyChart(raw) {
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
  // 2列表示では左の列が広いので、スマホ用の横長な比率のままだと縦に低すぎる(右の列だけ長くなる)
  const wide = STUDY_WIDE_MQ.matches;
  const chartW = wide ? 480 : 320;
  const chartH = wide ? 308 : 130;
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
    chartGranularity === "day" ? `Last ${studyChartDays()} days` : `Last ${WEEKLY_CHART_WEEKS} weeks`;
}

// ウィンドウ幅が1280pxをまたいだら、日数と縦横比を合わせて描き直す
STUDY_WIDE_MQ.addEventListener("change", () => {
  updateChartTitle();
  loadStudyChart();
  loadHourlyChart();
});

// 以前は".period-btn"全部に付けていたため、Mood・Scores等の別の切り替えを押すと日/週グラフが週に戻り、
// ほかの切り替えの選択表示も消えていた(2026-09-30修正)。Week/Dayのボタンだけを対象にする
document.querySelectorAll(".period-btn[data-granularity]").forEach((btn) => {
  btn.classList.toggle("active", btn.dataset.granularity === chartGranularity);
  btn.addEventListener("click", () => {
    chartGranularity = btn.dataset.granularity;
    localStorage.setItem("studyChartGranularity", chartGranularity);
    document.querySelectorAll(".period-btn[data-granularity]").forEach((b) => b.classList.toggle("active", b === btn));
    updateChartTitle();
    loadStudyChart();
  });
});

updateChartTitle();

// ---------- time of day (2026-09-30、Ankiの「時間帯の分析」相当) ----------
// 「一番勉強できている時間帯」を見える化し、次の勉強をその時間に置くきっかけにする。
// 棒は3アプリ合計の勉強時間。一番多い連続2時間を濃い色にして上に一言で出す

let hourlyDays = [30, 90, 365].includes(Number(localStorage.getItem("hourlyChartDays")))
  ? Number(localStorage.getItem("hourlyChartDays"))
  : 30;

async function loadHourlyChart() {
  const days = hourlyDays;
  await apiCached(`/api/study-logs/hourly?days=${days}`, (raw) => {
    if (days === hourlyDays) renderHourlyChart(raw.minutes, days);
  });
}

function hourRangeLabel(start, length) {
  const pad = (h) => `${String(h % 24).padStart(2, "0")}:00`;
  return `${pad(start)}–${pad(start + length)}`;
}

function renderHourlyChart(minutes, days) {
  const container = document.getElementById("hourly-chart");
  const bestEl = document.getElementById("hourly-best");
  const total = minutes.reduce((s, m) => s + m, 0);
  const periodLabel = { 30: "last month", 90: "last 3 months", 365: "last year" }[days];

  // 日付をまたぐ23時〜0時も1つの枠として数える
  let bestStart = 0;
  let bestSum = -1;
  for (let h = 0; h < 24; h++) {
    const sum = minutes[h] + minutes[(h + 1) % 24];
    if (sum > bestSum) {
      bestSum = sum;
      bestStart = h;
    }
  }
  const inBest = (h) => total > 0 && (h === bestStart || h === (bestStart + 1) % 24);
  bestEl.textContent = total > 0
    ? `Most study: ${hourRangeLabel(bestStart, 2)} · ${Math.round((bestSum / total) * 100)}% of your study time in the ${periodLabel}`
    : `No study recorded in the ${periodLabel}`;

  const maxMin = Math.max(60, ...minutes);
  // 2列表示の左の列はスマホより広く、同じviewBoxのままだと文字ごと2倍以上に拡大されて縦にも間延びする
  const wide = STUDY_WIDE_MQ.matches;
  const chartW = wide ? 480 : 320;
  const chartH = wide ? 130 : 120;
  const padLeft = 26;
  const padTop = 9;
  const padBottom = 14;
  const plotW = chartW - padLeft - 2;
  const plotH = chartH - padTop - padBottom;
  const barGap = 2;
  const barW = plotW / 24 - barGap;

  const gridLines = [0, 0.5, 1]
    .map((frac) => {
      const y = padTop + plotH - plotH * frac;
      const label = Math.round(((maxMin * frac) / 60) * 10) / 10;
      return `
        <line x1="${padLeft}" y1="${y}" x2="${chartW}" y2="${y}" stroke="var(--border)" stroke-width="1" />
        <text x="${padLeft - 4}" y="${y + 3}" font-size="8" fill="var(--text-muted)" text-anchor="end">${label}h</text>
      `;
    })
    .join("");

  const bars = minutes
    .map((m, h) => {
      const x = padLeft + h * (barW + barGap);
      const barH = (m / maxMin) * plotH;
      const label = h % 3 === 0
        ? `<text x="${x + barW / 2}" y="${chartH - 1}" font-size="8" fill="var(--text-muted)" text-anchor="middle">${h}</text>`
        : "";
      // 0分の時間帯もタップできるよう、透明な当たり判定を棒の高さに関係なく全面に敷く
      return `
        <rect x="${x}" y="${padTop + plotH - barH}" width="${Math.max(barW, 0)}" height="${Math.max(barH, 0)}"
          fill="var(--accent)" opacity="${inBest(h) ? 1 : 0.4}" rx="2"></rect>
        <rect x="${x}" y="${padTop}" width="${barW + barGap}" height="${plotH}" fill="transparent" data-hour="${h}"></rect>
        ${label}
      `;
    })
    .join("");

  container.innerHTML = `<svg viewBox="0 0 ${chartW} ${chartH}" class="study-svg-chart">${gridLines}${bars}</svg>`;

  container.querySelectorAll("rect[data-hour]").forEach((rect) => {
    rect.addEventListener("click", () => {
      const h = Number(rect.dataset.hour);
      const m = minutes[h];
      const share = total > 0 ? ` (${Math.round((m / total) * 100)}%)` : "";
      document.getElementById("hourly-chart-detail").textContent =
        `${hourRangeLabel(h, 1)}: ${formatDuration(m)}${share} · avg ${Math.round(m / days)} min/day`;
    });
  });
}

document.querySelectorAll("#hourly-toggle .period-btn").forEach((btn) => {
  btn.classList.toggle("active", Number(btn.dataset.days) === hourlyDays);
  btn.addEventListener("click", () => {
    hourlyDays = Number(btn.dataset.days);
    localStorage.setItem("hourlyChartDays", String(hourlyDays));
    document.querySelectorAll("#hourly-toggle .period-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.getElementById("hourly-chart-detail").textContent = "Tap a bar to see that hour";
    loadHourlyChart();
  });
});

// ---------- weekly / monthly goal progress ----------

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} hr`;
}

async function loadGoalProgress() {
  // Moodグラフは目標の数字とは無関係なので、progressの返事を待たずに同時に読み込む(2026-09-29)
  loadMoodPanel();
  await apiCached("/api/study-logs/progress", renderGoalProgress);
}

function renderGoalProgress(p) {
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
    // スクリーンタイム側も「〜min left」になるため、帯の中でどちらの話か分かるよう頭に「Study」を付ける
    bannerLabel.innerHTML = reached ? `Study ${labelText}` : `Study: ${p.daily_minimum_minutes - p.today_minutes} min to go`;
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

  const activityEcho = document.getElementById("today-activity-echo");
  const echoParts = [];
  if (p.today_drill_count) echoParts.push(`Drill ${p.today_drill_count}`);
  if (p.today_vocab_count) echoParts.push(`Vocab ${p.today_vocab_count}`);
  if (p.today_reading_pages) echoParts.push(`Reading ${p.today_reading_pages}p`);
  if (echoParts.length) {
    activityEcho.textContent = `🔗 Today's cross-app activity: ${echoParts.join(" ・ ")}`;
    activityEcho.classList.remove("hidden");
  } else {
    activityEcho.classList.add("hidden");
  }
}

// ---------- screen budget (JpBlocker×FocusGuardのスマホ利用時間連動、B案) ----------
// 予算そのものの計算はサーバー側(/api/screen-budget/current、DEVICE_TOKEN不要の公開版。
// ロック判定に使う/api/screen-budget/statusはデバイス専用でトークン必須のため、Webフロントに
// トークンを埋め込まずに済むようこちらを新設した)。ここではその結果を上の
// daily-min-bannerと同じ最小限の一行+バーの見た目で表示するだけ。
// 更新間隔の限界: PC/タブレットの利用時間はFocusGuard側が60秒おきに集計して送信するため、
// この表示は最大で約1分遅れた値になる(リアルタイムではない)。
const SCREEN_BUDGET_DEVICE_LABEL = { phone: "phone", pc: "PC", tablet: "tablet" };

async function loadScreenBudget() {
  const banner = document.getElementById("screen-budget-banner");
  const label = document.getElementById("screen-budget-banner-label");
  const fill = document.getElementById("screen-budget-banner-fill");
  let s;
  try {
    s = await api(`/api/screen-budget/current?date=${todayStr()}`);
  } catch (e) {
    return; // ネットワーク一時失敗時は前回の表示を維持する(daily-min-banner等と同じ方針)
  }
  if (!s || !s.budget_minutes) {
    banner.classList.add("hidden");
    return;
  }

  const deviceParts = Object.entries(s.consumed_by_device)
    .filter(([, minutes]) => minutes > 0)
    .map(([device, minutes]) => `${SCREEN_BUDGET_DEVICE_LABEL[device] || device} ${minutes}m`);
  const deviceText = deviceParts.length ? ` (${deviceParts.join(" · ")})` : "";
  const remaining = s.remaining_minutes;

  // 帯の中では幅が限られるので端末別の内訳はツールチップ(title)に回す
  label.textContent = remaining > 0 ? `Screen: ${remaining} min left` : "Screen: used up";
  banner.title = `Screen time today${deviceText}`;
  fill.style.width = `${Math.min(100, Math.max(0, (s.consumed_minutes / s.budget_minutes) * 100))}%`;

  banner.classList.remove("hidden");
  banner.classList.toggle("exhausted", remaining <= 0);
  banner.classList.toggle("low", remaining > 0 && remaining <= s.budget_minutes * 0.2);
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

function renderMoodPanel({ rows }) {
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

  renderMoodChart(
    dates,
    dates.map((d) => (d in avgByDate ? avgByDate[d] : null)),
    entriesByDate
  );
}

// 気分の記録を保存した瞬間にグラフ・一覧へ出すため、最後に描いた材料を控えておく(2026-09-29)
let lastMoodPanelData = null;

async function loadMoodPanel() {
  // 14日グラフは気分の線だけにした(2026-10-02)ので、勉強時間・スクリーンタイムは取りに行かない。
  // それらと気分の関係は「What moves my mood」カード(loadMoodDrivers)が受け持つ
  const rows = await api("/api/mood-logs?days=14");
  lastMoodPanelData = { rows };
  renderMoodPanel(lastMoodPanelData);
  loadMoodStats();
  loadMoodReasonStats();
  loadLowMoodAchievement();
  loadMoodDrivers();
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

// ---------- What moves my mood / study, Insights (2026-10-02) ----------
// 材料は/api/insights/daily(1日1行: mood・study・sleep・screen・slacking・diary)。
// カード2枚は、ある項目で日を半分に分け(多い半分/少ない半分)、気分や勉強時間の平均を比べる。
// 以前の/api/screen-time/mood-correlationと同じ考え方で、相関係数より直感的に読める。
// サボりだけは記録のない日が大半なので「サボった日/サボらなかった日」の2つに分ける。

const DRIVER_MIN_DAYS = 6;
const SLACKING_MIN_DAYS = 3;

function loadInsightsDaily() {
  return api("/api/insights/daily?days=30");
}

function compareHalves(rows, xKey, yKey) {
  const pairs = rows.filter((r) => r[xKey] != null && r[yKey] != null).map((r) => [r[xKey], r[yKey]]);
  const n = pairs.length;
  const avg = (xs, i) => xs.reduce((a, p) => a + p[i], 0) / xs.length;
  if (xKey === "slacking") {
    const hi = pairs.filter((p) => p[0] > 0);
    const lo = pairs.filter((p) => p[0] === 0);
    if (hi.length < SLACKING_MIN_DAYS || lo.length < SLACKING_MIN_DAYS) return { n, enough: false, hiDays: hi.length };
    return { n, enough: true, hiX: hi.length, loX: lo.length, hiY: avg(hi, 1), loY: avg(lo, 1) };
  }
  if (n < DRIVER_MIN_DAYS || new Set(pairs.map((p) => p[0])).size < 2) return { n, enough: false };
  pairs.sort((a, b) => a[0] - b[0]);
  const k = Math.floor(n / 2);
  const lo = pairs.slice(0, k);
  const hi = pairs.slice(n - k);
  return { n, enough: true, hiX: avg(hi, 0), loX: avg(lo, 0), hiY: avg(hi, 1), loY: avg(lo, 1) };
}

const DRIVER_DEFS = {
  sleep: { icon: "😴", name: "Sleep", hi: "More sleep", lo: "Less sleep", fmt: (v) => formatShortDuration(v) },
  study: { icon: "📚", name: "Study", hi: "More study", lo: "Less study", fmt: (v) => formatShortDuration(v) },
  screen: { icon: "📱", name: "Screen time", hi: "More screen", lo: "Less screen", fmt: (v) => formatShortDuration(v) },
  mood: { icon: "🙂", name: "Mood", hi: "Better mood", lo: "Worse mood", fmt: (v) => v.toFixed(1) },
  slacking: { icon: "🧭", name: "Slacking", hi: "Slacked", lo: "No slacking", fmt: (v) => `${v} days` },
};

function renderDrivers(containerId, rows, target, keys) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const fmtY = target === "mood" ? (v) => v.toFixed(1) : (v) => formatShortDuration(v);
  const results = keys.map((k) => [k, compareHalves(rows, k, target)]);
  const maxY = target === "mood" ? 10 : Math.max(60, ...results.filter(([, r]) => r.enough).flatMap(([, r]) => [r.hiY, r.loY]));
  el.innerHTML = results
    .map(([k, r]) => {
      const def = DRIVER_DEFS[k];
      const suffix = k === "sleep" && target === "study" ? " (night before)" : "";
      const title = `<span>${def.icon} ${def.name}${suffix}<span class="driver-n">${r.n} days</span></span>`;
      if (!r.enough) {
        const why =
          k === "slacking"
            ? `Not enough slacking logs (${r.hiDays ?? 0} days, need ${SLACKING_MIN_DAYS}+)`
            : `Not enough data (need ${DRIVER_MIN_DAYS}+ days)`;
        return `<div class="driver"><div class="driver-head">${title}</div><p class="driver-na">${why}</p></div>`;
      }
      const diff = r.hiY - r.loY;
      const sign = diff >= 0 ? "+" : "−";
      const diffText = target === "mood" ? `${sign}${Math.abs(diff).toFixed(1)}` : `${sign}${formatShortDuration(Math.abs(diff))} study`;
      const bar = (v) => `<span class="driver-bar"><span style="width:${Math.max(2, (v / maxY) * 100)}%"></span></span>`;
      const xText = (v) => (k === "slacking" ? def.fmt(v) : `avg ${def.fmt(v)}`);
      return `<div class="driver">
        <div class="driver-head">${title}<span class="driver-diff ${diff >= 0 ? "up" : "down"}">${diffText}</span></div>
        <div class="driver-row"><span class="driver-label">${def.hi} (${xText(r.hiX)})</span>${bar(r.hiY)}<span class="driver-val">${fmtY(r.hiY)}</span></div>
        <div class="driver-row"><span class="driver-label">${def.lo} (${xText(r.loX)})</span>${bar(r.loY)}<span class="driver-val">${fmtY(r.loY)}</span></div>
      </div>`;
    })
    .join("");
}

async function loadMoodDrivers() {
  const rows = await loadInsightsDaily();
  renderDrivers("mood-drivers", rows, "mood", ["sleep", "study", "screen"]);
}

async function loadStudyDrivers() {
  const rows = await loadInsightsDaily();
  renderDrivers("study-drivers", rows, "study", ["sleep", "mood", "screen", "slacking"]);
}

// Insights: 6項目の総当たり。偶然の数字を信じないよう、日数が少ないマスは灰色、
// 日数のわりに弱い関係は薄くして「chance?」を付ける(2026-10-02、とっつーとA+B(安全策つき)で決定)
const INSIGHT_KEYS = ["mood", "study", "sleep", "screen", "slacking", "diary"];
const INSIGHT_LABELS = { mood: "Mood", study: "Study", sleep: "Sleep", screen: "Screen", slacking: "Slack", diary: "Diary" };
const INSIGHT_MIN_DAYS = 10;

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// 両側5%のt分布の境目(自由度df)の近似。df=8で2.30、df=20で2.09と表の値とほぼ一致する
function couldBeChance(r, n) {
  const df = n - 2;
  const t = Math.abs(r) * Math.sqrt(df / Math.max(1e-9, 1 - r * r));
  return t < 1.96 + 2.37 / df + 2.8 / (df * df);
}

function insightCell(rows, a, b) {
  const pairs = rows.filter((r) => r[a] != null && r[b] != null);
  const n = pairs.length;
  const slackDays = a === "slacking" || b === "slacking" ? pairs.filter((r) => r.slacking > 0).length : null;
  if (n < INSIGHT_MIN_DAYS || (slackDays != null && slackDays < SLACKING_MIN_DAYS)) return { n, slackDays, r: null };
  const r = pearson(pairs.map((p) => p[a]), pairs.map((p) => p[b]));
  return { n, slackDays, r };
}

async function loadInsightsMatrix() {
  const rows = await loadInsightsDaily();
  const el = document.getElementById("insights-matrix");
  const cols = INSIGHT_KEYS.slice(1);
  let html = `<table class="insights-table"><tr><th></th>${cols.map((k) => `<th>${INSIGHT_LABELS[k]}</th>`).join("")}</tr>`;
  INSIGHT_KEYS.slice(0, -1).forEach((a, i) => {
    html += `<tr><th class="insights-row-head">${INSIGHT_LABELS[a]}</th>`;
    cols.forEach((b, j) => {
      if (j < i) {
        html += "<td></td>";
        return;
      }
      const c = insightCell(rows, a, b);
      const data = `data-a="${a}" data-b="${b}" data-n="${c.n}" data-r="${c.r ?? ""}" data-slack="${c.slackDays ?? ""}"`;
      if (c.r == null) {
        html += `<td><button type="button" class="insight-cell none" ${data}><b>–</b><i>${c.n}d</i></button></td>`;
        return;
      }
      const abs = Math.abs(c.r);
      const word = abs >= 0.5 ? "Strong" : abs >= 0.3 ? "Some" : "Weak";
      const chance = couldBeChance(c.r, c.n);
      const cls = word === "Weak" ? "weak" : `${c.r >= 0 ? "pos" : "neg"}${chance ? " chance" : ""}`;
      const arrow = word === "Weak" ? "" : c.r >= 0 ? " ↑" : " ↓";
      const sub = chance && word !== "Weak" ? "chance?" : `${c.n}d`;
      html += `<td><button type="button" class="insight-cell ${cls}" style="--strength:${abs.toFixed(2)}" ${data}><b>${word}${arrow}</b><i>${sub}</i></button></td>`;
    });
    html += "</tr>";
  });
  el.innerHTML = `${html}</table>`;
  el.querySelectorAll(".insight-cell").forEach((cell) => {
    cell.addEventListener("click", () => {
      const { a, b, n, r, slack } = cell.dataset;
      const pair = `${INSIGHT_LABELS[a]} × ${INSIGHT_LABELS[b]}`;
      const detail = document.getElementById("insights-detail");
      if (r === "") {
        detail.textContent =
          slack !== "" && parseInt(n, 10) >= INSIGHT_MIN_DAYS
            ? `${pair}: only ${slack} slacking days logged (need ${SLACKING_MIN_DAYS}+)`
            : `${pair}: ${n} days to compare (need ${INSIGHT_MIN_DAYS}+)`;
        return;
      }
      const v = parseFloat(r);
      const verdict = couldBeChance(v, parseInt(n, 10)) ? "could be chance" : "unlikely to be chance alone";
      detail.textContent = `${pair}: r = ${v >= 0 ? "+" : ""}${v.toFixed(2)} over ${n} days (${verdict})`;
    });
  });
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
    li.textContent = `${r.reason}: mood ${r.avg_score} · ${r.count}×`;
    list.appendChild(li);
  });
}

function renderMoodChart(dates, scores, entriesByDate) {
  const container = document.getElementById("mood-chart");
  // 以前は勉強時間の棒・スクリーンタイムの点線も重ねていたが、3つが重なって読めなかったので
  // 気分の線だけにした(2026-10-02)。関係は「What moves my mood」カードで2グループ比較する
  const chartW = 320;
  const chartH = 110;
  const padTop = 6;
  const padBottom = 13;
  const padLeft = 18;
  const padRight = 8;
  const plotH = chartH - padTop - padBottom;
  const plotW = chartW - padLeft - padRight;
  const stepX = dates.length > 1 ? plotW / (dates.length - 1) : 0;
  const xs = dates.map((_, i) => padLeft + i * stepX);
  const yOf = (score) => padTop + plotH - ((score - 1) / 9) * plotH;

  const grid = [1, 5, 10]
    .map(
      (v) =>
        `<line x1="${padLeft}" x2="${chartW - padRight}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="var(--border)" stroke-width="0.6"></line>` +
        `<text x="${padLeft - 5}" y="${yOf(v) + 2.5}" font-size="7" fill="var(--text-muted)" text-anchor="end">${v}</text>`
    )
    .join("");

  const axisLabels = dates
    .map((d, i) => `<text x="${xs[i]}" y="${chartH - 2}" font-size="7" fill="var(--text-muted)" text-anchor="middle">${d.slice(8, 10)}</text>`)
    .join("");

  let pathD = "";
  let drawing = false;
  const dots = [];
  dates.forEach((d, i) => {
    const score = scores[i];
    if (score == null) {
      drawing = false;
      return;
    }
    const y = yOf(score);
    pathD += `${drawing ? "L" : "M"}${xs[i]},${y} `;
    drawing = true;
    dots.push(`<circle cx="${xs[i]}" cy="${y}" r="4" fill="var(--accent)" data-date="${d}" data-score="${score}"></circle>`);
  });

  const path = pathD
    ? `<path d="${pathD.trim()}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>`
    : "";

  container.innerHTML = `<svg viewBox="0 0 ${chartW} ${chartH}" class="study-svg-chart">${grid}${path}${dots.join("")}${axisLabels}</svg>`;

  container.querySelectorAll("circle[data-date]").forEach((circle) => {
    circle.addEventListener("click", () => {
      const { date: d, score } = circle.dataset;
      const entries = (entriesByDate[d] || []).slice().reverse();
      const detail = document.getElementById("mood-chart-detail");
      if (entries.length === 0) {
        detail.textContent = `${d} Mood avg: ${score}/10`;
        return;
      }
      const lines = entries.map((e) => formatMoodEntryLine(e));
      detail.textContent = `${d} Mood avg: ${score}/10 / ${lines.join(" / ")}`;
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
  const reason = selectedMoodReason;
  noteInput.value = "";
  setSelectedMoodScore(5);
  setSelectedMoodReason(null);
  const entry = { date: todayStr(), score, note: note || null, reason, logged_at: nowLocalTimestamp() };
  // サーバーの保存とグラフ3本の取り直しを待たず、手元の材料に足して先に描く(2026-09-29)
  const before = lastMoodPanelData;
  if (before) renderMoodPanel({ ...before, rows: [...before.rows, { id: null, ...entry }] });
  try {
    await api("/api/mood-logs", { method: "POST", body: JSON.stringify(entry) });
    loadMoodPanel();
  } catch (err) {
    if (before) renderMoodPanel(before);
    noteInput.value = note;
    setSelectedMoodScore(score);
    setSelectedMoodReason(reason);
    showToast("気分の記録に失敗しました。もう一度お試しください");
  }
});

guardedSubmit(document.getElementById("goal-minutes-form"), async (e) => {
  const dailyMinutes = parseInt(document.getElementById("daily-goal-input").value, 10);
  const weeklyHours = parseFloat(document.getElementById("weekly-goal-input").value);
  const monthlyHours = parseFloat(document.getElementById("monthly-goal-input").value);
  const payload = {};
  if (!isNaN(dailyMinutes)) payload.daily_minimum_minutes = dailyMinutes;
  if (!isNaN(weeklyHours)) payload.weekly_goal_minutes = Math.round(weeklyHours * 60);
  if (!isNaN(monthlyHours)) payload.monthly_goal_minutes = Math.round(monthlyHours * 60);
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
    loadGoalProgress();
    setGoalEditing(false);
  } catch (err) {
    showToast("目標設定の保存に失敗しました。もう一度お試しください");
  }
});

function setGoalEditing(editing) {
  document.getElementById("goal-minutes-form").classList.toggle("hidden", !editing);
  document.getElementById("goal-edit-btn").textContent = editing ? "Cancel" : "✎ Edit goals";
  if (editing) document.getElementById("daily-goal-input").focus({ preventScroll: true });
}

document.getElementById("goal-edit-btn").addEventListener("click", () => {
  const editing = document.getElementById("goal-minutes-form").classList.contains("hidden");
  if (!editing) loadGoalProgress(); // キャンセル時は入力途中の値を保存済みの値に戻す
  setGoalEditing(editing);
});

// ---------- summary & log list ----------

async function loadStudySummary() {
  await apiCached("/api/study-logs/summary", renderStudySummary);
}

function renderStudySummary(rows) {
  // 0分の行(改名前の古いカテゴリー名「数学」など)は情報がないので出さない(2026-09-27)
  const summary = rows.filter((s) => s.total_minutes > 0);
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

// vocab-app連携ログのcount/unitを補足行として表示するためのテキストを作る。
// pagesはcount(差分)ではなくpage_start/page_endがあれば「p.120–148」の範囲表示を優先する
// (差分だけだと同じ28ページでもp.1–28なのかp.500–528なのか分からないため)。
function vocabAppDetailText(log) {
  if (log.unit === "pages" && log.page_start != null && log.page_end != null) {
    return `p.${log.page_start}–${log.page_end}`;
  }
  if (log.count == null || !log.unit) return null;
  return `${log.count} ${log.unit}`;
}

async function loadStudyLogList() {
  await apiCached("/api/study-logs", renderStudyLogList);
}

function renderStudyLogList(logs) {
  const list = document.getElementById("study-log-list");
  list.innerHTML = "";
  updateStudyLogHeader(logs.length);
  logs.slice(0, 20).forEach((l) => {
    const li = document.createElement("li");
    const modeLabel = vocabAppModeLabel(l.start_trigger);
    const detailText = l.note || vocabAppDetailText(l);
    li.innerHTML = `
      <span class="log-icon" style="background:${colorFor(l.subject)}"></span>
      <span class="log-info">
        <span class="log-subject">${escapeHtml(l.subject)}${modeLabel ? ` <span class="log-mode">· ${escapeHtml(modeLabel)}</span>` : ""}</span>
        <span class="log-time">${formatLoggedAt(l.logged_at)}${detailText ? ` · ${escapeHtml(detailText)}` : ""}</span>
      </span>
      <span class="log-duration">${formatLogDuration(l.minutes)}</span>
      ${l.id == null ? "" : `<button class="delete-btn" title="Delete">×</button>`}
    `;
    // id無し=Stop直後に手元で先に足した仮の行(applyStudyLogLocally)。サーバーのidが届くまで削除させない
    li.querySelector(".delete-btn")?.addEventListener("click", () => {
      const idx = logs.indexOf(l);
      undoableDelete(`Deleted ${l.subject} · ${formatLogDuration(l.minutes)}`, {
        apply: () => {
          li.remove();
          if (idx !== -1) logs.splice(idx, 1);
          updateStudyLogHeader(logs.length);
        },
        revert: () => loadStudyLogList(),
        commit: async () => {
          await api(`/api/study-logs/${l.id}`, { method: "DELETE" });
          loadStudySummary();
          loadStudyChart();
          loadActivityHeatmap();
          loadHourlyChart();
          loadGoalProgress();
          loadScreenBudget();
        },
      });
    });
    list.appendChild(li);
  });
}

// ---------- scores (diary / hitotsubashi writing / stack) ----------

let diaryScoreView = "overall"; // "overall" | "categories"
let lastDiaryScoreRows = [];
let hitotsubashiScoreView = "overall"; // "overall" | "categories"
let lastHitotsubashiScoreRows = [];

function formatMonthDay(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}/${Number(d)}`;
}

// 一橋ライティングは1日に複数回練習することがあるので、2回目以降は「9/26②」のように丸数字を付ける
function formatWritingSessionLabel(row) {
  const base = formatMonthDay(row.date);
  const n = row.session ?? 1;
  return n > 1 && n <= 20 ? base + String.fromCharCode(0x2460 + n - 1) : base;
}

async function loadScoresTab() {
  // 以前はPromise.allで4本まとめて待っていたため、1本でも失敗(例: サーバー再起動前で新APIが404)
  // するとタブ全体が空になっていた(2026-09-27)。カードごとに独立して読み込み、失敗したカードにだけ理由を出す。
  const cards = [
    // グラフは全期間(採点を遡って追加した7〜8月分も見えるように)、平均値は直近30日のまま
    ["/api/diary-scores?days=3650", "diary-score-chart", (rows) => {
      lastDiaryScoreRows = rows;
      renderDiaryScoreStats(rows);
      renderDiaryScoreChart(rows);
    }],
    ["/api/hitotsubashi-writing-scores?days=90", "hitotsubashi-score-chart", (rows) => {
      lastHitotsubashiScoreRows = rows;
      renderHitotsubashiScoreStats(rows);
      renderHitotsubashiScoreChart(rows);
    }],
    ["/api/stack-scores?days=90", "stack-score-chart", (rows) => {
      lastStackScoreRows = rows;
      renderStackScores(rows);
    }],
    // vocab-appの同期サーバーをCompassのサーバー経由で読みに行く(main.pyの/api/vocab-stats参照)
    ["/api/vocab-stats?days=90", "vocab-stats-chart", (data) => {
      lastVocabStats = data;
      renderVocabStats(data);
    }],
  ];
  // 各カードのデータが届くたびにまとめ表も描き直す(まとめ表は時間以外のデータを各カードから借りる)
  const withOverview = (render) => (data) => { render(data); renderOverview(); };
  // 前回の内容を先に描いてからサーバーの最新で描き直す(apiCached)。前回分が出ていれば、
  // 更新に失敗してもエラー表示で消さずにそのまま残す。
  await Promise.all([loadOverview(), ...cards.map(async ([path, chartId, rawRender]) => {
    const render = withOverview(rawRender);
    try {
      await apiCached(path, render);
    } catch (err) {
      console.error(`scores load failed: ${path}`, err);
      document.getElementById(chartId).innerHTML =
        `<p class="meta">Couldn't load this card (${escapeHtml(String(err?.message || err))})</p>`;
    }
  })]);
}

// ---------- overview by subject (2026-10-01) ----------
// 「時間配分の偏り」「一橋の科目ごとの進み具合」「伸びているか」を1枚で見るための表。
// 時間だけ/api/study-logs/subject-totalsから取り、成果の数字は下の各カードが読み込んだデータを使い回す
// (外部アプリへの取得を増やさないため)。例外はmathの行で、カードが無いので/api/drill-statsを別に読む
// (2026-10-02、drill-sync廃止でCompassに解いた数が残らなくなったため)。▲▼は同じ長さの直前の期間との比較。

const DRILL_URL = "https://drill-tracker.vercel.app";
let lastVocabStats = null;
let lastDrillStats = null;
let overviewData = null;
let overviewDays = [7, 30].includes(Number(localStorage.getItem("overviewDays")))
  ? Number(localStorage.getItem("overviewDays"))
  : 7;

async function loadOverview() {
  const days = overviewDays;
  // Drillの集計はmathの行の成果欄だけに使う。失敗しても表全体は出す
  apiCached(`/api/drill-stats?days=${days}`, (data) => {
    if (days !== overviewDays) return;
    lastDrillStats = data;
    renderOverview();
  }).catch((err) => console.error("drill stats load failed", err));
  try {
    await apiCached(`/api/study-logs/subject-totals?days=${days}`, (data) => {
      if (days !== overviewDays) return;
      overviewData = data;
      renderOverview();
    });
  } catch (err) {
    console.error("overview load failed", err);
    document.getElementById("overview-table").innerHTML =
      `<p class="meta">Couldn't load this card (${escapeHtml(String(err?.message || err))})</p>`;
  }
}

// 「今日を含む直近days日」と「その直前のdays日」の開始日(YYYY-MM-DD)
function overviewPeriodStarts(days) {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  const current = formatLocalDate(d);
  d.setDate(d.getDate() - days);
  return { current, previous: formatLocalDate(d) };
}

function overviewDelta(cur, prev, unit = "", digits = 0) {
  if (cur == null || prev == null) return "";
  const diff = cur - prev;
  const shown = Math.abs(diff).toFixed(digits);
  if (Number(shown) === 0) return `<span class="overview-flat">± 0${unit}</span>`;
  return diff > 0
    ? `<span class="overview-up">▲ ${shown}${unit}</span>`
    : `<span class="overview-down">▼ ${shown}${unit}</span>`;
}

function formatOverviewMinutes(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// 時間差は分単位だと細かすぎるので、1時間以上は時間(小数1桁)で出す
function overviewMinutesDelta(cur, prev) {
  if (Math.abs(cur - prev) >= 60) return overviewDelta(cur / 60, prev / 60, "h", 1);
  return overviewDelta(cur, prev, "m");
}

// 科目ごとの成果の数字。{ main, sub, target } を返す(targetはタップ時の移動先のカードid、またはURL)
function overviewResult(subject, starts, days) {
  const inCur = (date) => date >= starts.current;
  const inPrev = (date) => date >= starts.previous && date < starts.current;
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  // Drillは今の表示期間(days)と同じ長さで集計したものだけ使う(7日/30日の切り替え直後の取り違え防止)
  if (subject === "math" && lastDrillStats && lastDrillStats.days === days) {
    const d = lastDrillStats;
    const rating = d.avg_rating == null ? "" : ` · avg rating ${d.avg_rating.toFixed(1)}${overviewDelta(d.avg_rating, d.prev_avg_rating, "", 1)}`;
    return {
      main: `Drill solved <span class="overview-num">${d.solved}</span>${overviewDelta(d.solved, d.prev_solved)}${rating}`,
      sub: `Aochart progress ${d.progress_percent}% (${d.attempted_problems} / ${d.total_problems}) ↗`,
      target: DRILL_URL,
    };
  }

  if (subject === "English") {
    const writing = lastHitotsubashiScoreRows;
    const cur = avg(writing.filter((r) => inCur(r.date)).map((r) => r.overall));
    const prev = avg(writing.filter((r) => inPrev(r.date)).map((r) => r.overall));
    const main = cur == null
      ? `Hitotsubashi writing <span class="overview-num">--</span>`
      : `Hitotsubashi writing <span class="overview-num">${Math.round(cur)}</span>${overviewDelta(cur, prev)}`;
    let sub = "";
    if (lastVocabStats?.configured) {
      const ratings = lastVocabStats.ratings.filter((r) => inCur(r.date));
      const total = ratings.reduce((n, r) => n + r.total, 0);
      const good = ratings.reduce((n, r) => n + r.good + r.easy, 0);
      sub = `Vocab: mastered ${lastVocabStats.words.mastered}` + (total ? ` · Good/Easy ${Math.round((good / total) * 100)}%` : "");
    }
    return { main, sub, target: "scores-card-hitotsubashi" };
  }

  const stackRows = lastStackScoreRows.filter((r) => r.subject === subject);
  if (stackRows.length) {
    const acc = (rows) => {
      const reviews = rows.reduce((n, r) => n + r.reviews, 0);
      return reviews ? (rows.reduce((n, r) => n + r.correct, 0) / reviews) * 100 : null;
    };
    const cur = acc(stackRows.filter((r) => inCur(r.date)));
    const prev = acc(stackRows.filter((r) => inPrev(r.date)));
    const latest = stackRows[stackRows.length - 1];
    return {
      main: `Stack accuracy <span class="overview-num">${cur == null ? "--" : `${Math.round(cur)}%`}</span>${overviewDelta(cur, prev, "pt")}`,
      sub: `Mastered ${latest.mastered} / ${latest.total}`,
      target: "scores-card-stack",
    };
  }

  return null;
}

function renderOverview() {
  if (!overviewData) return;
  const barEl = document.getElementById("overview-share-bar");
  const tableEl = document.getElementById("overview-table");
  const { days, subjects } = overviewData;
  const starts = overviewPeriodStarts(days);
  const total = subjects.reduce((n, s) => n + s.minutes, 0);
  if (!subjects.length) {
    barEl.innerHTML = "";
    tableEl.innerHTML = `<p class="meta">No study logs in the last ${days} days</p>`;
    return;
  }
  const share = (s) => (total ? Math.round((s.minutes / total) * 100) : 0);

  barEl.innerHTML = total
    ? `<div class="overview-share-bar">` +
      subjects.filter((s) => s.minutes > 0).map((s) =>
        `<i style="width:${(s.minutes / total) * 100}%;background:${colorFor(s.subject)}" title="${escapeHtml(s.subject)} ${share(s)}%"></i>`).join("") +
      `</div><div class="chart-legend">` +
      subjects.filter((s) => s.minutes > 0).map((s) =>
        `<span class="legend-item"><span class="legend-dot" style="background:${colorFor(s.subject)};"></span>${escapeHtml(s.subject)} ${share(s)}%</span>`).join("") +
      `</div>`
    : "";

  const head = `<div class="overview-row overview-head">
      <span class="overview-subj">Subject</span><span class="overview-time">Time</span>
      <span class="overview-share">Share</span><span class="overview-result">Results</span></div>`;
  const rows = subjects.map((s) => {
    const result = overviewResult(s.subject, starts, days);
    // 今期0分で成果の数字も無い科目(「other」等)は並べても情報が無いので出さない。
    // 英語・Stack科目は成果の行があるので、0分になっても表に残る(サボりに気づけるように)
    if (!s.minutes && !result) return "";
    const perDay = (s.minutes / 60 / days).toFixed(1);
    return `<button type="button" class="overview-row"${result?.target ? ` data-target="${result.target}"` : ""}>
      <span class="overview-subj"><span class="legend-dot" style="background:${colorFor(s.subject)};"></span>${escapeHtml(s.subject)}</span>
      <span class="overview-time"><span class="overview-num">${formatOverviewMinutes(s.minutes)}</span>${overviewMinutesDelta(s.minutes, s.prev_minutes)}<span class="overview-sub">~${perDay}h / day</span></span>
      <span class="overview-share"><span class="overview-mini"><i style="width:${share(s)}%;background:${colorFor(s.subject)}"></i></span>${share(s)}%</span>
      <span class="overview-result">${result ? `${result.main}${result.sub ? `<span class="overview-sub">${result.sub}</span>` : ""}` : `<span class="overview-sub">—</span>`}</span>
    </button>`;
  }).join("");
  tableEl.innerHTML = head + rows;
}

document.getElementById("overview-table").addEventListener("click", (e) => {
  const target = e.target.closest(".overview-row[data-target]")?.dataset.target;
  if (!target) return;
  if (target.startsWith("http")) window.open(target, "_blank", "noopener");
  else document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.querySelectorAll("#overview-toggle .period-btn").forEach((btn) => {
  btn.classList.toggle("active", Number(btn.dataset.days) === overviewDays);
  btn.addEventListener("click", () => {
    overviewDays = Number(btn.dataset.days);
    try { localStorage.setItem("overviewDays", String(overviewDays)); } catch {}
    document.querySelectorAll("#overview-toggle .period-btn").forEach((b) => b.classList.toggle("active", b === btn));
    loadOverview();
  });
});

function renderDiaryScoreStats(rows) {
  const avgEl = document.getElementById("scores-diary-avg");
  const latestEl = document.getElementById("scores-diary-latest");
  if (!rows.length) {
    avgEl.textContent = "--";
    latestEl.textContent = "--";
    return;
  }
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const recent = rows.filter((r) => r.date >= cutoff);
  avgEl.textContent = recent.length
    ? Math.round(recent.reduce((sum, r) => sum + r.overall, 0) / recent.length)
    : "--";
  latestEl.textContent = Math.round(rows[rows.length - 1].overall);
}

// スコア系の折れ線グラフ(日記・Stack・Vocab・一橋)共通の座標系と縦軸(2026-10-02)。
// 以前は横長のviewBoxをpreserveAspectRatio="none"で引き伸ばしていて文字が潰れ、縦軸も無かったので、
// 勉強時間・気分グラフと同じく縦横比を保つ描き方にそろえ、左に目盛りを付けた
function scoreChartFrame(count, ticks, maxV, suffix = "") {
  const chartW = 320, chartH = 130, padLeft = 28, padRight = 8, padTop = 9, padBottom = 14;
  const plotW = chartW - padLeft - padRight;
  const plotH = chartH - padTop - padBottom;
  // 1点しかない時は線が引けないので、点を真ん中に置く
  const xOf = (i) => (count > 1 ? padLeft + (i * plotW) / (count - 1) : padLeft + plotW / 2);
  const yOf = (v) => padTop + plotH - (v / maxV) * plotH;
  const grid = ticks.map((v) =>
    `<line x1="${padLeft}" x2="${chartW - padRight}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="var(--border)" stroke-width="0.6"></line>` +
    `<text x="${padLeft - 4}" y="${yOf(v) + 3}" font-size="8" fill="var(--text-muted)" text-anchor="end">${v}${suffix}</text>`).join("");
  // 横軸の日付は5個程度に間引き、最後の点には必ず付ける
  const labelEvery = Math.max(1, Math.ceil(count / 5));
  const xLabels = (labelOf) => Array.from({ length: count }, (_, i) =>
    (i % labelEvery !== 0 && i !== count - 1) ? "" :
      `<text x="${xOf(i).toFixed(1)}" y="${chartH - 2}" font-size="8" fill="var(--text-muted)" text-anchor="middle">${labelOf(i)}</text>`).join("");
  const svg = (inner) => `<svg viewBox="0 0 ${chartW} ${chartH}" class="study-svg-chart">${grid}${inner}</svg>`;
  return { xOf, yOf, xLabels, svg };
}

// 上限が決まっていない値(習得数など)用: 0〜maxをおよそ4分割するキリのいい目盛り
function niceTicks(max) {
  const raw = Math.max(1, max) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // 枚数・語数は整数なので、目盛りの間隔も1未満にはしない
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw));
  const top = Math.ceil(Math.max(1, max) / step) * step;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { ticks, top };
}

function renderDiaryScoreChart(rows) {
  const container = document.getElementById("diary-score-chart");
  if (!rows.length) {
    container.innerHTML = `<p class="meta">No diary scores yet</p>`;
    return;
  }
  const overall = diaryScoreView === "overall";
  const max = overall ? 100 : 25;
  const { xOf, yOf, xLabels, svg } = scoreChartFrame(
    rows.length, overall ? [0, 25, 50, 75, 100] : [0, 5, 10, 15, 20, 25], max);

  const seriesDefs = overall
    ? [{ key: "overall", color: "#4f7cdb", width: 1.5, dots: true }]
    : [
        { key: "task", color: "#4f7cdb", width: 1.2 },
        { key: "coherence", color: "#4a9c72", width: 1.2 },
        { key: "lexical", color: "#e0a030", width: 1.2 },
        { key: "grammar", color: "#e5555c", width: 1.2 },
      ];

  const paths = seriesDefs.map((s) => {
    const d = rows.map((r, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(r[s.key]).toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"></path>`;
  }).join("");

  const dots = seriesDefs
    .filter((s) => s.dots)
    .map((s) => rows.map((r, i) =>
      `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(r[s.key]).toFixed(1)}" r="2" fill="${s.color}"></circle>`).join(""))
    .join("");

  container.innerHTML = svg(`${paths}${dots}${xLabels((i) => formatMonthDay(rows[i].date))}`);
}

// ---------- Stack(カードアプリ)の成績: 科目ごとの正答率(Good・Easyの割合)と習得数(間隔21日以上) ----------

let stackScoreView = "accuracy"; // "accuracy" | "mastered"
let lastStackScoreRows = [];
const STACK_SUBJECT_COLORS = ["#4f7cdb", "#e0a030", "#4a9c72", "#9b6bd6", "#e5555c"];

function stackEscape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function renderStackScores(rows) {
  const statsEl = document.getElementById("stack-score-stats");
  const container = document.getElementById("stack-score-chart");
  const legend = document.getElementById("stack-score-legend");
  if (!rows.length) {
    statsEl.innerHTML = "";
    container.innerHTML = `<p class="meta">まだ記録なし(Stackで復習すると自動で入ります)</p>`;
    legend.innerHTML = "";
    return;
  }
  const subjects = [...new Set(rows.map((r) => r.subject))];
  const color = (s) => STACK_SUBJECT_COLORS[subjects.indexOf(s) % STACK_SUBJECT_COLORS.length];
  const dates = [...new Set(rows.map((r) => r.date))].sort();

  // 科目ごとの最新の値(正答率は直近7日の合計から出す。1日だけだと枚数が少なくブレるため)
  const last = new Date(`${dates[dates.length - 1]}T00:00:00`);
  last.setDate(last.getDate() - 6);
  const weekAgo = formatLocalDate(last);
  statsEl.innerHTML = subjects.map((s) => {
    const own = rows.filter((r) => r.subject === s);
    const latest = own[own.length - 1];
    const recent = own.filter((r) => r.date >= weekAgo);
    const rev = recent.reduce((n, r) => n + r.reviews, 0);
    const cor = recent.reduce((n, r) => n + r.correct, 0);
    const acc = rev ? `${Math.round((cor / rev) * 100)}%` : "--";
    return `<div class="stat-cell"><span class="stat-label"><span class="legend-dot" style="background:${color(s)};"></span> ${stackEscape(s)} · 7d</span>` +
      `<span class="stat-value">${acc}</span><span class="stat-label">${latest.mastered}/${latest.total} mastered</span></div>`;
  }).join("");

  const accuracy = stackScoreView === "accuracy";
  const valueOf = (r) => (accuracy ? (r.reviews ? (r.correct / r.reviews) * 100 : null) : r.mastered);
  const scale = accuracy ? { ticks: [0, 25, 50, 75, 100], top: 100 } : niceTicks(Math.max(...rows.map((r) => r.mastered)));
  const { xOf: xAt, yOf, xLabels, svg } = scoreChartFrame(dates.length, scale.ticks, scale.top, accuracy ? "%" : "");
  const xOf = (d) => xAt(dates.indexOf(d));

  const paths = subjects.map((s) => {
    const pts = rows.filter((r) => r.subject === s).map((r) => [xOf(r.date), valueOf(r)]).filter(([, v]) => v !== null);
    const d = pts.map(([x, v], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
    const dots = pts.map(([x, v]) => `<circle cx="${x.toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="2.5" fill="${color(s)}"></circle>`).join("");
    return `<path d="${d}" fill="none" stroke="${color(s)}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>${dots}`;
  }).join("");
  container.innerHTML = svg(`${paths}${xLabels((i) => formatMonthDay(dates[i]))}`);
  legend.innerHTML = subjects.map((s) => `<span class="legend-item"><span class="legend-dot" style="background:${color(s)};"></span>${stackEscape(s)}</span>`).join("");
}

document.querySelectorAll("#stack-score-toggle .period-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    stackScoreView = btn.dataset.view;
    document.querySelectorAll("#stack-score-toggle .period-btn").forEach((b) => b.classList.toggle("active", b === btn));
    renderStackScores(lastStackScoreRows);
  });
});

// vocab-appの統計タブ(Mastery breakdown / Good・Easy)と同じ区分・同じ色
const VOCAB_MASTERY_SEGMENTS = [
  ["new", "New", "#9aa0a6"],
  ["learning", "Learning", "#38bdf8"],
  ["mastered", "Mastered", "#10b981"],
];

function renderVocabStats(data) {
  const cellsEl = document.getElementById("vocab-stats-cells");
  const barEl = document.getElementById("vocab-mastery-bar");
  const container = document.getElementById("vocab-stats-chart");
  if (!data.configured) {
    cellsEl.innerHTML = "";
    barEl.innerHTML = "";
    container.innerHTML = `<p class="meta">vocab-appとの接続が未設定(サーバーの環境変数VOCAB_APP_SYNC_TOKENにvocab-appのSYNC_TOKENを入れると表示されます)</p>`;
    return;
  }
  const { words, ratings } = data;
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "--");
  // 1日だけだと枚数が少なくブレるので、Stackカードと同じく直近7日の合計から出す
  const weekAgoDate = new Date();
  weekAgoDate.setDate(weekAgoDate.getDate() - 6);
  const weekAgo = formatLocalDate(weekAgoDate);
  const recent = ratings.filter((r) => r.date >= weekAgo);
  const recentTotal = recent.reduce((n, r) => n + r.total, 0);
  const recentGood = recent.reduce((n, r) => n + r.good + r.easy, 0);
  cellsEl.innerHTML = [
    ["Words", words.total, ""],
    ["Mastered", words.mastered, pct(words.mastered, words.total)],
    ["Good / Easy · 7d", pct(recentGood, recentTotal), recentTotal ? `${recentTotal} ratings` : ""],
  ].map(([label, value, sub]) =>
    `<div class="stat-cell"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>` +
    (sub ? `<span class="stat-label">${sub}</span>` : "") + `</div>`).join("");

  const segs = VOCAB_MASTERY_SEGMENTS.map(([key, label, color]) => ({ label, color, count: words[key] }));
  barEl.innerHTML = words.total
    ? `<div style="display:flex;height:10px;border-radius:5px;overflow:hidden;margin:8px 0 4px;">` +
      segs.filter((s) => s.count).map((s) =>
        `<div title="${s.label} ${s.count}" style="flex:${s.count};background:${s.color};"></div>`).join("") +
      `</div><div class="chart-legend">` +
      segs.map((s) => `<span class="legend-item"><span class="legend-dot" style="background:${s.color};"></span>${s.label} ${s.count}</span>`).join("") +
      `</div>`
    : "";

  if (!ratings.length) {
    container.innerHTML = `<p class="meta">まだ評価の記録なし(vocab-appで復習すると入ります)</p>`;
    return;
  }
  const { xOf, yOf: yAt, xLabels, svg } = scoreChartFrame(ratings.length, [0, 25, 50, 75, 100], 100, "%");
  const yOf = (r) => yAt(((r.good + r.easy) / r.total) * 100);
  const color = "#10b981";
  const d = ratings.map((r, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(r).toFixed(1)}`).join(" ");
  const dots = ratings.map((r, i) =>
    `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(r).toFixed(1)}" r="2.5" fill="${color}"><title>${r.date}: ${pct(r.good + r.easy, r.total)} (${r.total})</title></circle>`).join("");
  container.innerHTML = svg(
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>${dots}` +
    xLabels((i) => formatMonthDay(ratings[i].date)));
}

function renderHitotsubashiScoreStats(rows) {
  const el = document.getElementById("scores-hitotsubashi-latest");
  el.textContent = rows.length ? Math.round(rows[rows.length - 1].overall) : "--";
}

// 一橋ライティングは各観点0-100点。Overallは総合点に出題形式ごとの色の点を重ね、形式別の得意・不得意を見分けられるようにする
const HITOTSUBASHI_FORMAT_COLORS = { picture: "#e0a030", message: "#4a9c72", choice: "#9b6bd6", opinion: "#e5555c" };

function renderHitotsubashiScoreChart(rows) {
  const container = document.getElementById("hitotsubashi-score-chart");
  const legend = document.getElementById("hitotsubashi-score-legend");
  const legendItem = (color, label) => `<span class="legend-item"><span class="legend-dot" style="background:${color};"></span>${label}</span>`;
  if (!rows.length) {
    container.innerHTML = `<p class="meta">まだ記録なし</p>`;
    legend.innerHTML = "";
    return;
  }
  const { xOf, yOf, xLabels, svg } = scoreChartFrame(rows.length, [0, 25, 50, 75, 100], 100);

  const seriesDefs = hitotsubashiScoreView === "overall"
    ? [{ key: "overall", color: "#4f7cdb", width: 1.5, label: "Overall" }]
    : [
        { key: "content", color: "#4f7cdb", width: 1.2, label: "Content" },
        { key: "organization", color: "#4a9c72", width: 1.2, label: "Organization" },
        { key: "language", color: "#e5555c", width: 1.2, label: "Language" },
      ];

  const paths = seriesDefs.map((s) => {
    const d = rows.map((r, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(r[s.key]).toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"></path>`;
  }).join("");

  const dots = hitotsubashiScoreView === "overall"
    ? rows.map((r, i) => `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(r.overall).toFixed(1)}" r="3" fill="${HITOTSUBASHI_FORMAT_COLORS[r.format] ?? "#4f7cdb"}"></circle>`).join("")
    : "";

  container.innerHTML = svg(`${paths}${dots}${xLabels((i) => formatWritingSessionLabel(rows[i]))}`);
  legend.innerHTML = hitotsubashiScoreView === "overall"
    ? [["picture", "Picture"], ["message", "Message"], ["choice", "Choice"], ["opinion", "Opinion"]]
        .map(([f, label]) => legendItem(HITOTSUBASHI_FORMAT_COLORS[f], label)).join("")
    : seriesDefs.map((s) => legendItem(s.color, s.label)).join("");
}

document.querySelectorAll("#hitotsubashi-score-toggle .period-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    hitotsubashiScoreView = btn.dataset.view;
    document.querySelectorAll("#hitotsubashi-score-toggle .period-btn").forEach((b) => b.classList.toggle("active", b === btn));
    renderHitotsubashiScoreChart(lastHitotsubashiScoreRows);
  });
});

document.querySelectorAll("#diary-score-toggle .period-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    diaryScoreView = btn.dataset.view;
    document.querySelectorAll("#diary-score-toggle .period-btn").forEach((b) => b.classList.toggle("active", b === btn));
    renderDiaryScoreChart(lastDiaryScoreRows);
  });
});

// ---------- activation logs ----------

let activationActiveLog = null;
let activationTickInterval = null;

// サボり中はタブバーのすぐ上の帯に出し、「Back to work」を1タップで押せるようにする(2026-10-02)。
// 以前は画面最上部のバナーで、タップすると設定画面に飛び、そこで復帰ボタンを押す必要があった
function activationElapsedLabel() {
  const triggered = new Date(activationActiveLog.triggered_at.replace(" ", "T"));
  const elapsedMin = Math.max(0, Math.floor((Date.now() - triggered.getTime()) / 60000));
  return `Slacking since ${activationActiveLog.triggered_at.slice(11, 16)} · ${formatLogDuration(elapsedMin)}`;
}

function updateActivationBanner() {
  const strip = document.getElementById("slack-now");
  if (!activationActiveLog) {
    strip.classList.add("hidden");
  } else {
    document.getElementById("slack-now-label").innerHTML = `${ICONS.alert} ${activationElapsedLabel()}`;
    strip.classList.remove("hidden");
  }
  positionNowDock();
}

// activationActiveLogの現在値に合わせて画面を更新する部分だけを切り出したもの(2026-09-05)。
// サーバーから取得した後(loadActivationActive)だけでなく、楽観的更新(returnActivation)でも
// activationActiveLogを書き換えた直後にそのまま呼べるようにするため。
function renderActivationStatus() {
  const statusEl = document.getElementById("activation-current-status");
  if (activationActiveLog) {
    const noteText = activationActiveLog.note ? ` ${activationActiveLog.note}` : "";
    statusEl.textContent = `Active: ${formatLoggedAt(activationActiveLog.triggered_at)}〜${noteText}`;
    if (!activationTickInterval) {
      activationTickInterval = setInterval(updateActivationBanner, 30000);
    }
  } else {
    statusEl.textContent = "";
    if (activationTickInterval) {
      clearInterval(activationTickInterval);
      activationTickInterval = null;
    }
  }
  updateActivationBanner();
}

async function loadActivationActive() {
  activationActiveLog = await api("/api/activation-logs/active");
  renderActivationStatus();
}

async function returnActivation() {
  if (!activationActiveLog) return;
  const activeLog = activationActiveLog;
  activationActiveLog = null;
  renderActivationStatus(); // 楽観的に即座に「未Active」表示へ切り替える
  try {
    await api(`/api/activation-logs/${activeLog.id}/return`, {
      method: "PUT",
      body: JSON.stringify({ returned_at: nowLocalTimestamp() }),
    });
  } catch (err) {
    showToast("復帰の記録に失敗しました。もう一度お試しください");
  } finally {
    refreshActivation(); // 成功・失敗いずれも正本で確定させる(失敗時はここでActiveに戻る)
  }
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
  document.getElementById("activation-mood-reasons-heading").classList.toggle("hidden", rows.length === 0);
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

// start_triggerには他アプリ連携の内部名("vocab-app:review"等)がそのまま入っているので、表示用に言い換える
const START_TRIGGER_LABEL = {
  "vocab-app:review": "Vocab review",
  "vocab-app:reading": "Vocab reading",
  "vocab-app:news": "Vocab news",
  "drill-tracker:solve": "Drill",
  "stack:review": "Cards (Stack)",
  "Continuing previous study": "Continuing study",
  "No particular reason": "No reason",
};

function startTriggerLabel(trigger) {
  if (START_TRIGGER_LABEL[trigger]) return START_TRIGGER_LABEL[trigger];
  if (trigger.startsWith("vocab-app:")) return `Vocab ${trigger.slice("vocab-app:".length)}`;
  return trigger;
}

async function loadStudyTriggerStats() {
  const rows = await api("/api/study-logs/trigger-stats?days=30");
  const list = document.getElementById("study-trigger-stats");
  list.innerHTML = "";
  document.getElementById("study-trigger-heading").classList.toggle("hidden", rows.length === 0);
  if (rows.length === 0) {
    list.classList.add("hidden");
    return;
  }
  list.classList.remove("hidden");
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = `${startTriggerLabel(r.start_trigger)} ${r.count}`;
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
    li.querySelector(".delete-btn").addEventListener("click", () => {
      undoableDelete("Deleted activation log", {
        apply: () => li.remove(),
        revert: () => loadActivationList(),
        commit: async () => {
          await api(`/api/activation-logs/${l.id}`, { method: "DELETE" });
          loadActivationActive();
          loadActivationStats();
          loadActivationPostReturnStats();
          loadActivationMoodReasons();
          loadCalendar();
        },
      });
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

guardedClick(document.getElementById("slack-now-return-btn"), returnActivation);

guardedSubmit(document.getElementById("activation-form"), async (e) => {
  const note = document.getElementById("activation-note").value.trim() || null;
  const payload = {
    triggered_at: nowLocalTimestamp(),
    note,
    mood: activationSelectedMood,
    mood_reason: activationSelectedReason,
  };
  closeActivationPanel();
  activationActiveLog = { id: null, ...payload }; // idはPOST応答後にrefreshActivation()で正しい値に上書きされる
  renderActivationStatus();
  try {
    await api("/api/activation-logs", { method: "POST", body: JSON.stringify(payload) });
  } catch (err) {
    activationActiveLog = null;
    renderActivationStatus();
    showToast("記録の開始に失敗しました。もう一度お試しください");
    return;
  }
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
let wakeMoodScore = null;

// サボりモード(発動ログ)のバナー・アイコン点滅と同じ「今この状態だとひと目でわかる」表現を、
// 睡眠モードにも用意する。ただし睡眠は焦らせる状態ではないので、色はdangerではなくaccent、
// 点滅もゆっくりめ(呼吸のように)にして、サボりモードとトーンを分ける。
// 2026-10-02: 帯は画面最上部からタブバーのすぐ上へ移し、「I'm up」を帯の中で押せるようにした
// (以前は帯をタップすると設定画面に飛び、起床ボタンはその中にあった)
function sleepElapsedLabel() {
  const bedtime = new Date(sleepActiveLog.bedtime_at.replace(" ", "T"));
  const elapsedMin = Math.max(0, Math.floor((Date.now() - bedtime.getTime()) / 60000));
  return `Sleeping since ${sleepActiveLog.bedtime_at.slice(11, 16)} · ${formatLogDuration(elapsedMin)}`;
}

function updateSleepBanner() {
  const strip = document.getElementById("sleep-now");
  if (!sleepActiveLog) {
    strip.classList.add("hidden");
  } else {
    document.getElementById("sleep-now-label").innerHTML = `${ICONS.moon} ${sleepElapsedLabel()}`;
    strip.classList.remove("hidden");
  }
  positionNowDock();
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

// activation-logsのrenderActivationStatusと同じ理由(2026-09-05): サーバー取得後だけでなく
// 楽観的更新(wakeUp)からもsleepActiveLog書き換え直後にそのまま呼べるよう切り出した。
function renderSleepStatus() {
  if (sleepActiveLog) {
    if (!sleepTickInterval) {
      sleepTickInterval = setInterval(updateSleepBanner, 30000);
    }
  } else {
    if (sleepTickInterval) {
      clearInterval(sleepTickInterval);
      sleepTickInterval = null;
    }
  }
  updateSleepBanner();
}

async function loadSleepActive() {
  sleepActiveLog = await api("/api/sleep-logs/active");
  renderSleepStatus();
}

// 朝のパネルで直せるよう、今回記録した睡眠ログ(id・就寝・起床時刻)を覚えておく
let wakePanelLog = null;
// "recorded": I'm upで起床を記録した直後(時刻のずれを直すだけ)
// "pending":  寝ている状態のまま朝にアプリを開いた(Saveで起床を記録する、2026-10-02)
// "backfill": 昨夜の睡眠記録がない(就寝時刻も聞いて1件まるごと作る、2026-10-02)
let wakePanelMode = "recorded";

function wakePanelBedtime() {
  if (wakePanelMode === "backfill") {
    // 時刻だけの入力なので、昼(12:00)以降なら前日の夜、それより前なら今日の深夜とみなす
    const hm = document.getElementById("wake-bed-input").value;
    if (!hm) return null;
    const today = todayStr();
    return new Date(`${hm >= "12:00" ? addDaysToDate(today, -1) : today}T${hm}:00`);
  }
  return wakePanelLog ? new Date(wakePanelLog.bedtime_at.replace(" ", "T")) : null;
}

function wakeTimeFromInput() {
  // 入力は時刻だけなので、記録済みの起床時刻と同じ日付を基準にし、就寝より前になるなら翌日扱いにする
  const hm = document.getElementById("wake-time-input").value;
  if (!wakePanelLog || !hm) return null;
  const base = wakePanelLog.wake_at.slice(0, 10);
  let candidate = new Date(`${base}T${hm}:00`);
  const bed = wakePanelBedtime();
  if (bed && candidate <= bed) candidate = new Date(candidate.getTime() + 24 * 3600 * 1000);
  return candidate;
}

function updateWakeSleptLabel() {
  const el = document.getElementById("wake-slept-label");
  const wake = wakeTimeFromInput();
  const bed = wakePanelBedtime();
  if (!wake || !bed) {
    el.textContent = "";
    return;
  }
  el.textContent = `Slept ${formatLogDuration(Math.round((wake - bed) / 60000))}`;
}

document.getElementById("wake-time-input").addEventListener("input", updateWakeSleptLabel);
document.getElementById("wake-bed-input").addEventListener("input", updateWakeSleptLabel);

function openWakeMoodPanel(log = null, mode = "recorded") {
  const panel = document.getElementById("wake-mood-panel");
  const backdrop = document.getElementById("wake-mood-backdrop");
  const buttons = document.getElementById("wake-mood-buttons");
  setBedtimeMoodScore(buttons, null);
  wakeMoodScore = null;
  wakePanelMode = mode;
  wakePanelLog = mode === "backfill" ? { bedtime_at: null, wake_at: nowLocalTimestamp() } : log;
  const note = document.getElementById("wake-panel-note");
  note.classList.toggle("hidden", mode !== "backfill");
  note.textContent = mode === "backfill" ? "No sleep log for last night. When did you go to bed?" : "";
  document.getElementById("wake-bed-row").classList.toggle("hidden", mode !== "backfill");
  if (mode === "backfill") document.getElementById("wake-bed-input").value = "23:00";
  document.getElementById("wake-time-row").classList.toggle("hidden", !wakePanelLog);
  if (wakePanelLog) {
    document.getElementById("wake-time-input").value = wakePanelLog.wake_at.slice(11, 16);
    updateWakeSleptLabel();
  }
  panel.classList.remove("hidden");
  backdrop.classList.remove("hidden");
}

function closeWakeMoodPanel() {
  document.getElementById("wake-mood-panel").classList.add("hidden");
  document.getElementById("wake-mood-backdrop").classList.add("hidden");
}

// ×や背景で閉じた時。「pending」は起床をまだ記録していないので、しばらくは自動で出し直さない
function dismissWakeMoodPanel() {
  if (wakePanelMode === "pending") morningPromptSnoozeUntil = Date.now() + 20 * 60 * 1000;
  closeWakeMoodPanel();
}

// ---------- morning auto prompt (2026-10-02) ----------
// 寝ている状態のまま朝アプリを開いたら、I'm upを押さなくてもGood morningパネルを出す。
// 寝る記録自体を忘れた夜は、朝1回だけ「昨夜は何時に寝た?」と聞いて穴を埋める
let morningPromptSnoozeUntil = 0;
const MORNING_START_HOUR = 5;
const MORNING_END_HOUR = 13;
const BACKFILL_ASKED_KEY = "sleepBackfillAskedDate";

function isMorningNow() {
  const h = new Date().getHours();
  return h >= MORNING_START_HOUR && h < MORNING_END_HOUR;
}

async function maybeShowMorningPanel() {
  if (!isMorningNow() || Date.now() < morningPromptSnoozeUntil) return;
  if (timerSubject || visiblePanels().length) return;
  if (sleepActiveLog) {
    if (!sleepActiveLog.id) return; // 就寝の保存中
    const bed = new Date(sleepActiveLog.bedtime_at.replace(" ", "T"));
    if (Date.now() - bed.getTime() < 3 * 3600 * 1000) return; // 寝てすぐ・昼寝中は聞かない
    openWakeMoodPanel({ id: sleepActiveLog.id, bedtime_at: sleepActiveLog.bedtime_at, wake_at: nowLocalTimestamp() }, "pending");
    return;
  }
  const today = todayStr();
  try {
    if (localStorage.getItem(BACKFILL_ASKED_KEY) === today) return;
  } catch {
    // 保存できない環境では毎回確認になるが、記録済みなら下の判定で出ない
  }
  const [latest] = await api("/api/sleep-logs?limit=1");
  const coveredSince = `${addDaysToDate(today, -1)} 18:00:00`;
  if (latest && (latest.bedtime_at >= coveredSince || (latest.wake_at && latest.wake_at >= `${today} 00:00:00`))) return;
  if (timerSubject || visiblePanels().length) return;
  try {
    localStorage.setItem(BACKFILL_ASKED_KEY, today);
  } catch {
    // 同上
  }
  openWakeMoodPanel(null, "backfill");
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !isMorningNow()) return;
  loadSleepActive().then(maybeShowMorningPanel).catch(() => {});
});

async function wakeUp() {
  if (!sleepActiveLog) return;
  const activeLog = sleepActiveLog;
  sleepActiveLog = null;
  renderSleepStatus(); // 楽観的に即座に「起床済み」表示へ
  try {
    const wake_at = nowLocalTimestamp();
    await api(`/api/sleep-logs/${activeLog.id}`, {
      method: "PUT",
      body: JSON.stringify({ wake_at }),
    });
    openWakeMoodPanel({ id: activeLog.id, bedtime_at: activeLog.bedtime_at, wake_at });
  } catch (err) {
    showToast("起床の記録に失敗しました。もう一度お試しください");
  } finally {
    loadSleepActive(); // 成功・失敗いずれも正本で確定(失敗時はここでまだ就寝中に戻る)
    loadSleepPanel();
  }
}

async function loadSleepPanel() {
  // 30晩ぶんのグラフを描くため、昼寝などで1晩に2件ある分も見込んで多めに取る。
  // 数字(平均など)は昼寝・押し忘れを外す必要があり、記録の種類(kind)を見ながら手元で計算する
  const logs = await api("/api/sleep-logs?limit=60");
  const nights = sleepNightsInRange(logs);
  renderSleepStats(logs, nights);
  renderSleepChart(nights);
  renderSleepLogList(logs.slice(0, 30));
}

// ---------- sleep chart (2026-10-02) ----------
// 1晩を1本の縦棒にし、寝た時刻〜起きた時刻を塗る(縦軸は21時〜翌12時)。
// 記録の種類はサーバーのsleep_kind()が決める: main(夜の睡眠) / nap(昼寝、3時間未満で9〜21時に寝た) /
// flag(14時間超、起きたの押し忘れ?)。napとflagは平均から外す。
// 時刻はタイムゾーンを持たない文字列なので、Dateに通さず日付と時刻の数字だけで計算する。

const SLEEP_AXIS_START_MIN = 21 * 60; // 縦軸の一番上 = 21:00
const SLEEP_AXIS_SPAN_MIN = 15 * 60; // 21:00〜翌12:00

function daysBetweenDates(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// 寝た時刻が正午より前なら前日の夜として数える(02:56に寝た → 前日の夜)
function sleepNightOf(bedtimeAt) {
  const date = bedtimeAt.slice(0, 10);
  return parseInt(bedtimeAt.slice(11, 13), 10) < 12 ? addDaysToDate(date, -1) : date;
}

// その夜の21:00から何分後か(21:00より前なら負の数)
function minutesFromNightStart(ts, night) {
  const clock = parseInt(ts.slice(11, 13), 10) * 60 + parseInt(ts.slice(14, 16), 10);
  return daysBetweenDates(night, ts.slice(0, 10)) * 1440 + clock - SLEEP_AXIS_START_MIN;
}

function formatClockMinutes(m) {
  const v = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

function formatShortDuration(minutes) {
  const m = Math.round(minutes);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

// 直近30晩(昨夜まで)について、夜ごとの記録をまとめる
function sleepNightsInRange(logs) {
  const today = todayStr();
  const nights = [];
  for (let i = 30; i >= 1; i--) nights.push({ night: addDaysToDate(today, -i), records: [] });
  const byNight = Object.fromEntries(nights.map((n) => [n.night, n]));
  logs.forEach((l) => {
    if (!l.wake_at || !l.kind) return;
    const night = sleepNightOf(l.bedtime_at);
    if (!byNight[night]) return;
    const start = minutesFromNightStart(l.bedtime_at, night);
    const end = minutesFromNightStart(l.wake_at, night);
    byNight[night].records.push({ ...l, start, end, minutes: end - start });
  });
  return nights;
}

function renderSleepStats(logs, nights) {
  const lastMain = logs.find((l) => l.kind === "main");
  document.getElementById("sleep-stat-last-night").textContent = lastMain
    ? formatShortDuration(sleepDurationMinutes(lastMain.bedtime_at, lastMain.wake_at))
    : "-";
  const mains = nights.flatMap((n) => n.records.filter((r) => r.kind === "main"));
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  document.getElementById("sleep-stat-avg").textContent = mains.length ? formatShortDuration(avg(mains.map((r) => r.minutes))) : "-";
  document.getElementById("sleep-stat-bedtime").textContent = mains.length
    ? formatClockMinutes(avg(mains.map((r) => r.start)) + SLEEP_AXIS_START_MIN)
    : "-";
  // 押し忘れ(flag)も「寝る記録はつけた夜」なので記録率には数える
  const logged = nights.filter((n) => n.records.some((r) => r.kind !== "nap")).length;
  document.getElementById("sleep-stat-logged").textContent = `${logged}/${nights.length}`;
}

function renderSleepChart(nights) {
  const container = document.getElementById("sleep-chart");
  const W = 320;
  const H = 210;
  const L = 30;
  const R = 4;
  const T = 8;
  const B = 30;
  const plotH = H - T - B;
  const col = (W - L - R) / nights.length;
  const barW = col * 0.62;
  const yOf = (m) => T + (Math.max(0, Math.min(SLEEP_AXIS_SPAN_MIN, m)) / SLEEP_AXIS_SPAN_MIN) * plotH;

  let svg = "";
  [21, 0, 3, 6, 9, 12].forEach((h, i) => {
    const y = yOf(i * 180);
    svg += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--border)" stroke-width="0.6"></line>`;
    svg += `<text x="${L - 4}" y="${y + 2.5}" font-size="7.5" fill="var(--text-muted)" text-anchor="end">${String(h).padStart(2, "0")}:00</text>`;
  });

  nights.forEach((n, i) => {
    const cx = L + col * i + col / 2;
    const hasNight = n.records.some((r) => r.kind !== "nap");
    if (!hasNight) {
      svg += `<rect x="${cx - barW / 2}" y="${T}" width="${barW}" height="${plotH}" rx="2" fill="var(--sleep-none)"></rect>`;
    }
    n.records.forEach((r) => {
      if (r.kind === "nap") {
        svg += `<circle cx="${cx}" cy="${T + plotH + 8}" r="2.8" fill="var(--nap)"></circle>`;
        return;
      }
      const y1 = yOf(r.start);
      const y2 = yOf(r.end);
      const fill = r.kind === "flag" ? "var(--neutral-flag)" : "var(--accent)";
      svg += `<rect x="${cx - barW / 2}" y="${y1}" width="${barW}" height="${Math.max(2, y2 - y1)}" rx="2" fill="${fill}"></rect>`;
      // 21時より前に寝た分は上で切れているので▲で知らせる
      if (r.start < 0) svg += `<path d="M${cx - 2.5},${T + 4} L${cx},${T + 0.5} L${cx + 2.5},${T + 4}" fill="var(--text)"></path>`;
      if (r.kind === "flag") {
        svg += `<text x="${cx}" y="${Math.min(y2 + 9, T + plotH - 1)}" font-size="8" font-weight="700" fill="var(--text)" text-anchor="middle">?</text>`;
      }
    });
    if (i % 5 === 4) {
      const [, m, d] = n.night.split("-").map(Number);
      svg += `<text x="${cx}" y="${H - 3}" font-size="7.5" fill="var(--text-muted)" text-anchor="middle">${m}/${d}</text>`;
    }
  });

  const mains = nights.flatMap((n) => n.records.filter((r) => r.kind === "main"));
  if (mains.length) {
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    [avg(mains.map((r) => r.start)), avg(mains.map((r) => r.end))].forEach((m) => {
      svg += `<line x1="${L}" x2="${W - R}" y1="${yOf(m)}" y2="${yOf(m)}" stroke="var(--text)" stroke-opacity="0.5" stroke-width="0.8" stroke-dasharray="3,3"></line>`;
    });
  }
  svg += `<text x="${L - 4}" y="${T + plotH + 10.5}" font-size="7" fill="var(--nap)" text-anchor="end">nap</text>`;
  // タップ判定用の透明な列は最後に重ねる(点線などの下に隠れないように)
  nights.forEach((n, i) => {
    svg += `<rect class="sleep-hit" data-i="${i}" x="${L + col * i}" y="${T}" width="${col}" height="${plotH + 14}" fill="transparent"></rect>`;
  });

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="study-svg-chart sleep-svg-chart">${svg}</svg>`;
  container.querySelectorAll(".sleep-hit").forEach((hit) => {
    hit.addEventListener("click", () => {
      const n = nights[parseInt(hit.dataset.i, 10)];
      const [, m, d] = n.night.split("-").map(Number);
      const detail = document.getElementById("sleep-chart-detail");
      if (n.records.length === 0) {
        detail.textContent = `Night of ${m}/${d}: no record`;
        return;
      }
      const label = { main: "", nap: " · nap", flag: " · forgot to tap?" };
      const parts = n.records.map(
        (r) => `${r.bedtime_at.slice(11, 16)} → ${r.wake_at.slice(11, 16)} (${formatShortDuration(r.minutes)})${label[r.kind]}`
      );
      detail.textContent = `Night of ${m}/${d}: ${parts.join(" / ")}`;
    });
  });
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
      li.querySelector(".sleep-edit-row").classList.add("hidden");
      try {
        await api(`/api/sleep-logs/${l.id}`, {
          method: "PUT",
          body: JSON.stringify({
            bedtime_at: fromDatetimeLocalValue(bedtimeVal),
            wake_at: fromDatetimeLocalValue(wakeVal),
          }),
        });
        loadSleepActive();
        loadSleepPanel();
      } catch (err) {
        li.querySelector(".sleep-edit-row").classList.remove("hidden");
        showToast("保存に失敗しました。もう一度お試しください");
      }
    });
    li.querySelector(".delete-btn").addEventListener("click", () => {
      undoableDelete("Deleted sleep log", {
        apply: () => li.remove(),
        revert: () => loadSleepPanel(),
        commit: async () => {
          await api(`/api/sleep-logs/${l.id}`, { method: "DELETE" });
          loadSleepActive();
        },
      });
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
      li.remove();
      toggleBedtimeCarryoverEmpty();
      try {
        await api(`/api/todos/${t.id}/due`, {
          method: "PUT",
          body: JSON.stringify({ due_date: addDaysToDate(t.due_date, 1), due_time: t.due_time || null }),
        });
        loadTodos();
        loadCalendar();
      } catch (err) {
        list.appendChild(li);
        toggleBedtimeCarryoverEmpty();
        showToast(`「${t.title}」の変更に失敗しました。もう一度お試しください`);
      }
    });
    li.querySelector('[data-action="keep"]').addEventListener("click", () => {
      li.remove();
      toggleBedtimeCarryoverEmpty();
    });
    li.querySelector('[data-action="delete"]').addEventListener("click", () => {
      undoableDelete(`Deleted "${t.title}"`, {
        apply: () => { li.remove(); toggleBedtimeCarryoverEmpty(); },
        revert: () => { list.appendChild(li); toggleBedtimeCarryoverEmpty(); },
        commit: async () => {
          await api(`/api/todos/${t.id}`, { method: "DELETE" });
          loadTodos();
        },
      });
    });
    list.appendChild(li);
  });
  toggleBedtimeCarryoverEmpty();
}

async function openBedtimePanel() {
  bedtimePanel.classList.remove("hidden");
  bedtimeBackdrop.classList.remove("hidden");
  document.getElementById("bedtime-step1").classList.remove("hidden");
  document.getElementById("bedtime-step-mood").classList.add("hidden");
  document.getElementById("bedtime-step-sabori").classList.add("hidden");
  document.getElementById("bedtime-step2").classList.add("hidden");
  document.getElementById("bedtime-add-title").value = "";
  document.getElementById("bedtime-added-list").innerHTML = "";
  document.getElementById("bedtime-sabori-note").value = "";
  document.getElementById("bedtime-sabori-list").innerHTML = "";
  bedtimeMoodScore = null;
  setBedtimeMoodScore(bedtimeMoodButtons, null);
  await renderBedtimeCarryoverList();
}

let bedtimeMoodScore = null;

function setBedtimeMoodScore(container, score) {
  container.querySelectorAll(".mood-scale-btn").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.score, 10) === score);
  });
  return score;
}

const bedtimeMoodButtons = document.getElementById("bedtime-mood-buttons");
bedtimeMoodButtons.querySelectorAll(".mood-scale-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    bedtimeMoodScore = setBedtimeMoodScore(bedtimeMoodButtons, parseInt(btn.dataset.score, 10));
  });
});

async function saveMoodScoreOnly(score) {
  if (score == null) return;
  await api("/api/mood-logs", {
    method: "POST",
    body: JSON.stringify({ date: todayStr(), score, logged_at: nowLocalTimestamp() }),
  });
  loadMoodStats();
}

document.getElementById("bedtime-step1-next").addEventListener("click", () => {
  document.getElementById("bedtime-step1").classList.add("hidden");
  bedtimeMoodScore = null;
  setBedtimeMoodScore(bedtimeMoodButtons, null);
  document.getElementById("bedtime-step-mood").classList.remove("hidden");
});

document.getElementById("bedtime-mood-next").addEventListener("click", async () => {
  const score = bedtimeMoodScore;
  document.getElementById("bedtime-step-mood").classList.add("hidden");
  document.getElementById("bedtime-step-sabori").classList.remove("hidden");
  if (score != null) {
    try {
      await saveMoodScoreOnly(score);
    } catch (err) {
      showToast("気分の記録に失敗しました。もう一度お試しください");
    }
  }
});

guardedSubmit(document.getElementById("bedtime-sabori-form"), async (e) => {
  const input = document.getElementById("bedtime-sabori-note");
  const note = input.value.trim();
  if (!note) return;
  input.value = "";
  const li = document.createElement("li");
  li.innerHTML = `<span class="log-info"><span>${escapeHtml(note)}</span></span>`;
  document.getElementById("bedtime-sabori-list").appendChild(li);
  try {
    const at = nowLocalTimestamp();
    // 「開始〜終了を同時指定」する専用APIは作らず、既存の発動ログAPIをその場で
    // trigger→returnと連続で叩くことで代用している(トークンとエンドポイントの節約)。
    const { id } = await api("/api/activation-logs", {
      method: "POST",
      body: JSON.stringify({ triggered_at: at, note }),
    });
    await api(`/api/activation-logs/${id}/return`, {
      method: "PUT",
      body: JSON.stringify({ returned_at: at }),
    });
    loadActivationList();
  } catch (err) {
    li.remove();
    showToast("記録に失敗しました。もう一度お試しください");
  }
});

document.getElementById("bedtime-sabori-next").addEventListener("click", () => {
  document.getElementById("bedtime-step-sabori").classList.add("hidden");
  document.getElementById("bedtime-sabori-list").innerHTML = "";
  document.getElementById("bedtime-step2").classList.remove("hidden");
});

guardedSubmit(document.getElementById("bedtime-add-form"), async (e) => {
  const titleInput = document.getElementById("bedtime-add-title");
  const title = titleInput.value.trim();
  if (!title) return;
  titleInput.value = "";
  const li = document.createElement("li");
  li.innerHTML = `<span class="log-info"><span>${escapeHtml(title)}</span></span>`;
  document.getElementById("bedtime-added-list").appendChild(li);
  try {
    await api("/api/todos", {
      method: "POST",
      body: JSON.stringify({ title, due_date: addDaysToDate(todayStr(), 1) }),
    });
    loadTodos();
    loadCalendar();
  } catch (err) {
    li.remove();
    showToast(`「${title}」の追加に失敗しました。もう一度お試しください`);
  }
});

document.getElementById("bedtime-step2-done").addEventListener("click", closeBedtimePanel);

async function goToBed() {
  if (sleepActiveLog) return;
  const bedtime_at = nowLocalTimestamp();
  sleepActiveLog = { id: null, bedtime_at }; // idはPOST応答後にloadSleepActive()で正しい値に上書きされる
  renderSleepStatus();
  openBedtimePanel();
  try {
    await api("/api/sleep-logs", { method: "POST", body: JSON.stringify({ bedtime_at }) });
    await loadSleepActive();
    loadSleepPanel();
  } catch (err) {
    sleepActiveLog = null;
    renderSleepStatus();
    showToast("就寝の記録に失敗しました。もう一度お試しください");
  }
}

guardedClick(document.getElementById("sleep-now-wake-btn"), wakeUp);

document.getElementById("wake-mood-buttons").querySelectorAll(".mood-scale-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    wakeMoodScore = setBedtimeMoodScore(document.getElementById("wake-mood-buttons"), parseInt(btn.dataset.score, 10));
  });
});

document.getElementById("wake-mood-close").addEventListener("click", dismissWakeMoodPanel);
document.getElementById("wake-mood-backdrop").addEventListener("click", dismissWakeMoodPanel);

function toLocalTimestamp(d) {
  return `${formatLocalDate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;
}

// 寝ている状態のまま開いた朝(pending)と、記録がない夜の穴埋め(backfill)の保存
async function saveMorningSleep(mode, log, correctedWake, bed) {
  const wake_at = correctedWake ? toLocalTimestamp(correctedWake) : nowLocalTimestamp();
  if (mode === "pending") {
    sleepActiveLog = null;
    renderSleepStatus();
    try {
      await api(`/api/sleep-logs/${log.id}`, { method: "PUT", body: JSON.stringify({ wake_at }) });
    } catch (err) {
      showToast("起床の記録に失敗しました。もう一度お試しください");
    } finally {
      loadSleepActive();
      loadSleepPanel();
    }
  } else if (mode === "backfill" && bed) {
    try {
      const { id } = await api("/api/sleep-logs", { method: "POST", body: JSON.stringify({ bedtime_at: toLocalTimestamp(bed) }) });
      await api(`/api/sleep-logs/${id}`, { method: "PUT", body: JSON.stringify({ wake_at }) });
    } catch (err) {
      showToast("睡眠の記録に失敗しました。Sleepの履歴から追加できます");
    } finally {
      loadSleepActive();
      loadSleepPanel();
    }
  }
}

document.getElementById("wake-mood-save").addEventListener("click", async () => {
  const score = wakeMoodScore;
  const log = wakePanelLog;
  const mode = wakePanelMode;
  const correctedWake = wakeTimeFromInput();
  const bed = wakePanelBedtime();
  closeWakeMoodPanel();
  if (mode !== "recorded") {
    await saveMorningSleep(mode, log, correctedWake, bed);
  } else if (log && correctedWake) {
    const corrected = toLocalTimestamp(correctedWake);
    if (corrected.slice(0, 16) !== log.wake_at.slice(0, 16)) {
      try {
        await api(`/api/sleep-logs/${log.id}`, { method: "PUT", body: JSON.stringify({ wake_at: corrected }) });
        loadSleepPanel();
      } catch (err) {
        showToast("起床時刻の修正に失敗しました。Sleepの履歴から直せます");
      }
    }
  }
  if (score == null) return;
  try {
    await saveMoodScoreOnly(score);
  } catch (err) {
    showToast("気分の記録に失敗しました。もう一度お試しください");
  }
});

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
let lastKnownToday = todayStr();

// PWAはタブを閉じない限りバックグラウンドでもプロセスが生き続けるため、日付を跨いで前面に
// 戻ってきても「今日」に依存した表示(進捗バナー・カレンダーの今日ハイライト等)が古いまま
// 固定されてしまう(2026-09-21、日付跨ぎバグの一因として発覚)。定期的 + フォアグラウンド
// 復帰のたびにブラウザ側の日付が変わっていないか確認し、変わっていれば今日依存の表示だけ
// 再読み込みする。カレンダーが既に「今日」以外を表示中(ユーザーが手動でナビゲート済み)の
// 場合は選択日を勝手に動かさない。
async function refreshIfDayChanged() {
  const nowToday = todayStr();
  if (nowToday === lastKnownToday) return;
  const wasShowingToday = selectedCalDate === lastKnownToday;
  lastKnownToday = nowToday;
  if (wasShowingToday) {
    const now = new Date();
    selectedCalDate = nowToday;
    calYear = now.getFullYear();
    calMonth = now.getMonth() + 1;
    if (calViewMode === "week") calWeekStart = mondayOf(nowToday);
  }
  loadGoalProgress();
  loadTodos();
  loadTodoStats();
  if (typeof loadCalendar === "function") loadCalendar();
}
setInterval(refreshIfDayChanged, 60000);
let calTodosCache = [];
let calStudyDaysCache = new Set();
let calActivationDaysCache = new Set();
let calMinAchievedDaysCache = new Set();
// 月("YYYY-M")ごとの予定・記録マークの手持ちデータ。上のcalXxxCache(描画用)は、今表示している
// 期間に必要な月の分だけをここから組み立て直したもの(rebuildCalCaches)。以前は描画用キャッシュが
// 「最後に取った月」の分しか持たず、週表示が月をまたぐ(例: 9/28〜10/4)と取得完了まで画面が
// 切り替わらなかった(2026-09-28)。月単位で持つことで、手持ちの分は即描画→足りない分は後から埋める。
const calMonthData = new Map();
// 同じ月への取得が重なった時に、後から返ってきた古い方の結果で上書きしないための通し番号
const calMonthFetchSeq = new Map();
let calTodosFetchSeq = 0;
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

function calMonthPaths(key) {
  const [y, m] = key.split("-").map(Number);
  return [
    `/api/events?year=${y}&month=${m}`,
    `/api/study-logs/days?year=${y}&month=${m}`,
    `/api/activation-logs/days?year=${y}&month=${m}`,
    `/api/study-logs/minimum-achieved-days?year=${y}&month=${m}`,
  ];
}

// 端末のIndexedDBに前回分が残っていれば、まだ手持ちが無い月にだけ入れる(サーバーの結果は上書きしない)
async function hydrateCalMonthFromCache(key) {
  if (calMonthData.has(key)) return false;
  const [events, studyDays, activationDays, minAchievedDays] = await Promise.all(calMonthPaths(key).map(cacheGet));
  if (events === undefined || calMonthData.has(key)) return false;
  calMonthData.set(key, {
    events,
    studyDays: studyDays || [],
    activationDays: activationDays || [],
    minAchievedDays: minAchievedDays || [],
  });
  return true;
}

async function fetchCalMonth(key) {
  const seq = (calMonthFetchSeq.get(key) || 0) + 1;
  calMonthFetchSeq.set(key, seq);
  const [events, studyDays, activationDays, minAchievedDays] = await Promise.all(calMonthPaths(key).map((p) => api(p)));
  if (calMonthFetchSeq.get(key) !== seq) return;
  calMonthData.set(key, { events, studyDays, activationDays, minAchievedDays });
}

async function fetchCalTodos() {
  const seq = ++calTodosFetchSeq;
  const todos = await api("/api/todos");
  if (seq !== calTodosFetchSeq) return;
  calTodosCache = todos.filter((t) => t.due_date);
}

// ×で消した直後〜削除が確定するまで(Undoの5秒+通信)の予定。この間に別の理由で再描画されても
// 手持ちのデータから予定が復活しないよう、描画用の一覧から外しておく(2026-09-28)
const pendingEventDeleteIds = new Set();

function rebuildCalCaches() {
  const parts = [...neededCalMonthKeys()].map((k) => calMonthData.get(k)).filter(Boolean);
  calEventsCache = parts.flatMap((p) => p.events).filter((e) => !pendingEventDeleteIds.has(e.id));
  calStudyDaysCache = new Set(parts.flatMap((p) => p.studyDays));
  calActivationDaysCache = new Set(parts.flatMap((p) => p.activationDays));
  calMinAchievedDaysCache = new Set(parts.flatMap((p) => p.minAchievedDays));
}

// 予定タブは起動時にアクティブでないため後回しにされがちで、実際に開いたときに
// 空のグリッドがしばらく表示されてから埋まる、という遅さの原因になっていた。
// ToDoタブと同じく、前回取得したキャッシュから先に描画しておく(月・週どちらでも)。
async function hydrateCalendarFromCache() {
  const results = await Promise.all([...neededCalMonthKeys()].map(hydrateCalMonthFromCache));
  if (!calTodosCache.length) {
    const todos = await cacheGet("/api/todos");
    if (todos && !calTodosCache.length) calTodosCache = todos.filter((t) => t.due_date);
  }
  if (!results.some(Boolean)) return false;
  try {
    updateCalMonthLabel();
    renderCalendarView();
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
  rebuildCalCaches();
  const isWeek = calViewMode === "week";
  document.getElementById("cal-weekday-row").classList.toggle("hidden", isWeek);
  document.getElementById("cal-grid").classList.toggle("hidden", isWeek);
  document.getElementById("cal-week-view").classList.toggle("hidden", !isWeek);
  document.getElementById("cal-copy-week-btn").classList.toggle("hidden", !isWeek);

  if (isWeek) {
    renderWeekTimeGrid();
  } else {
    renderCalGrid();
  }
  renderCalDayDetail();
}

// 1. 手持ち(メモリ→無ければ端末キャッシュ)で即描画 2. サーバーから今の表示期間を取り直して再描画
// 3. 前後の期間を裏で先読み、の順。予定の追加・編集・削除の後もここを通るので、表示中の期間は毎回必ず取り直す。
// refreshTodayPanel=false は月/週の移動・切り替えなど、データを変えていない呼び出し用。
async function loadCalendar({ refreshTodayPanel = true } = {}) {
  if (refreshTodayPanel) loadTodayPanel(); // 予定の追加・編集・削除はすべてここを通るので、ToDoタブ横の「今日の予定」もここで追従させる
  updateCalMonthLabel();
  const monthKeys = [...neededCalMonthKeys()];
  if (monthKeys.some((k) => !calMonthData.has(k))) {
    await Promise.all(monthKeys.map(hydrateCalMonthFromCache));
  }
  renderCalendarView();

  await Promise.all([fetchCalTodos(), ...monthKeys.map(fetchCalMonth)]);
  renderCalendarView();
  scheduleCalPrefetch();
}

// 隣の月(週表示なら前後の週が含まれる月)を先に取っておき、←→やスワイプで移動した瞬間に描けるようにする。
// 起動直後の一斉読み込みと競合しないよう少し遅らせ、手持ちがある月は取り直さない
// (表示した時点でloadCalendarが取り直すので、ここで古くても実害はない)。
let calPrefetchTimer = null;
function scheduleCalPrefetch() {
  clearTimeout(calPrefetchTimer);
  calPrefetchTimer = setTimeout(() => {
    const keys = new Set();
    if (calViewMode === "week") {
      [addDaysToDate(calWeekStart, -7), addDaysToDate(calWeekStart, 13)].forEach((d) => {
        const dt = new Date(d + "T00:00:00");
        keys.add(`${dt.getFullYear()}-${dt.getMonth() + 1}`);
      });
    } else {
      [-1, 1].forEach((delta) => {
        const dt = new Date(calYear, calMonth - 1 + delta, 1);
        keys.add(`${dt.getFullYear()}-${dt.getMonth() + 1}`);
      });
    }
    keys.forEach((k) => {
      if (calMonthData.has(k)) return;
      fetchCalMonth(k)
        .then(() => {
          if (neededCalMonthKeys().has(k)) renderCalendarView();
        })
        .catch((err) => console.error(`calendar prefetch failed: ${k}`, err));
    });
  }, 1500);
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
      // スマホ幅では1件+「英語シ… +9 more」が読めなかったため、2件以上ある日は件数だけにする
      // (中身は日付をタップした下の一覧で見る)。1件だけの日は2026-08-16の方針通り名前を出す(2026-09-27)。
      const eventCap = calEventDisplayCap();
      let eventMark = "";
      if (dayEvents.length > 1 && eventCap === 1) {
        eventMark = `<div class="cal-events"><span class="cal-event-count"><i style="background:${colorFor(dayEvents[0].category || "")}"></i>${dayEvents.length}</span></div>`;
      } else if (dayEvents.length > 0) {
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
      ${ev.id == null ? "" : `<button class="delete-btn" title="Delete">×</button>`}
    `;
    li.querySelector(".delete-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (ev.recurrence && !confirm("This is a recurring event. Delete the entire series?")) return;
      // 以前はパネルの行を消すだけで、月グリッドには残り、Undo待ちの間に再描画されると行も復活していた
      undoableDelete(`Deleted "${ev.title}"`, {
        apply: () => {
          pendingEventDeleteIds.add(ev.id);
          renderCalendarView();
        },
        revert: () => {
          pendingEventDeleteIds.delete(ev.id);
          loadCalendar();
        },
        commit: async () => {
          await api(`/api/events/${ev.id}`, { method: "DELETE" });
          await loadCalendar().catch((err) => console.error("calendar reload failed:", err)); // 削除自体は成功しているので「失敗」扱いにしない
          pendingEventDeleteIds.delete(ev.id);
          renderCalendarView();
        },
      });
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
      const checkbox = e.currentTarget;
      const prevDone = t.done;
      t.done = t.done ? 0 : 1;
      li.classList.toggle("done", !!t.done);
      checkbox.checked = !!t.done;
      try {
        await api(`/api/todos/${t.id}/toggle`, { method: "POST" });
        loadTodos();
        loadTodoStats();
      } catch (err) {
        t.done = prevDone;
        li.classList.toggle("done", !!t.done);
        checkbox.checked = !!t.done;
        showToast("保存に失敗しました。もう一度お試しください");
      }
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
  loadCalendar({ refreshTodayPanel: false });
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
  loadCalendar({ refreshTodayPanel: false });
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
    // 手持ちのデータで即座に描き替え、足りない月だけ後から埋める(loadCalendar参照)。
    // 以前は足りない月があると取得完了まで画面が切り替わらなかった(2026-09-28)。
    loadCalendar({ refreshTodayPanel: false });
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

// ---------- 予定の先行反映(2026-09-29) ----------
// 追加・編集の保存と、その後のカレンダーの取り直しを待たずに、手持ちの月データへ先に反映して描き直す。
// 繰り返し予定はサーバー(main.py list_events)と同じ規則で、その月の該当日に展開する。
// eventId=nullは追加(仮の予定。idが届くまで開けない・消せない)、数値は編集(同じidの全回を差し替え)。
// 戻り値のrestore()で反映前に戻せる(保存失敗時用)。
function expandEventForMonth(ev, key) {
  const [y, m] = key.split("-").map(Number);
  const monthStart = isoDate(y, m, 1);
  const monthEnd = isoDate(y, m, daysInMonth(y, m));
  if (!ev.recurrence) {
    return ev.date >= monthStart && ev.date <= monthEnd ? [{ ...ev, occurrence_date: ev.date }] : [];
  }
  const days = new Set(ev.recurrence.split(","));
  const rangeStart = ev.date > monthStart ? ev.date : monthStart;
  const rangeEnd = ev.recurrence_until && ev.recurrence_until < monthEnd ? ev.recurrence_until : monthEnd;
  const out = [];
  for (let d = rangeStart; d <= rangeEnd; d = addDaysToDate(d, 1)) {
    const dow = (new Date(d + "T00:00:00").getDay() + 6) % 7; // 0 = Monday
    if (days.has(WEEKDAY_ORDER[dow])) out.push({ ...ev, occurrence_date: d });
  }
  return out;
}

function applyEventLocally(eventId, ev) {
  const snapshot = new Map(calMonthData);
  const full = { ...ev, id: eventId };
  calMonthData.forEach((data, key) => {
    const kept = eventId == null ? data.events : data.events.filter((e) => e.id !== eventId);
    const events = [...kept, ...expandEventForMonth(full, key)];
    events.sort((a, b) => a.occurrence_date.localeCompare(b.occurrence_date) || a.start_time.localeCompare(b.start_time));
    calMonthData.set(key, { ...data, events });
    // この反映より前に始まった取得が後から返ってきて、反映前の内容で上書きしないようにする
    calMonthFetchSeq.set(key, (calMonthFetchSeq.get(key) || 0) + 1);
  });
  const redraw = () => {
    try {
      renderCalendarView();
      const today = todayStr();
      const [y, m] = today.split("-").map(Number);
      const todayMonth = calMonthData.get(`${y}-${m}`);
      if (todayMonth) renderTodaySchedule(todayMonth.events.filter((e) => e.occurrence_date === today));
    } catch (err) {
      console.error("local event render failed", err);
    }
  };
  redraw();
  return {
    restore: () => {
      calMonthData.clear();
      snapshot.forEach((v, k) => calMonthData.set(k, v));
      redraw();
    },
  };
}

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
  const payload = {
    title,
    category,
    date: evDate,
    start_time: startTime,
    end_time: endTime,
    recurrence,
    recurrence_until: recurrence ? recurrenceUntilInput : null,
    notify_offset_minutes,
    note,
  };
  e.target.reset();
  setEventRecurrenceDays([]);
  closeEventAddPanel();
  const local = applyEventLocally(null, { ...payload, created_at: null, last_notified_occurrence: null });
  try {
    await api("/api/events", { method: "POST", body: JSON.stringify(payload) });
    loadCalendar();
  } catch (err) {
    local.restore();
    showToast(`「${title}」の追加に失敗しました。もう一度お試しください`);
  }
});

// ---------- copy last week's schedule ----------
// 2026-09-02に設計を確定した「先週の予定を来週にコピー」機能。バックエンドは変更せず、
// 既存の/api/eventsだけを使って(1)直近にコピー対象イベントがある週を自動でさかのぼって探し、
// (2)日付を+7日ずらし世界史の動画番号を採番し直したプレビューを出し、(3)確認・編集後に
// 1件ずつPOSTする、という構成。コピー対象はこの5種類の固定ブロックだけ(ELSA/アウトプット/
// 週1回枠は対象外、構成が変わった週は自動検出せず手動でstudy-tracker-planを使う前提)。
const COPYWEEK_FIXED_TITLES = new Set([
  "英語シャドーイング",
  "世界史復習",
  "vocab-app review mode",
  "vocab-app reading mode",
  "日記",
]);
const COPYWEEK_WORLD_VIDEO_RE = /^世界史(\d+)$/;

function isCopyweekScopeEvent(ev) {
  return COPYWEEK_FIXED_TITLES.has(ev.title) || COPYWEEK_WORLD_VIDEO_RE.test(ev.title);
}

function diffDays(a, b) {
  return Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000);
}

// 週またぎ検索のたびに同じ月を何度も叩かないための簡易キャッシュ(パネルを開くたびにクリア)。
let copyweekMonthCache = new Map();

async function copyweekFetchMonth(y, m) {
  const key = `${y}-${m}`;
  if (copyweekMonthCache.has(key)) return copyweekMonthCache.get(key);
  const promise = api(`/api/events?year=${y}&month=${m}`);
  copyweekMonthCache.set(key, promise);
  return promise;
}

async function copyweekFetchWeek(weekStart) {
  const weekEnd = addDaysToDate(weekStart, 6);
  const startD = new Date(weekStart + "T00:00:00");
  const endD = new Date(weekEnd + "T00:00:00");
  const keys = new Set([
    `${startD.getFullYear()}-${startD.getMonth() + 1}`,
    `${endD.getFullYear()}-${endD.getMonth() + 1}`,
  ]);
  const lists = await Promise.all(
    [...keys].map((k) => {
      const [y, m] = k.split("-").map(Number);
      return copyweekFetchMonth(y, m);
    })
  );
  return lists.flat().filter((e) => e.occurrence_date >= weekStart && e.occurrence_date <= weekEnd);
}

// targetWeekStartの前の週から最大12週さかのぼり、コピー対象イベントが1件でもある
// 直近の週を探す(「直近に予定が入っている週を自動選択」、2026-09-02決定)。
async function copyweekFindSourceWeek(targetWeekStart) {
  let cursor = addDaysToDate(targetWeekStart, -7);
  for (let i = 0; i < 12; i++) {
    const weekEvents = await copyweekFetchWeek(cursor);
    const scoped = weekEvents.filter(isCopyweekScopeEvent);
    if (scoped.length > 0) return { weekStart: cursor, events: scoped };
    cursor = addDaysToDate(cursor, -7);
  }
  return null;
}

// 世界史の動画番号は「検出できた最大値+1」から連番で振る(固定オフセットではなく、
// 2026-09-02決定)。直近3ヶ月分をスキャン対象にする。
async function copyweekMaxWorldNumber(aroundDate) {
  const anchor = new Date(aroundDate + "T00:00:00");
  const keys = [0, -1, -2].map((delta) => {
    const d = new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1);
    return [d.getFullYear(), d.getMonth() + 1];
  });
  const lists = await Promise.all(keys.map(([y, m]) => copyweekFetchMonth(y, m)));
  let max = 0;
  lists.flat().forEach((ev) => {
    const m = COPYWEEK_WORLD_VIDEO_RE.exec(ev.title);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return max;
}

let copyweekRows = []; // { title, category, date, start_time, end_time, note, conflict }

// 開始時刻は「先週の値をそのまま初期値にし、違う時だけ編集する」ハイブリッド方式
// (学習プラン.mdの「開始時刻は推測せず必ず確認する」ルールとの折衷、2026-09-02決定)。
// 日付は曜日オフセットで固定(構成変更の自動検出はしない=編集対象外)、
// 世界史の動画番号だけタイトルごと採番し直して編集可能にする。
function copyweekBuildRows(sourceWeekStart, targetWeekStart, sourceEvents, maxWorldNum) {
  let nextWorldNum = maxWorldNum + 1;
  return [...sourceEvents]
    .sort((a, b) => (a.occurrence_date + a.start_time).localeCompare(b.occurrence_date + b.start_time))
    .map((ev) => {
      const offset = diffDays(ev.occurrence_date, sourceWeekStart);
      let title = ev.title;
      if (COPYWEEK_WORLD_VIDEO_RE.test(ev.title)) {
        title = "世界史" + nextWorldNum;
        nextWorldNum += 1;
      }
      return {
        title,
        category: ev.category,
        date: addDaysToDate(targetWeekStart, offset),
        start_time: ev.start_time,
        end_time: ev.end_time,
        note: ev.note || null,
        conflict: null,
      };
    });
}

// コピー先の週に既存の予定と時間が重なるものがないかを調べ、行に警告を付ける
// (「警告して確認を求める」方式、2026-09-02決定。コミット時にconfirm()でも再確認する)。
async function copyweekAnnotateConflicts(rows, targetWeekStart) {
  const targetWeekEvents = await copyweekFetchWeek(targetWeekStart);
  rows.forEach((row) => {
    const hit = targetWeekEvents.find(
      (e) => e.occurrence_date === row.date && e.start_time < row.end_time && row.start_time < e.end_time
    );
    row.conflict = hit ? hit.title : null;
  });
}

function renderCopyweekList() {
  const list = document.getElementById("copyweek-list");
  const commitBtn = document.getElementById("copyweek-commit");
  const emptyMsg = document.getElementById("copyweek-empty");
  const conflictNote = document.getElementById("copyweek-conflict-note");

  emptyMsg.classList.toggle("hidden", copyweekRows.length > 0);
  commitBtn.classList.toggle("hidden", copyweekRows.length === 0);

  const conflictCount = copyweekRows.filter((r) => r.conflict).length;
  conflictNote.classList.toggle("hidden", conflictCount === 0);
  if (conflictCount > 0) {
    conflictNote.textContent = `⚠ ${conflictCount} event(s) overlap with an existing schedule on that day. Adjust the time, or confirm to create them alongside the existing ones.`;
  }

  list.innerHTML = copyweekRows
    .map(
      (row, i) => `
      <li class="copyweek-row${row.conflict ? " conflict" : ""}">
        <span class="log-icon" style="background:${colorFor(row.category || "")}"></span>
        <div class="copyweek-row-fields">
          <input type="text" data-i="${i}" data-field="title" value="${escapeHtml(row.title)}">
          <span class="meta">${row.date}</span>
          <input type="time" data-i="${i}" data-field="start_time" value="${row.start_time}">
          <input type="time" data-i="${i}" data-field="end_time" value="${row.end_time}">
        </div>
      </li>
    `
    )
    .join("");

  list.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      copyweekRows[Number(input.dataset.i)][input.dataset.field] = input.value;
    });
  });
}

async function openCopyweekPanel(targetWeekStart) {
  copyweekMonthCache = new Map();
  document.getElementById("copyweek-backdrop").classList.remove("hidden");
  document.getElementById("copyweek-panel").classList.remove("hidden");
  document.getElementById("copyweek-range").textContent = "Searching for the most recent week with a schedule…";
  document.getElementById("copyweek-list").innerHTML = "";
  document.getElementById("copyweek-empty").classList.add("hidden");
  document.getElementById("copyweek-conflict-note").classList.add("hidden");
  document.getElementById("copyweek-commit").classList.add("hidden");

  const targetWeekEnd = addDaysToDate(targetWeekStart, 6);
  const found = await copyweekFindSourceWeek(targetWeekStart);
  if (!found) {
    copyweekRows = [];
    document.getElementById("copyweek-range").textContent = `Target: ${targetWeekStart} 〜 ${targetWeekEnd}`;
    document.getElementById("copyweek-empty").classList.remove("hidden");
    return;
  }

  const maxWorldNum = await copyweekMaxWorldNumber(targetWeekStart);
  copyweekRows = copyweekBuildRows(found.weekStart, targetWeekStart, found.events, maxWorldNum);
  await copyweekAnnotateConflicts(copyweekRows, targetWeekStart);

  document.getElementById("copyweek-range").textContent =
    `Copying ${found.weekStart} 〜 ${addDaysToDate(found.weekStart, 6)} → ${targetWeekStart} 〜 ${targetWeekEnd}`;
  renderCopyweekList();
}

function closeCopyweekPanel() {
  document.getElementById("copyweek-backdrop").classList.add("hidden");
  document.getElementById("copyweek-panel").classList.add("hidden");
}

document.getElementById("copyweek-close").addEventListener("click", closeCopyweekPanel);
document.getElementById("copyweek-backdrop").addEventListener("click", closeCopyweekPanel);

guardedClick(document.getElementById("copyweek-commit"), async () => {
  if (copyweekRows.length === 0) return;
  const conflictCount = copyweekRows.filter((r) => r.conflict).length;
  if (conflictCount > 0 && !confirm(`${conflictCount} event(s) overlap with an existing schedule. Copy anyway?`)) {
    return;
  }
  const copiedCount = copyweekRows.length;
  closeCopyweekPanel();
  try {
    // 1件ずつ直列でawaitしていたため件数分の往復を待たされていた。まとめて並列送信に変更(2026-09-05)
    await Promise.all(
      copyweekRows.map((row) =>
        api("/api/events", {
          method: "POST",
          body: JSON.stringify({
            title: row.title,
            category: row.category,
            date: row.date,
            start_time: row.start_time,
            end_time: row.end_time,
            recurrence: null,
            recurrence_until: null,
            notify_offset_minutes: 0,
            note: row.note,
          }),
        })
      )
    );
    showToast(`Copied ${copiedCount} event(s).`);
  } catch (err) {
    showToast("一部の予定のコピーに失敗しました。カレンダーを確認してください");
  } finally {
    if (document.getElementById("tab-calendar").classList.contains("active")) loadCalendar();
  }
});

document.getElementById("cal-copy-week-btn").addEventListener("click", () => {
  openCopyweekPanel(calWeekStart);
});

// 就寝前パネルからも同じ導線を開けるようにする(ハイブリッド配置、2026-09-02決定)。
// 対象は「明日を含む週」(明日が週をまたぐ場合はその翌週)。
document.getElementById("bedtime-copy-week-btn").addEventListener("click", () => {
  closeBedtimePanel();
  openCopyweekPanel(mondayOf(addDaysToDate(todayStr(), 1)));
});

// ---------- event detail panel ----------

let currentDetailEventId = null;

function openEventDetail(ev) {
  if (ev.id == null) return; // 追加直後の仮の予定(applyEventLocally)。サーバーのidが届くまで開かせない
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
  const payload = {
    title,
    category,
    date: evDate,
    start_time: startTime,
    end_time: endTime,
    recurrence,
    recurrence_until: recurrence ? recurrenceUntilInput : null,
    notify_offset_minutes,
    note,
  };
  const eventId = currentDetailEventId;
  document.getElementById("event-detail-status").textContent = "Saved";
  closeEventDetail();
  const prevEvent = [...calMonthData.values()].flatMap((d) => d.events).find((x) => x.id === eventId);
  const local = applyEventLocally(eventId, { ...(prevEvent || {}), ...payload });
  try {
    await api(`/api/events/${eventId}`, { method: "PUT", body: JSON.stringify(payload) });
    loadCalendar();
  } catch (err) {
    local.restore();
    showToast(`「${title}」の保存に失敗しました。もう一度お試しください`);
  }
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

// 起動直後に見えるToDoタブ(一覧・統計)だけ、前回取得したキャッシュを
// 即座に描画する。本物の読み込み(critical group)はこの後も従来通り必ず走るので、
// ここで描けなくても・描いた内容が古くても実害はない(すぐ上書きされる)。
async function hydrateFromCache() {
  const [todos, stats] = await Promise.all([
    cacheGet("/api/todos"),
    cacheGet("/api/todos/stats"),
  ]);
  let hydrated = false;
  try {
    if (todos) { allTodos = todos; renderTodos(); hydrated = true; }
  } catch (err) { console.error("hydrate todos failed:", err); }
  try {
    if (stats) { renderTodoStats(stats); hydrated = true; }
  } catch (err) { console.error("hydrate todo stats failed:", err); }
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

  // study-buttons and the chart's subject list depend on categories being loaded first.
  // 前回分が端末にあればそれで先に進む(最新の取得は裏で続く)。
  await loadCategories({ preferCache: true });
  restoreSession();
  flushPendingStudyLogs(); // 前回Stop直後に閉じて送れなかった記録があれば再送(awaitしない)
  startPeerSessionPolling(); // "studying on another device" banner; own timer (if any) already restored above
  // PC/タブレットの利用時間はこの端末を操作していなくても裏で増えていくため、
  // ユーザー操作をきっかけにした再読込(上のloadScreenBudget呼び出し)だけでは反映が遅れる。
  // peer-session-bannerと同じ30秒ポーリングで補う。
  setInterval(loadScreenBudget, 30000);

  // 以前は「ToDo→期限切れスキップ→残り15件」と段階ごとに前の完了を待っていたため、Scores・
  // 勉強ログ・カレンダーは最初の2段が終わるまで読み込みが始まりすらしなかった(2026-09-28)。
  // 今は全部同時に読み始め、起動画面だけは最初に見えるToDoタブの分が揃った時点で閉じる。
  const critical = Promise.allSettled([loadTodos(), loadTodoStats()]);
  const background = Promise.allSettled([
    loadTodayPanel(),
    loadStudySummary(),
    loadStudyLogList(),
    loadStudyChart(),
    loadActivityHeatmap(),
    loadHourlyChart(),
    loadGoalProgress(),
    loadScreenBudget(),
    loadScoresTab(),
    loadStudyDrivers(),
    loadActivationActive(),
    loadActivationList(),
    loadActivationStats(),
    loadActivationPostReturnStats(),
    loadActivationMoodReasons(),
    loadSleepActive(),
    loadCalendar({ refreshTodayPanel: false }),
  ]);

  const criticalResults = await critical;
  criticalResults.filter((r) => r.status === "rejected").forEach((r) => console.error("init load failed:", r.reason));
  document.getElementById("boot-loading")?.classList.add("hidden");

  // スキップしたToDoは「今日の予定」やカレンダーにも出ているので、それらは同時読み込みの後で取り直す
  if (await autoSkipOverdueTodos()) {
    background.then(() => loadCalendar());
  }

  const backgroundResults = await background;
  backgroundResults.filter((r) => r.status === "rejected").forEach((r) => console.error("init load failed:", r.reason));

  // 就寝リマインダーpush(main.pyのbedtime-reminder)のタップから、アプリ未起動時は
  // /#bedtime付きの新規ウィンドウとして開かれる。既存ウィンドウ再利用時はSWからのpostMessageで拾う。
  if (location.hash === "#bedtime") {
    history.replaceState(history.state, "", location.pathname + location.search); // タブの履歴は残す
    openBedtimePanel();
  }
  maybeShowMorningPanel().catch((err) => console.error("morning prompt failed:", err));
})();

// ---------- mood tab sub-tabs (2026-09-27) ----------
// 最後に開いていたサブタブは端末ごとの使い勝手なのでlocalStorageで覚える

function switchMoodSubtab(sub) {
  document.querySelectorAll("#mood-subtabs .period-btn").forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
  document.querySelectorAll(".mood-subpanel").forEach((p) => p.classList.toggle("hidden", p.dataset.sub !== sub));
  try {
    localStorage.setItem("moodSubtab", sub);
  } catch {
    // 保存できなくても切り替え自体は効く
  }
}

document.querySelectorAll("#mood-subtabs .period-btn").forEach((b) => {
  b.addEventListener("click", () => switchMoodSubtab(b.dataset.sub));
});

// Study: Log / Scores(2026-10-02、Scoresタブを統合)。Scoresはたまに見るだけなので覚えずに毎回Logから
function switchStudySubtab(sub) {
  document.querySelectorAll("#study-subtabs .period-btn").forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
  document.querySelectorAll(".study-subpanel").forEach((p) => p.classList.toggle("hidden", p.dataset.sub !== sub));
  // Insightsはたまに見るだけなので、開いた時に読み込む(起動時の通信を増やさない)
  if (sub === "insights") loadInsightsMatrix().catch((err) => console.error("insights load failed:", err));
}

document.querySelectorAll("#study-subtabs .period-btn").forEach((b) => {
  b.addEventListener("click", () => switchStudySubtab(b.dataset.sub));
});

try {
  const savedSub = localStorage.getItem("moodSubtab");
  if (savedSub && document.querySelector(`.mood-subpanel[data-sub="${savedSub}"]`)) switchMoodSubtab(savedSub);
} catch {
  // 既定のMoodのまま
}

// ---------- ⚡ record menu (2026-10-02) ----------
// 勉強・気分・睡眠・サボり・ToDo・予定の「記録の入口」をここ1か所にまとめた。
// 以前は右上の🛏/🧭・各タブ右下の▶/＋・Moodタブ内のボタンに散らばっていて、
// 睡眠は2か月で約半分の夜、気分は65%が理由なし、という取りこぼしが出ていた。
// 進行中のもの(タイマー・睡眠・サボり)があれば一番上の「Now」から1タップで終われる。

const quickPanel = document.getElementById("quick-panel");
const quickBackdrop = document.getElementById("quick-backdrop");
let quickNowTick = null;
// メニューを開いている間に保存した気分(数字を押し直したら新規ではなく上書きにする)
let quickMood = null; // { id, score, saving: Promise }

function openQuickPanel() {
  if (!quickPanel.classList.contains("hidden")) return;
  quickMood = null;
  renderQuickPanel();
  quickPanel.classList.remove("hidden");
  quickBackdrop.classList.remove("hidden");
  document.body.classList.add("quick-open");
  document.querySelectorAll(".quick-btn").forEach((b) => b.classList.add("open"));
  quickNowTick = setInterval(renderQuickNow, 1000);
}

function closeQuickPanel() {
  quickPanel.classList.add("hidden");
  quickBackdrop.classList.add("hidden");
  document.body.classList.remove("quick-open");
  document.querySelectorAll(".quick-btn").forEach((b) => b.classList.remove("open"));
  clearInterval(quickNowTick);
  quickNowTick = null;
  endSubjectPick();
}

document.querySelectorAll(".quick-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (quickPanel.classList.contains("hidden")) openQuickPanel();
    else closeQuickPanel();
  });
});
quickBackdrop.addEventListener("click", closeQuickPanel);

function renderQuickPanel() {
  renderQuickNow();
  const running = !!timerSubject;
  document.getElementById("quick-subjects").classList.toggle("disabled", running);
  document.querySelectorAll("#quick-subjects .subject-btn").forEach((b) => { b.disabled = running; });
  document.getElementById("quick-study-note").classList.toggle("hidden", !running);
  document.getElementById("quick-bed-btn").classList.toggle("hidden", !!sleepActiveLog);
  document.getElementById("quick-slack-btn").classList.toggle("hidden", !!activationActiveLog);
  document.getElementById("quick-life-section").classList.toggle("hidden", !!sleepActiveLog && !!activationActiveLog);
  renderQuickMood();
}

// Now: 1秒ごとに描き直す(タイマーの数字が進むため)。ボタンはdata-actで1か所の委譲ハンドラが拾う
function renderQuickNow() {
  const items = [];
  if (timerSubject) {
    const mode = sessionMode === "countdown" ? "Countdown" : "Timer";
    items.push(`
      <div class="quick-now-card" style="--subject-color:${colorFor(timerSubject)}">
        <div class="quick-now-text">
          <span class="meta">${escapeHtml(timerSubject)} · ${mode}${isPaused ? " · Paused" : ""}</span>
          <span class="quick-now-time">${escapeHtml(document.getElementById("mini-timer-time").textContent)}</span>
        </div>
        <button type="button" class="secondary quick-now-btn" data-act="pause" aria-label="Pause/Resume">${isPaused ? "▶" : "⏸"}</button>
        <button type="button" class="quick-now-btn" data-act="stop">■ Stop</button>
      </div>`);
  }
  if (sleepActiveLog) {
    items.push(`
      <div class="quick-now-card sleep">
        <div class="quick-now-text"><span>${ICONS.moon} ${sleepElapsedLabel()}</span></div>
        <button type="button" class="quick-now-btn" data-act="wake">☀ I'm up</button>
      </div>`);
  }
  if (activationActiveLog) {
    items.push(`
      <div class="quick-now-card slack">
        <div class="quick-now-text"><span>${ICONS.alert} ${activationElapsedLabel()}</span></div>
        <button type="button" class="quick-now-btn" data-act="return">Back to work</button>
      </div>`);
  }
  const list = document.getElementById("quick-now-list");
  const html = items.join("");
  // 押している最中に描き直すとタップが失われるため、中身が変わった時だけ差し替える
  if (list.dataset.html !== html) {
    list.innerHTML = html;
    list.dataset.html = html;
  }
  document.getElementById("quick-now-section").classList.toggle("hidden", items.length === 0);
}

document.getElementById("quick-now-list").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  if (act === "pause") {
    if (isPaused) resumeSession();
    else pauseSession();
    renderQuickPanel();
    return;
  }
  closeQuickPanel();
  if (act === "stop") await stopAndSaveSession();
  else if (act === "wake") await wakeUp();
  else if (act === "return") await returnActivation();
});

// ---- Mood: 数字を押した瞬間に保存し、そのあと理由を小さく聞く ----

function renderQuickMood() {
  const row = document.getElementById("quick-mood-row");
  if (!row.children.length) {
    row.innerHTML = Array.from({ length: 10 }, (_, i) => `<button type="button" class="quick-mood-btn" data-score="${i + 1}">${i + 1}</button>`).join("");
    row.querySelectorAll(".quick-mood-btn").forEach((btn) => {
      btn.addEventListener("click", () => quickSaveMood(parseInt(btn.dataset.score, 10)));
    });
  }
  row.querySelectorAll(".quick-mood-btn").forEach((b) => {
    b.classList.toggle("active", !!quickMood && parseInt(b.dataset.score, 10) === quickMood.score);
  });
  document.getElementById("quick-mood-reason").classList.toggle("hidden", !quickMood);
  const status = document.getElementById("quick-mood-status");
  const todays = (lastMoodPanelData?.rows || []).filter((r) => r.date === todayStr());
  const last = todays[todays.length - 1];
  status.textContent = quickMood ? "" : last ? `Last: ${last.score} at ${(last.logged_at || "").slice(11, 16)}` : "Not logged today";
}

function renderQuickMoodReasons(score) {
  const tier = moodTierForScore(score);
  // 理由の候補はMoodタブの選択肢と同じものを使う(ラベルを2か所で持たないため)
  const reasons = [...document.querySelectorAll("#mood-reason-picker .reason-btn")]
    .filter((b) => tier === "mid" || b.dataset.tier === tier || b.dataset.tier === "both")
    .map((b) => ({ reason: b.dataset.reason, label: b.textContent }));
  const picker = document.getElementById("quick-mood-reason-picker");
  picker.innerHTML = reasons
    .map((r) => `<button type="button" class="reason-btn" data-reason="${escapeHtml(r.reason)}">${escapeHtml(r.label)}</button>`)
    .join("");
  picker.querySelectorAll(".reason-btn").forEach((btn) => {
    btn.addEventListener("click", () => quickSetMoodReason(btn.dataset.reason));
  });
}

async function quickSaveMood(score) {
  if (quickMood) {
    // 押し直しは同じ記録の数字だけ直す(1回の気分が2件に分かれないように)
    quickMood.score = score;
    renderQuickMood();
    renderQuickMoodReasons(score);
    try {
      const id = await quickMood.saving;
      await api(`/api/mood-logs/${id}`, { method: "PUT", body: JSON.stringify({ score }) });
      loadMoodPanel();
    } catch (err) {
      showToast("気分の記録に失敗しました。もう一度お試しください");
    }
    return;
  }
  const entry = { date: todayStr(), score, logged_at: nowLocalTimestamp() };
  const before = lastMoodPanelData;
  if (before) renderMoodPanel({ ...before, rows: [...before.rows, { id: null, note: null, reason: null, ...entry }] });
  const saving = api("/api/mood-logs", { method: "POST", body: JSON.stringify(entry) }).then((r) => r.id);
  quickMood = { score, saving };
  renderQuickMood();
  renderQuickMoodReasons(score);
  try {
    await saving;
    loadMoodPanel();
    loadMoodStats();
  } catch (err) {
    if (before) renderMoodPanel(before);
    quickMood = null;
    renderQuickMood();
    showToast("気分の記録に失敗しました。もう一度お試しください");
  }
}

async function quickSetMoodReason(reason) {
  const mood = quickMood;
  if (!mood) return;
  closeQuickPanel();
  try {
    const id = await mood.saving;
    await api(`/api/mood-logs/${id}`, { method: "PUT", body: JSON.stringify({ reason }) });
    loadMoodPanel();
  } catch (err) {
    showToast("理由の保存に失敗しました。Moodタブから記録できます");
  }
}

// ---- Life / Add / Settings ----

document.getElementById("quick-bed-btn").addEventListener("click", () => {
  closeQuickPanel();
  goToBed();
});
document.getElementById("quick-slack-btn").addEventListener("click", () => {
  closeQuickPanel();
  openActivationPanel();
});
document.getElementById("quick-todo-btn").addEventListener("click", () => {
  closeQuickPanel();
  openTodoAddPanel();
});
document.getElementById("quick-event-btn").addEventListener("click", () => {
  closeQuickPanel();
  openEventAddPanel();
});
document.getElementById("quick-settings-btn").addEventListener("click", () => {
  closeQuickPanel();
  openSettingsPanel();
});

// 帯の文字部分をタップしたら⚡メニューを開く(ボタン部分はそれぞれの操作)
["sleep-now", "slack-now"].forEach((id) => {
  document.getElementById(id).addEventListener("click", (e) => {
    if (!e.target.closest("button")) openQuickPanel();
  });
});

// ---------- keyboard shortcuts (2026-09-27) ----------
// PCで開いている時用。1文字キーは入力欄に文字を打っている間は無効(Escだけは入力中でも効く)。
// Ctrl+数字のタブ切替・開始パネルのEnterは上の方で個別に定義済み。

const shortcutPanel = document.getElementById("shortcut-panel");
const shortcutBackdrop = document.getElementById("shortcut-backdrop");

function openShortcutPanel() {
  shortcutPanel.classList.remove("hidden");
  shortcutBackdrop.classList.remove("hidden");
}

function closeShortcutPanel() {
  shortcutPanel.classList.add("hidden");
  shortcutBackdrop.classList.add("hidden");
}

document.getElementById("shortcut-close").addEventListener("click", closeShortcutPanel);
shortcutBackdrop.addEventListener("click", closeShortcutPanel);
document.getElementById("shortcut-open-btn").addEventListener("click", () => {
  document.getElementById("settings-close").click();
  openShortcutPanel();
});

function isTypingTarget(el) {
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

function visiblePanels() {
  return [...document.querySelectorAll(".add-panel")].filter((p) => !p.classList.contains("hidden"));
}

function activeTabId() {
  return document.querySelector(".tab-panel.active")?.id;
}

// S → 数字: 科目ミニメニューを開いて各ボタンに番号を振り、次に押された数字で開始パネルを開く
let subjectPickTimer = null;

// 2026-10-02からはSで⚡メニューを開き、その中の科目に番号を振る(タイマー中は番号なしで開く)
function startSubjectPick() {
  openQuickPanel();
  if (timerSubject) return;
  document.getElementById("quick-subjects").classList.add("numbered");
  clearTimeout(subjectPickTimer);
  subjectPickTimer = setTimeout(endSubjectPick, 5000);
}

function endSubjectPick() {
  clearTimeout(subjectPickTimer);
  subjectPickTimer = null;
  document.getElementById("quick-subjects").classList.remove("numbered");
}

function closeTopmostLayer() {
  if (!shortcutPanel.classList.contains("hidden")) {
    closeShortcutPanel();
    return true;
  }
  if (!quickPanel.classList.contains("hidden")) {
    closeQuickPanel();
    return true;
  }
  const panels = visiblePanels();
  if (panels.length) {
    panels[panels.length - 1].querySelector(".panel-close")?.click();
    return true;
  }
  if (timerSubject && !overlayMinimized && !document.getElementById("focus-overlay").classList.contains("hidden")) {
    minimizeFocusOverlay();
    return true;
  }
  return false;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (closeTopmostLayer()) e.preventDefault();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;

  if (subjectPickTimer && /^[1-9]$/.test(e.key) && !quickPanel.classList.contains("hidden")) {
    const btn = document.querySelectorAll("#quick-subjects .subject-btn")[Number(e.key) - 1];
    endSubjectPick();
    if (btn) {
      e.preventDefault();
      btn.click();
    }
    return;
  }

  if (e.key === " " && timerSubject) {
    e.preventDefault();
    if (isPaused) resumeSession();
    else pauseSession();
    return;
  }

  // パネルが開いている間はEsc以外の1文字キーで別のパネルを重ねない
  if (visiblePanels().length) return;

  const key = e.key.toLowerCase();
  if (e.key === "?") {
    e.preventDefault();
    openShortcutPanel();
  } else if (key === "n") {
    const tab = activeTabId();
    if (tab === "tab-todo") openTodoAddPanel();
    else if (tab === "tab-calendar") openEventAddPanel();
    else return;
    e.preventDefault(); // 開いたパネルのタイトル欄に「n」が入らないように
  } else if (key === "s") {
    e.preventDefault();
    startSubjectPick();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "navigate" && event.data.url && event.data.url.includes("#bedtime")) {
      openBedtimePanel();
    }
  });
}
