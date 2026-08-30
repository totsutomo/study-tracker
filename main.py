import calendar
import csv
import hashlib
import html
import io
import json
import os
import secrets
import zipfile
from datetime import date, datetime, timedelta
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from pywebpush import WebPushException, webpush

from database import get_connection, init_db, row_to_dict, rows_to_dicts

app = FastAPI(title="Compass")

init_db()

def _env_token(name: str) -> str | None:
    # Renderの環境変数入力欄は複数行テキストエリアで、コピペ時に先頭/末尾へ改行や空白が
    # 紛れ込んでも見た目では気づきにくい。トークン比較はここで一度だけstripしておき、
    # 「画面上は正しく見えるのに一致しない」事故を防ぐ。
    value = os.environ.get(name)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY")
VAPID_CLAIMS_EMAIL = os.environ.get("VAPID_CLAIMS_EMAIL", "example@example.com")
CRON_SECRET = _env_token("CRON_SECRET")
# JpBlocker(Androidネイティブの連携アプリ)からの通信を認証するための共有トークン。
# CRON_SECRETとは用途が別(外部cronサービス vs 自分のAndroid端末)なので分けている。
DEVICE_TOKEN = _env_token("DEVICE_TOKEN")
# vocab-app(Vercel、別オリジン)からの復習セッション自動記録を認証する共有トークン。
# DEVICE_TOKEN/CRON_SECRETとも用途が別(ブラウザから直接叩かれる、かつ発行元がAnthropicキー
# と同じくクライアントバンドルに埋め込まれる=「見えても仕方ない」前提)なので分けている。
VOCAB_APP_TOKEN = _env_token("VOCAB_APP_TOKEN")
# CORSはこのエンドポイント1本にだけ手動でヘッダーを付与する方式にしている(CORSMiddlewareで
# 全体に許可すると、todos/events/pending-changes等トークンなしの既存エンドポイントまで
# 一括でvocab-appの生JSから読み書き可能になってしまうため、意図的にグローバル許可はしない)。
VOCAB_APP_ORIGIN = os.environ.get("VOCAB_APP_ORIGIN", "https://vocab-app-blue-xi.vercel.app")
# 美緒専用の承認ページ(/approve)のトークン。DEVICE_TOKENと分けているのは信頼境界が
# 違うため(こちらは美緒だけが使う想定で、とっつーのAndroid端末は使わない)。
# 環境変数名は移行前の PIN_CUSTODY_TOKEN のまま据え置いている(Render側の値を
# 再設定する手間・事故を避けるため。中身の意味は「PIN管理者」から「承認者」に変わった)。
# 注意: このトークンはとっつー自身もRenderの環境変数として見える/設定できる。
# 「承認操作そのものを本人にさせない」ことがこの仕組みの目的であり、
# 「本人が絶対に上書きできない」ことは目的にしていない(教訓: 自分がインフラの所有者である
# 以上、本気で上書きしようとすれば技術的には可能。ここは意図的な操作への抑止力ではなく、
# 衝動的な自己解除への摩擦として設計している)。
APPROVAL_TOKEN = _env_token("PIN_CUSTODY_TOKEN")
# 設定変更が承認ウィンドウ内に申請されても即反映されない猶予時間。ここはスキップしない
# (「エスケープなし」方針を承認ガード全体にも適用する)。
PENDING_CHANGE_DELAY_HOURS = 24


def _load_last_updated() -> str:
    build_info_path = os.path.join(os.path.dirname(__file__), "build_info.txt")
    try:
        with open(build_info_path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return datetime.now().astimezone().isoformat()


LAST_UPDATED = _load_last_updated()


# ---------- schemas ----------

class TodoCreate(BaseModel):
    title: str
    category: str | None = None
    priority: str = "medium"
    due_date: str | None = None
    due_time: str | None = None  # "HH:MM", optional
    recurrence: str | None = None  # None, or comma-separated weekday codes e.g. "mon,wed,fri"
    notify_offset_minutes: int | None = None  # None = no notification, 0 = at due time, N = N minutes before
    note: str | None = None


class TodoNoteUpdate(BaseModel):
    note: str | None = None


class TodoDueUpdate(BaseModel):
    due_date: str | None = None
    due_time: str | None = None


class TodoUpdate(BaseModel):
    title: str
    category: str | None = None
    priority: str = "medium"
    due_date: str | None = None
    due_time: str | None = None
    recurrence: str | None = None
    notify_offset_minutes: int | None = None
    note: str | None = None


class CategoryCreate(BaseModel):
    name: str


class CategoryUpdate(BaseModel):
    name: str


class SettingsUpdate(BaseModel):
    weekly_goal_minutes: int | None = None
    monthly_goal_minutes: int | None = None
    daily_minimum_minutes: int | None = None
    countdown_label: str | None = None
    countdown_target_date: str | None = None  # "YYYY-MM-DD"


class FocusSessionSync(BaseModel):
    remaining_seconds: int | None = None  # None = no active countdown (paused/stopped)
    subject: str | None = None


class SessionActiveSync(BaseModel):
    active: bool  # true = session running (started, not yet finished/discarded)
    subject: str | None = None


class StudyLogCreate(BaseModel):
    subject: str
    minutes: int
    note: str | None = None
    logged_at: str | None = None  # "YYYY-MM-DD HH:MM:SS", optional; defaults to now
    start_trigger: str | None = None


class VocabAppStudyLogCreate(BaseModel):
    mode: str  # "review" | "reading" | "news" などvocab-app側のタブ名。start_triggerにvocab-app:{mode}として記録
    subject: str = "英語"
    minutes: int
    count: int | None = None  # 例: 復習した単語数
    unit: str | None = None  # "words" | "pages" | "articles"
    logged_at: str | None = None  # "YYYY-MM-DD HH:MM:SS", client(vocab-app)local time


class GoalCreate(BaseModel):
    title: str


class EventCreate(BaseModel):
    title: str
    category: str | None = None
    date: str  # "YYYY-MM-DD"; anchor date, or first occurrence when recurring
    start_time: str  # "HH:MM"
    end_time: str  # "HH:MM"
    recurrence: str | None = None  # None, or comma-separated weekday codes e.g. "mon,wed,fri"
    recurrence_until: str | None = None  # "YYYY-MM-DD", only meaningful when recurrence is set
    notify_offset_minutes: int | None = None  # None = no notification, 0 = at start time, N = N minutes before
    note: str | None = None


class EventUpdate(BaseModel):
    title: str
    category: str | None = None
    date: str
    start_time: str
    end_time: str
    recurrence: str | None = None
    recurrence_until: str | None = None
    notify_offset_minutes: int | None = None
    note: str | None = None


class PushSubscribeIn(BaseModel):
    endpoint: str
    keys: dict


class ActivationLogCreate(BaseModel):
    triggered_at: str  # "YYYY-MM-DD HH:MM:SS", client local time
    note: str | None = None
    mood: str | None = None  # "good" | "normal" | "heavy"
    mood_reason: str | None = None  # only meaningful when mood == "heavy"


class ActivationLogReturn(BaseModel):
    returned_at: str  # "YYYY-MM-DD HH:MM:SS", client local time


class MoodLogCreate(BaseModel):
    date: str  # "YYYY-MM-DD", client local date
    score: int  # 1-10
    note: str | None = None
    reason: str | None = None
    logged_at: str | None = None  # "YYYY-MM-DD HH:MM:SS", client local time


class SleepLogCreate(BaseModel):
    bedtime_at: str  # "YYYY-MM-DD HH:MM:SS", client local time


class SleepLogUpdate(BaseModel):
    bedtime_at: str | None = None  # "YYYY-MM-DD HH:MM:SS"; omitted fields are left unchanged
    wake_at: str | None = None


class ScreenTimeUpsert(BaseModel):
    date: str  # "YYYY-MM-DD", client(JpBlocker)local date
    total_minutes: int
    by_app: str | None = None  # optional JSON文字列(アプリ別内訳、パッケージ名→分)


class ApproveIn(BaseModel):
    token: str
    pin: str


class PinSetIn(BaseModel):
    token: str
    pin: str
    current_pin: str | None = None


class PendingChangeCreate(BaseModel):
    action_type: str
    payload: str  # JSON文字列。中身はJpBlocker側のPendingActionと1:1対応、サーバーはパースしない


WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]  # index matches date.weekday()


def next_occurrence(base: date, recurrence: str) -> date | None:
    days = set(recurrence.split(",")) if recurrence else set()
    if not days:
        return None
    for offset in range(1, 8):
        candidate = base + timedelta(days=offset)
        if WEEKDAY_CODES[candidate.weekday()] in days:
            return candidate
    return None


# ---------- todos ----------

@app.get("/api/todos")
def list_todos():
    conn = get_connection()
    cur = conn.execute(
        """
        SELECT * FROM todos
        ORDER BY done ASC, (due_date IS NULL) ASC, due_date ASC,
                 CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC,
                 created_at DESC
        """
    )
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.get("/api/todos/stats")
def todo_stats():
    conn = get_connection()
    total = conn.execute("SELECT COUNT(*) FROM todos").fetchone()[0]
    done_count = conn.execute("SELECT COUNT(*) FROM todos WHERE done = 1").fetchone()[0]
    cur = conn.execute(
        """
        SELECT date(completed_at) AS d, COUNT(*) AS c
        FROM todos
        WHERE done = 1 AND completed_at >= datetime('now', '-6 days')
        GROUP BY d
        ORDER BY d
        """
    )
    daily = rows_to_dicts(cur)
    conn.close()
    rate = round(done_count / total * 100) if total else 0
    return {"total": total, "done": done_count, "rate": rate, "daily": daily}


@app.post("/api/todos")
def create_todo(todo: TodoCreate):
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO todos (title, category, priority, due_date, due_time, recurrence, notify_offset_minutes, note) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (todo.title, todo.category, todo.priority, todo.due_date, todo.due_time, todo.recurrence,
         todo.notify_offset_minutes if todo.due_time else None, todo.note),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


@app.put("/api/todos/{todo_id}/note")
def update_todo_note(todo_id: int, payload: TodoNoteUpdate):
    conn = get_connection()
    row = conn.execute("SELECT id FROM todos WHERE id = ?", (todo_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="todo not found")
    conn.execute("UPDATE todos SET note = ? WHERE id = ?", (payload.note, todo_id))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.put("/api/todos/{todo_id}/due")
def update_todo_due(todo_id: int, payload: TodoDueUpdate):
    conn = get_connection()
    row = conn.execute("SELECT id FROM todos WHERE id = ?", (todo_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="todo not found")
    conn.execute(
        "UPDATE todos SET due_date = ?, due_time = ?, notified_at = NULL WHERE id = ?",
        (payload.due_date, payload.due_time, todo_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.put("/api/todos/{todo_id}")
def update_todo(todo_id: int, todo: TodoUpdate):
    conn = get_connection()
    row = conn.execute("SELECT id FROM todos WHERE id = ?", (todo_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="todo not found")
    conn.execute(
        "UPDATE todos SET title = ?, category = ?, priority = ?, due_date = ?, due_time = ?, "
        "recurrence = ?, notify_offset_minutes = ?, note = ?, notified_at = NULL WHERE id = ?",
        (todo.title, todo.category, todo.priority, todo.due_date, todo.due_time, todo.recurrence,
         todo.notify_offset_minutes if todo.due_time else None, todo.note, todo_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/todos/{todo_id}/toggle")
def toggle_todo(todo_id: int):
    conn = get_connection()
    row = conn.execute(
        "SELECT done, title, category, priority, due_date, due_time, recurrence, notify_offset_minutes, note "
        "FROM todos WHERE id = ?",
        (todo_id,),
    ).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="todo not found")
    done, title, category, priority, due_date, due_time, recurrence, notify_offset_minutes, note = row
    new_done = 0 if done else 1
    completed_at = "datetime('now')" if new_done else "NULL"
    conn.execute(
        f"UPDATE todos SET done = ?, completed_at = {completed_at} WHERE id = ?",
        (new_done, todo_id),
    )
    if new_done and recurrence:
        base = date.fromisoformat(due_date) if due_date else date.today()
        base = max(base, date.today())
        next_due = next_occurrence(base, recurrence)
        if next_due is not None:
            conn.execute(
                "INSERT INTO todos (title, category, priority, due_date, due_time, recurrence, notify_offset_minutes, note) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (title, category, priority, next_due.isoformat(), due_time, recurrence, notify_offset_minutes, note),
            )
    conn.commit()
    conn.close()
    return {"id": todo_id, "done": bool(new_done)}


@app.delete("/api/todos/{todo_id}")
def delete_todo(todo_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------- categories ----------

@app.get("/api/categories")
def list_categories():
    conn = get_connection()
    cur = conn.execute("SELECT * FROM categories ORDER BY id ASC")
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.post("/api/categories")
def create_category(category: CategoryCreate):
    name = category.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    conn = get_connection()
    existing = conn.execute("SELECT id FROM categories WHERE name = ?", (name,)).fetchone()
    if existing is not None:
        conn.close()
        raise HTTPException(status_code=400, detail="category already exists")
    cur = conn.execute("INSERT INTO categories (name) VALUES (?)", (name,))
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id, "name": name}


@app.put("/api/categories/{category_id}")
def update_category(category_id: int, category: CategoryUpdate):
    name = category.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    conn = get_connection()
    row = conn.execute("SELECT name FROM categories WHERE id = ?", (category_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="category not found")
    old_name = row[0]
    conn.execute("UPDATE categories SET name = ? WHERE id = ?", (name, category_id))
    conn.execute("UPDATE todos SET category = ? WHERE category = ?", (name, old_name))
    conn.execute("UPDATE study_logs SET subject = ? WHERE subject = ?", (name, old_name))
    conn.execute("UPDATE events SET category = ? WHERE category = ?", (name, old_name))
    conn.commit()
    conn.close()
    return {"id": category_id, "name": name}


@app.delete("/api/categories/{category_id}")
def delete_category(category_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM categories WHERE id = ?", (category_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------- study logs ----------

@app.get("/api/study-logs")
def list_study_logs():
    conn = get_connection()
    cur = conn.execute("SELECT * FROM study_logs ORDER BY logged_at DESC LIMIT 200")
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.get("/api/study-logs/summary")
def study_log_summary():
    conn = get_connection()
    cur = conn.execute(
        """
        SELECT subject, SUM(minutes) AS total_minutes
        FROM study_logs
        WHERE logged_at >= datetime('now', '-7 days')
        GROUP BY subject
        """
    )
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.get("/api/study-logs/trigger-stats")
def study_log_trigger_stats(days: int = 30):
    conn = get_connection()
    cur = conn.execute(
        "SELECT start_trigger, COUNT(*) AS count FROM study_logs "
        "WHERE start_trigger IS NOT NULL AND logged_at >= datetime('now', ?, 'start of day') "
        "GROUP BY start_trigger ORDER BY count DESC",
        (f"-{days} days",),
    )
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.post("/api/study-logs")
def create_study_log(log: StudyLogCreate):
    conn = get_connection()
    if log.logged_at:
        cur = conn.execute(
            "INSERT INTO study_logs (subject, minutes, note, logged_at, start_trigger) VALUES (?, ?, ?, ?, ?)",
            (log.subject, log.minutes, log.note, log.logged_at, log.start_trigger),
        )
    else:
        cur = conn.execute(
            "INSERT INTO study_logs (subject, minutes, note, start_trigger) VALUES (?, ?, ?, ?)",
            (log.subject, log.minutes, log.note, log.start_trigger),
        )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


# vocab-app(別オリジン)からの復習セッション自動記録。CORSはこの2ルートにだけ手動で許可する
# (理由は上のVOCAB_APP_ORIGIN定義のコメント参照)。ブラウザは非simple request(Content-Type:
# application/json)だとPOST前にOPTIONSでpreflightを送るため、両方に同じCORSヘッダーを付ける。
MAX_VOCAB_SESSION_MINUTES = 240  # 復習セッション1回として物理的にあり得ない値の上限(screen-timeと同じ考え方)
MAX_VOCAB_SESSION_COUNT = 2000


def _vocab_cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": VOCAB_APP_ORIGIN,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }


@app.options("/api/study-logs/vocab-sync")
def vocab_sync_preflight():
    return JSONResponse(content=None, headers=_vocab_cors_headers())


@app.post("/api/study-logs/vocab-sync")
def create_vocab_study_log(log: VocabAppStudyLogCreate, token: str | None = None):
    if not VOCAB_APP_TOKEN or token != VOCAB_APP_TOKEN:
        raise HTTPException(status_code=403, detail="invalid token", headers=_vocab_cors_headers())
    if not (0 <= log.minutes <= MAX_VOCAB_SESSION_MINUTES):
        raise HTTPException(
            status_code=400,
            detail=f"minutes out of range (0-{MAX_VOCAB_SESSION_MINUTES}): {log.minutes}",
            headers=_vocab_cors_headers(),
        )
    if log.count is not None and not (0 <= log.count <= MAX_VOCAB_SESSION_COUNT):
        raise HTTPException(
            status_code=400,
            detail=f"count out of range (0-{MAX_VOCAB_SESSION_COUNT}): {log.count}",
            headers=_vocab_cors_headers(),
        )
    start_trigger = f"vocab-app:{log.mode}"
    conn = get_connection()
    if log.logged_at:
        cur = conn.execute(
            "INSERT INTO study_logs (subject, minutes, start_trigger, count, unit, logged_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (log.subject, log.minutes, start_trigger, log.count, log.unit, log.logged_at),
        )
    else:
        cur = conn.execute(
            "INSERT INTO study_logs (subject, minutes, start_trigger, count, unit) VALUES (?, ?, ?, ?, ?)",
            (log.subject, log.minutes, start_trigger, log.count, log.unit),
        )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return JSONResponse(content={"id": new_id}, headers=_vocab_cors_headers())


@app.delete("/api/study-logs/{log_id}")
def delete_study_log(log_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM study_logs WHERE id = ?", (log_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/study-logs/days")
def study_log_days(year: int, month: int):
    conn = get_connection()
    cur = conn.execute(
        "SELECT DISTINCT date(logged_at) AS d FROM study_logs "
        "WHERE strftime('%Y', logged_at) = ? AND strftime('%m', logged_at) = ?",
        (str(year), f"{month:02d}"),
    )
    result = [row[0] for row in cur.fetchall()]
    conn.close()
    return result


@app.get("/api/study-logs/minimum-achieved-days")
def study_log_minimum_achieved_days(year: int, month: int):
    conn = get_connection()
    settings = _read_settings(conn)
    minimum = settings.get("daily_minimum_minutes")
    if not minimum:
        conn.close()
        return []
    cur = conn.execute(
        "SELECT date(logged_at) AS d, SUM(minutes) AS total_minutes FROM study_logs "
        "WHERE strftime('%Y', logged_at) = ? AND strftime('%m', logged_at) = ? "
        "GROUP BY d HAVING total_minutes >= ?",
        (str(year), f"{month:02d}", minimum),
    )
    result = [row[0] for row in cur.fetchall()]
    conn.close()
    return result


@app.get("/api/study-logs/daily")
def study_log_daily():
    conn = get_connection()
    cur = conn.execute(
        """
        SELECT date(logged_at) AS d, subject, SUM(minutes) AS total_minutes
        FROM study_logs
        WHERE logged_at >= datetime('now', '-13 days', 'start of day')
        GROUP BY d, subject
        ORDER BY d
        """
    )
    result = rows_to_dicts(cur)
    conn.close()
    return result


LOW_MOOD_THRESHOLD = 4  # mood_logs.score の日平均がこれ以下なら「低気分日」


@app.get("/api/mood-logs")
def list_mood_logs(days: int = 14):
    conn = get_connection()
    cur = conn.execute(
        "SELECT id, date, score, note, reason, logged_at FROM mood_logs "
        "WHERE date >= date('now', ?) ORDER BY logged_at ASC",
        (f"-{days - 1} days",),
    )
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.get("/api/mood-logs/stats")
def mood_log_stats():
    # 1日に複数件記録できるため、まず日次平均に集計してから週/月平均を出す
    # (記録件数が多い日に平均が引っ張られないよう、日ごとの重みを揃える)
    conn = get_connection()
    week_avg = conn.execute(
        "SELECT AVG(day_avg) FROM (SELECT AVG(score) AS day_avg FROM mood_logs "
        "WHERE date >= date('now', '-6 days') GROUP BY date)"
    ).fetchone()[0]
    month_avg = conn.execute(
        "SELECT AVG(day_avg) FROM (SELECT AVG(score) AS day_avg FROM mood_logs "
        "WHERE date >= date('now', 'start of month') GROUP BY date)"
    ).fetchone()[0]
    conn.close()
    return {
        "week_avg": round(week_avg, 1) if week_avg is not None else None,
        "month_avg": round(month_avg, 1) if month_avg is not None else None,
    }


@app.get("/api/mood-logs/reason-stats")
def mood_log_reason_stats(days: int = 30):
    conn = get_connection()
    cur = conn.execute(
        "SELECT reason, COUNT(*) AS count, AVG(score) AS avg_score FROM mood_logs "
        "WHERE reason IS NOT NULL AND date >= date('now', ?) "
        "GROUP BY reason ORDER BY avg_score ASC",
        (f"-{days} days",),
    )
    result = rows_to_dicts(cur)
    conn.close()
    for row in result:
        row["avg_score"] = round(row["avg_score"], 1)
    return result


@app.get("/api/mood-logs/low-mood-achievement")
def mood_log_low_mood_achievement(days: int = 30):
    conn = get_connection()
    settings = _read_settings(conn)
    minimum = settings.get("daily_minimum_minutes")
    if not minimum:
        conn.close()
        return {"status": "not_configured", "low_mood_days": 0, "achieved_days": 0, "rate": None}

    mood_rows = conn.execute(
        "SELECT date, score FROM mood_logs WHERE date >= date('now', ?)",
        (f"-{days} days",),
    ).fetchall()
    scores_by_date = {}
    for d, score in mood_rows:
        scores_by_date.setdefault(d, []).append(score)
    low_mood_dates = [
        d for d, scores in scores_by_date.items() if sum(scores) / len(scores) <= LOW_MOOD_THRESHOLD
    ]

    if not low_mood_dates:
        conn.close()
        return {"status": "insufficient_data", "low_mood_days": 0, "achieved_days": 0, "rate": None}

    study_rows = conn.execute(
        "SELECT date(logged_at) AS d, SUM(minutes) AS total_minutes FROM study_logs "
        "WHERE logged_at >= datetime('now', ?, 'start of day') GROUP BY d",
        (f"-{days} days",),
    ).fetchall()
    minutes_by_date = dict(study_rows)
    conn.close()

    achieved_days = sum(1 for d in low_mood_dates if minutes_by_date.get(d, 0) >= minimum)
    return {
        "status": "ok",
        "low_mood_days": len(low_mood_dates),
        "achieved_days": achieved_days,
        "rate": round(achieved_days / len(low_mood_dates) * 100),
    }


@app.post("/api/mood-logs")
def create_mood_log(payload: MoodLogCreate):
    conn = get_connection()
    if payload.logged_at:
        conn.execute(
            "INSERT INTO mood_logs (date, score, note, reason, logged_at) VALUES (?, ?, ?, ?, ?)",
            (payload.date, payload.score, payload.note, payload.reason, payload.logged_at),
        )
    else:
        conn.execute(
            "INSERT INTO mood_logs (date, score, note, reason) VALUES (?, ?, ?, ?)",
            (payload.date, payload.score, payload.note, payload.reason),
        )
    conn.commit()
    conn.close()
    return {"ok": True}


WEEKLY_CHART_WEEKS = 10


@app.get("/api/study-logs/weekly")
def study_log_weekly():
    conn = get_connection()
    cur = conn.execute(
        """
        SELECT date(logged_at) AS d, subject, SUM(minutes) AS total_minutes
        FROM study_logs
        WHERE logged_at >= datetime('now', ?, 'start of day')
        GROUP BY d, subject
        ORDER BY d
        """,
        (f"-{WEEKLY_CHART_WEEKS * 7 - 1} days",),
    )
    rows = rows_to_dicts(cur)
    conn.close()
    weekly: dict[str, dict[str, int]] = {}
    for row in rows:
        d = date.fromisoformat(row["d"])
        week_start = (d - timedelta(days=d.weekday())).isoformat()  # Monday of that week
        bucket = weekly.setdefault(week_start, {})
        bucket[row["subject"]] = bucket.get(row["subject"], 0) + row["total_minutes"]
    result = [
        {"week_start": week_start, "subject": subject, "total_minutes": total_minutes}
        for week_start, subjects in weekly.items()
        for subject, total_minutes in subjects.items()
    ]
    result.sort(key=lambda r: r["week_start"])
    return result


def _read_settings(conn):
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    d = {row[0]: row[1] for row in rows}
    return {
        "weekly_goal_minutes": int(d["weekly_goal_minutes"]) if "weekly_goal_minutes" in d else None,
        "monthly_goal_minutes": int(d["monthly_goal_minutes"]) if "monthly_goal_minutes" in d else None,
        "daily_minimum_minutes": int(d["daily_minimum_minutes"]) if "daily_minimum_minutes" in d else None,
    }


@app.get("/api/study-logs/progress")
def study_log_progress():
    conn = get_connection()
    today_total = conn.execute(
        "SELECT COALESCE(SUM(minutes), 0) FROM study_logs WHERE logged_at >= datetime('now', 'start of day')"
    ).fetchone()[0]
    week_total = conn.execute(
        "SELECT COALESCE(SUM(minutes), 0) FROM study_logs WHERE logged_at >= datetime('now', '-6 days', 'start of day')"
    ).fetchone()[0]
    month_total = conn.execute(
        "SELECT COALESCE(SUM(minutes), 0) FROM study_logs WHERE logged_at >= datetime('now', 'start of month')"
    ).fetchone()[0]
    all_time_total = conn.execute("SELECT COALESCE(SUM(minutes), 0) FROM study_logs").fetchone()[0]
    settings = _read_settings(conn)
    conn.close()
    return {
        "today_minutes": today_total,
        "week_minutes": week_total,
        "month_minutes": month_total,
        "total_minutes": all_time_total,
        **settings,
    }


@app.put("/api/settings")
def update_settings(payload: SettingsUpdate):
    conn = get_connection()
    if payload.weekly_goal_minutes is not None:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('weekly_goal_minutes', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(payload.weekly_goal_minutes),),
        )
    if payload.monthly_goal_minutes is not None:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('monthly_goal_minutes', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(payload.monthly_goal_minutes),),
        )
    if payload.daily_minimum_minutes is not None:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('daily_minimum_minutes', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(payload.daily_minimum_minutes),),
        )
    if payload.countdown_label is not None:
        label = payload.countdown_label.strip()
        if not label:
            raise HTTPException(status_code=400, detail="countdown_label must not be empty")
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('countdown_label', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (label,),
        )
    if payload.countdown_target_date is not None:
        try:
            date.fromisoformat(payload.countdown_target_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="countdown_target_date must be YYYY-MM-DD")
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('countdown_target_date', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (payload.countdown_target_date,),
        )
    conn.commit()
    result = _read_settings(conn)
    conn.close()
    return result


# ---------- activation logs ----------

ACTIVATION_REMINDER_MINUTES = 45
ACTIVATION_ENCOURAGEMENT_WINDOW_DAYS = 14
ACTIVATION_ENCOURAGEMENT_HOUR = 18

MOOD_REMINDER_HOUR = 21
MOOD_REMINDER_ENABLED = False  # 一時停止中


def _post_return_minutes(conn, returned_at: str) -> int:
    return conn.execute(
        "SELECT COALESCE(SUM(minutes), 0) FROM study_logs "
        "WHERE logged_at > ? AND date(logged_at) = date(?)",
        (returned_at, returned_at),
    ).fetchone()[0]


@app.get("/api/activation-logs")
def list_activation_logs(limit: int = 200):
    conn = get_connection()
    cur = conn.execute(
        "SELECT * FROM activation_logs ORDER BY triggered_at DESC LIMIT ?", (limit,)
    )
    result = rows_to_dicts(cur)
    for row in result:
        row["post_return_minutes"] = (
            _post_return_minutes(conn, row["returned_at"]) if row["returned_at"] else None
        )
    conn.close()
    return result


@app.get("/api/activation-logs/active")
def active_activation_log():
    conn = get_connection()
    cur = conn.execute(
        "SELECT * FROM activation_logs WHERE returned_at IS NULL ORDER BY triggered_at DESC LIMIT 1"
    )
    row = cur.fetchone()
    result = row_to_dict(cur, row)
    conn.close()
    return result


@app.get("/api/activation-logs/days")
def activation_log_days(year: int, month: int):
    conn = get_connection()
    cur = conn.execute(
        "SELECT DISTINCT date(triggered_at) AS d FROM activation_logs "
        "WHERE strftime('%Y', triggered_at) = ? AND strftime('%m', triggered_at) = ?",
        (str(year), f"{month:02d}"),
    )
    result = [row[0] for row in cur.fetchall()]
    conn.close()
    return result


@app.get("/api/activation-logs/stats")
def activation_log_stats():
    conn = get_connection()
    week_count = conn.execute(
        "SELECT COUNT(*) FROM activation_logs WHERE triggered_at >= datetime('now', '-6 days', 'start of day')"
    ).fetchone()[0]
    month_count = conn.execute(
        "SELECT COUNT(*) FROM activation_logs WHERE triggered_at >= datetime('now', 'start of month')"
    ).fetchone()[0]
    total_count = conn.execute("SELECT COUNT(*) FROM activation_logs").fetchone()[0]
    conn.close()
    return {"week_count": week_count, "month_count": month_count, "total_count": total_count}


@app.get("/api/activation-logs/post-return-stats")
def activation_log_post_return_stats(days: int = 30):
    conn = get_connection()
    cur = conn.execute(
        "SELECT returned_at FROM activation_logs "
        "WHERE returned_at IS NOT NULL AND triggered_at >= datetime('now', ?, 'start of day')",
        (f"-{days} days",),
    )
    minutes_list = [_post_return_minutes(conn, row[0]) for row in cur.fetchall()]
    conn.close()
    count = len(minutes_list)
    avg_minutes = round(sum(minutes_list) / count, 1) if count else 0
    return {"count": count, "avg_minutes": avg_minutes}


@app.get("/api/activation-logs/mood-reasons")
def activation_log_mood_reasons(days: int = 30):
    conn = get_connection()
    cur = conn.execute(
        "SELECT mood_reason, COUNT(*) AS count FROM activation_logs "
        "WHERE mood = 'heavy' AND mood_reason IS NOT NULL "
        "AND triggered_at >= datetime('now', ? , 'start of day') "
        "GROUP BY mood_reason ORDER BY count DESC",
        (f"-{days} days",),
    )
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.get("/api/activation-logs/export")
def export_activation_logs(since: str | None = None):
    conn = get_connection()
    if since:
        cur = conn.execute(
            "SELECT * FROM activation_logs WHERE triggered_at >= ? ORDER BY triggered_at ASC",
            (since,),
        )
    else:
        cur = conn.execute("SELECT * FROM activation_logs ORDER BY triggered_at ASC")
    rows = rows_to_dicts(cur)
    conn.close()
    lines = []
    for r in rows:
        triggered = r["triggered_at"][:16]
        note = r["note"] or ""
        line = f"- Activation {triggered} trigger: {note}"
        if r["returned_at"]:
            line += f" / Return {r['returned_at'][:16]}"
        lines.append(line)
    return {"text": "\n".join(lines), "count": len(lines)}


@app.post("/api/activation-logs")
def create_activation_log(log: ActivationLogCreate):
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO activation_logs (triggered_at, note, mood, mood_reason) VALUES (?, ?, ?, ?)",
        (log.triggered_at, log.note, log.mood, log.mood_reason if log.mood == "heavy" else None),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


@app.put("/api/activation-logs/{log_id}/return")
def return_activation_log(log_id: int, payload: ActivationLogReturn):
    conn = get_connection()
    row = conn.execute("SELECT id FROM activation_logs WHERE id = ?", (log_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="activation log not found")
    conn.execute(
        "UPDATE activation_logs SET returned_at = ? WHERE id = ?",
        (payload.returned_at, log_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/activation-logs/{log_id}")
def delete_activation_log(log_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM activation_logs WHERE id = ?", (log_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------- sleep logs ----------

@app.get("/api/sleep-logs")
def list_sleep_logs(limit: int = 30):
    conn = get_connection()
    cur = conn.execute(
        "SELECT * FROM sleep_logs ORDER BY bedtime_at DESC LIMIT ?", (limit,)
    )
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.get("/api/sleep-logs/active")
def active_sleep_log():
    conn = get_connection()
    cur = conn.execute(
        "SELECT * FROM sleep_logs WHERE wake_at IS NULL ORDER BY bedtime_at DESC LIMIT 1"
    )
    row = cur.fetchone()
    result = row_to_dict(cur, row)
    conn.close()
    return result


@app.get("/api/sleep-logs/stats")
def sleep_log_stats(days: int = 30):
    conn = get_connection()
    cur = conn.execute(
        "SELECT (julianday(wake_at) - julianday(bedtime_at)) * 24 * 60 AS minutes FROM sleep_logs "
        "WHERE wake_at IS NOT NULL AND bedtime_at >= datetime('now', ?, 'start of day')",
        (f"-{days} days",),
    )
    minutes_list = [row[0] for row in cur.fetchall()]
    conn.close()
    count = len(minutes_list)
    avg_minutes = round(sum(minutes_list) / count, 1) if count else 0
    return {"count": count, "avg_minutes": avg_minutes}


@app.post("/api/sleep-logs")
def create_sleep_log(log: SleepLogCreate):
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO sleep_logs (bedtime_at) VALUES (?)",
        (log.bedtime_at,),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


@app.put("/api/sleep-logs/{log_id}")
def update_sleep_log(log_id: int, payload: SleepLogUpdate):
    conn = get_connection()
    cur = conn.execute("SELECT * FROM sleep_logs WHERE id = ?", (log_id,))
    row = cur.fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="sleep log not found")
    current = row_to_dict(cur, row)
    bedtime_at = payload.bedtime_at if payload.bedtime_at is not None else current["bedtime_at"]
    wake_at = payload.wake_at if payload.wake_at is not None else current["wake_at"]
    conn.execute(
        "UPDATE sleep_logs SET bedtime_at = ?, wake_at = ? WHERE id = ?",
        (bedtime_at, wake_at, log_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/sleep-logs/{log_id}")
def delete_sleep_log(log_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM sleep_logs WHERE id = ?", (log_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------- screen time (JpBlocker連携、Part B) ----------

@app.put("/api/screen-time")
def upsert_screen_time(payload: ScreenTimeUpsert, token: str | None = None):
    if not DEVICE_TOKEN or token != DEVICE_TOKEN:
        raise HTTPException(status_code=403, detail="invalid token")
    # 2026-08-30に発覚した異常値(1003分・1100分・990分・2327分)の再発防止。
    # JpBlocker側の画面ロック未検知バグは修正済みだが、1日の物理上限(1440分)を
    # 超える値をサーバー側でも弾いておき、クライアント側の不具合が再発してもDBを汚さない。
    if not (0 <= payload.total_minutes <= 1440):
        raise HTTPException(
            status_code=400,
            detail=f"total_minutes out of range (0-1440): {payload.total_minutes}",
        )
    conn = get_connection()
    conn.execute(
        "INSERT INTO screen_time_logs (date, total_minutes, by_app, updated_at) "
        "VALUES (?, ?, ?, datetime('now')) "
        "ON CONFLICT(date) DO UPDATE SET total_minutes = excluded.total_minutes, "
        "by_app = excluded.by_app, updated_at = excluded.updated_at",
        (payload.date, payload.total_minutes, payload.by_app),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/screen-time/daily")
def screen_time_daily(days: int = 14):
    # mood-logsチャートの重ね合わせ表示用。study-logs/dailyと同じ「範囲内は気分記録の有無を問わず返す」流儀
    conn = get_connection()
    cur = conn.execute(
        "SELECT date, total_minutes FROM screen_time_logs WHERE date >= date('now', ?) ORDER BY date",
        (f"-{days - 1} days",),
    )
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.get("/api/screen-time/mood-correlation")
def screen_time_mood_correlation(days: int = 30):
    # スクリーンタイムが多い日と少ない日で気分平均に差があるかを見る(中央値で2群に分ける簡易分析)。
    conn = get_connection()
    screen_rows = conn.execute(
        "SELECT date, total_minutes FROM screen_time_logs WHERE date >= date('now', ?)",
        (f"-{days} days",),
    ).fetchall()
    mood_rows = conn.execute(
        "SELECT date, score FROM mood_logs WHERE date >= date('now', ?)",
        (f"-{days} days",),
    ).fetchall()
    conn.close()

    scores_by_date: dict[str, list[int]] = {}
    for d, score in mood_rows:
        scores_by_date.setdefault(d, []).append(score)

    paired = [
        (minutes, sum(scores_by_date[d]) / len(scores_by_date[d]))
        for d, minutes in screen_rows
        if d in scores_by_date
    ]
    if len(paired) < 4:
        return {"status": "insufficient_data", "paired_days": len(paired)}

    paired.sort(key=lambda p: p[0])
    mid = len(paired) // 2
    low_half, high_half = paired[:mid], paired[-mid:]
    return {
        "status": "ok",
        "paired_days": len(paired),
        "low_screen_time_avg_minutes": round(sum(m for m, _ in low_half) / len(low_half)),
        "low_screen_time_avg_mood": round(sum(s for _, s in low_half) / len(low_half), 1),
        "high_screen_time_avg_minutes": round(sum(m for m, _ in high_half) / len(high_half)),
        "high_screen_time_avg_mood": round(sum(s for _, s in high_half) / len(high_half), 1),
    }


# ---------- 設定変更の遠隔承認(美緒)+ PIN + 設定変更の時間遅延(JpBlocker連携) ----------
#
# 経緯(2026-08-19):
# 第1版はPINを美緒(第三者)に預ける方式だった。しかしとっつーが実際に設定を解除したい
# 場面では、美緒がPINを口頭かメッセージで教えるしかなく、一度でも教えた時点で「本人がPINを
# 知らない」という前提そのものが崩れてしまう欠陥があった。
#
# そこで第2版としてPINという「共有される秘密」自体を廃止し、美緒が専用ページ(/approve)で
# ボタンを押すだけで15分間のウィンドウが開く方式に置き換えたが、これにはさらに別の欠陥が
# あった。認証情報が「URLに含まれるトークン」だけになってしまい、そのトークンは
# インフラの所有者であるとっつー自身も(Renderの環境変数として)見える/知り得る。つまり
# 「美緒が承認した」ことは何も保証されず、とっつーが別端末でそのURLを開いて自分で
# 承認ボタンを押すことも技術的には可能だった(とっつー本人が指摘して発覚)。
#
# 第3版(現在)はPINを復活させ、承認ボタンを押す操作そのものにPIN入力を必須にする。
# トークン(URL)は「そもそも他人に見つからない」ための外側の壁に過ぎず、実質的な認証は
# PIN(美緒だけが知り、とっつーには一度も開示されない値)が担う。PINは/approveページの中で
# 美緒のブラウザ上でだけ入力され、とっつーの端末には一切降りてこない(=第1版の「口頭で
# 教える羽目になる」問題は解決したまま)。トークンだけを知っていてもPINを知らなければ
# 承認できないので、第2版の欠陥(=とっつーが自分で承認できてしまう)も塞がれる。
#
# PIN変更時は「現在のPINを知っている」ことを要求する(トークンだけを持つ人物が勝手に
# 上書きできてしまうと、この仕組み全体の前提が崩れるため)。ただし初回設定だけは
# トークンのみで可能(まだPINが存在しないので他に検証しようがない、既知の限界)。
#
# 承認ウィンドウが開いていても、実際の設定反映はこれまで通りPENDING_CHANGE_DELAY_HOURS
# (24時間)後(「エスケープなし」方針、開発の教訓43/48)。承認は「変更を申請できる入口」を
# 開けるだけで、反映タイミングまでは早めない。
#
# ウィンドウの状態・PINのハッシュ/saltはいずれもsettingsテーブルに間借りする
# (単一の値なので新規テーブルは作らない)。

UNLOCK_WINDOW_MINUTES = 15
PIN_HASH_ITERATIONS = 260_000
PIN_MIN_LENGTH = 4

ACTION_TYPE_LABELS = {
    "mode": "検知後の挙動",
    "limit": "1日の利用上限(分)",
    "youtube_lockout": "YouTubeロック時間(分)",
    "block_list": "study-tracker連携ブロックリスト",
    "open_limits": "起動回数上限",
}


def _require_device_token(token: str | None):
    if not DEVICE_TOKEN or token != DEVICE_TOKEN:
        raise HTTPException(status_code=403, detail="invalid token")


def _hash_pin(pin: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), salt, PIN_HASH_ITERATIONS).hex()


def _read_pin(conn) -> tuple[str, str] | None:
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE key IN ('pin_hash', 'pin_salt')"
    ).fetchall()
    d = {k: v for k, v in rows}
    if "pin_hash" not in d or "pin_salt" not in d:
        return None
    return d["pin_hash"], d["pin_salt"]


def _verify_pin(conn, pin: str) -> bool:
    stored = _read_pin(conn)
    if stored is None:
        return False
    pin_hash, salt_hex = stored
    candidate = _hash_pin(pin, bytes.fromhex(salt_hex))
    return secrets.compare_digest(candidate, pin_hash)


def _set_pin(conn, pin: str):
    salt = secrets.token_bytes(16)
    pin_hash = _hash_pin(pin, salt)
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('pin_salt', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (salt.hex(),),
    )
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('pin_hash', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (pin_hash,),
    )


def _unlock_status(conn) -> dict:
    row = conn.execute("SELECT value FROM settings WHERE key = 'unlock_expires_at'").fetchone()
    if row is None:
        return {"active": False, "expires_at": None}
    expires_at = row[0]
    active = datetime.fromisoformat(expires_at) > datetime.now()
    return {"active": active, "expires_at": expires_at if active else None}


def _render_pending_html(pending: list[dict]) -> str:
    if not pending:
        return '<p class="empty">なし</p>'
    items = []
    for row in pending:
        label = ACTION_TYPE_LABELS.get(row["action_type"], row["action_type"])
        items.append(
            '<div class="pending-item">'
            f'<div class="type">{html.escape(label)}</div>'
            f'<div>内容: {html.escape(row["payload"])}</div>'
            f'<div>申請 {html.escape(row["created_at"])} / 反映予定 {html.escape(row["apply_after"])}</div>'
            f'<button class="cancel" data-id="{row["id"]}">この変更を取り消す</button>'
            '</div>'
        )
    return "".join(items)


# __BODY__だけをプレースホルダにして、CSS/JS中の{}をformat()のエスケープ対象にしない
# (このページはPIN設定/変更フォームの有無で中身が分岐するため、迂闊にformat()を使うと
# 二重波括弧だらけになって事故りやすい。単純なreplace()で組み立てる)。
APPROVE_PAGE_SHELL = """<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JpBlocker 設定変更の承認</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 1.2rem; }
  h2 { font-size: 1rem; margin-top: 28px; }
  p.note { color: #666; font-size: 0.85rem; line-height: 1.6; }
  .status { padding: 14px; margin: 14px 0; border-radius: 8px; font-size: 0.95rem; }
  .status.locked { background: #fdecea; color: #c62828; }
  .status.active { background: #e6f4ea; color: #1e7e34; }
  input { width: 100%; box-sizing: border-box; padding: 10px; font-size: 1rem; margin-bottom: 8px; border: 1px solid #ccc; border-radius: 6px; }
  button { width: 100%; padding: 14px; font-size: 1.05rem; border: none; border-radius: 8px; background: #1a73e8; color: white; margin-top: 4px; }
  button.secondary { background: #555; }
  button.cancel { width: auto; padding: 8px 12px; font-size: 0.8rem; background: #c62828; margin-top: 8px; }
  .pending-item { border: 1px solid #ddd; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; font-size: 0.85rem; }
  .pending-item .type { font-weight: bold; margin-bottom: 4px; }
  .empty { color: #999; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>JpBlocker 設定変更の承認</h1>
<p class="note">とっつーが端末の設定を変更したいときに使うページです。PINは美緒だけが知っている状態を保ってください(とっつーには教えない)。「承認する」を押すと15分間だけ変更の申請を受け付けられるようになります(実際に反映されるのはそこからさらに24時間後です)。</p>
__BODY__
</body>
</html>"""


def _render_approve_page(status: dict, pin_is_set: bool, pending: list[dict], token: str | None) -> str:
    if status["active"]:
        remaining_min = max(
            0,
            int((datetime.fromisoformat(status["expires_at"]) - datetime.now()).total_seconds() // 60) + 1,
        )
        status_class = "active"
        status_text = f"承認中(残り約{remaining_min}分、{status['expires_at']}まで申請を受け付けます)"
    else:
        status_class = "locked"
        status_text = "現在は変更を申請できません(承認が必要です)"

    if pin_is_set:
        approve_html = (
            '<div class="status ' + status_class + '">' + status_text + '</div>'
            '<input type="password" id="approvePin" placeholder="PIN" autocomplete="off">'
            '<button id="approveBtn">承認する(15分間)</button>'
        )
        approve_script = """
document.getElementById('approveBtn').addEventListener('click', async () => {
  const pin = document.getElementById('approvePin').value;
  const res = await fetch('/approve', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: TOKEN, pin: pin}),
  });
  if (res.ok) { location.reload(); } else { alert('承認に失敗しました(PINを確認してください)'); }
});
"""
        pin_manage_html = (
            '<h2>PINを変更</h2>'
            '<input type="password" id="currentPin" placeholder="現在のPIN" autocomplete="off">'
            '<input type="password" id="changeNewPin" placeholder="新しいPIN(4桁以上)" autocomplete="off">'
            '<input type="password" id="changeNewPinConfirm" placeholder="確認のためもう一度" autocomplete="off">'
            '<button class="secondary" id="changePinBtn">変更する</button>'
        )
        pin_manage_script = """
document.getElementById('changePinBtn').addEventListener('click', async () => {
  const current = document.getElementById('currentPin').value;
  const pin = document.getElementById('changeNewPin').value;
  const confirmPin = document.getElementById('changeNewPinConfirm').value;
  if (pin.length < 4) { alert('PINは4桁以上にしてください'); return; }
  if (pin !== confirmPin) { alert('確認用のPINが一致しません'); return; }
  const res = await fetch('/approve/pin', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: TOKEN, pin: pin, current_pin: current}),
  });
  if (res.ok) { alert('PINを変更しました'); location.reload(); } else { alert('変更に失敗しました(現在のPINを確認してください)'); }
});
"""
    else:
        approve_html = '<div class="status locked">PINが未設定です。まず下でPINを決めてください(承認にはこのあと毎回このPINを使います)。</div>'
        approve_script = ""
        pin_manage_html = (
            '<h2>PINの設定(初回のみ)</h2>'
            '<p class="note">ここで決めたPINは今後、承認のたびに入力します。とっつーには一切教えないでください。</p>'
            '<input type="password" id="newPin" placeholder="新しいPIN(4桁以上)" autocomplete="off">'
            '<input type="password" id="newPinConfirm" placeholder="確認のためもう一度" autocomplete="off">'
            '<button id="setPinBtn">PINを設定する</button>'
        )
        pin_manage_script = """
document.getElementById('setPinBtn').addEventListener('click', async () => {
  const pin = document.getElementById('newPin').value;
  const confirmPin = document.getElementById('newPinConfirm').value;
  if (pin.length < 4) { alert('PINは4桁以上にしてください'); return; }
  if (pin !== confirmPin) { alert('確認用のPINが一致しません'); return; }
  const res = await fetch('/approve/pin', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: TOKEN, pin: pin}),
  });
  if (res.ok) { location.reload(); } else { alert('設定に失敗しました'); }
});
"""

    cancel_script = """
document.querySelectorAll('.cancel').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    const res = await fetch('/approve/pending-changes/' + id + '?token=' + encodeURIComponent(TOKEN), { method: 'DELETE' });
    if (res.ok) { location.reload(); } else { alert('取り消しに失敗しました'); }
  });
});
"""

    body = (
        '<script>const TOKEN = ' + json.dumps(token) + ';</script>'
        + approve_html
        + pin_manage_html
        + '<h2>反映待ちの変更</h2>'
        + _render_pending_html(pending)
        + '<script>' + approve_script + pin_manage_script + cancel_script + '</script>'
    )
    return APPROVE_PAGE_SHELL.replace("__BODY__", body)


@app.get("/approve")
def approve_page(token: str | None = None):
    if not APPROVAL_TOKEN or token != APPROVAL_TOKEN:
        raise HTTPException(status_code=403, detail="invalid token")
    conn = get_connection()
    status = _unlock_status(conn)
    pin_is_set = _read_pin(conn) is not None
    pending = rows_to_dicts(conn.execute(
        "SELECT id, action_type, payload, created_at, apply_after FROM pending_changes "
        "WHERE applied = 0 ORDER BY created_at ASC"
    ))
    conn.close()
    return HTMLResponse(_render_approve_page(status, pin_is_set, pending, token))


@app.post("/approve")
def approve_submit(payload: ApproveIn):
    if not APPROVAL_TOKEN or payload.token != APPROVAL_TOKEN:
        raise HTTPException(status_code=403, detail="invalid token")
    conn = get_connection()
    if not _verify_pin(conn, payload.pin):
        conn.close()
        raise HTTPException(status_code=403, detail="invalid pin")
    expires_at = (datetime.now() + timedelta(minutes=UNLOCK_WINDOW_MINUTES)).isoformat(sep=" ", timespec="seconds")
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('unlock_expires_at', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (expires_at,),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "expires_at": expires_at}


@app.post("/approve/pin")
def approve_set_pin(payload: PinSetIn):
    if not APPROVAL_TOKEN or payload.token != APPROVAL_TOKEN:
        raise HTTPException(status_code=403, detail="invalid token")
    if len(payload.pin) < PIN_MIN_LENGTH:
        raise HTTPException(status_code=400, detail="pin too short")
    conn = get_connection()
    if _read_pin(conn) is not None:
        # 既にPINが設定済みなら、現在のPINを知っている場合だけ上書きを許す。
        # トークンだけを持つ人物(=とっつーもここに含まれ得る)が勝手にPINを差し替えられて
        # しまうと、「PINは美緒だけが知っている」という前提そのものが崩れるため。
        if not payload.current_pin or not _verify_pin(conn, payload.current_pin):
            conn.close()
            raise HTTPException(status_code=403, detail="current pin mismatch")
    _set_pin(conn, payload.pin)
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/approve/pending-changes/{change_id}")
def approve_cancel_pending_change(change_id: int, token: str | None = None):
    # デバイストークンではなく承認トークンでガードする(美緒がこのページから直接取り消せるように。
    # 「何が申請されているか見えるだけで取り消せない」のでは実効的な監督にならないため)。
    if not APPROVAL_TOKEN or token != APPROVAL_TOKEN:
        raise HTTPException(status_code=403, detail="invalid token")
    conn = get_connection()
    conn.execute("DELETE FROM pending_changes WHERE id = ? AND applied = 0", (change_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/unlock/status")
def unlock_status_endpoint(token: str | None = None):
    _require_device_token(token)
    conn = get_connection()
    status = _unlock_status(conn)
    conn.close()
    return status


@app.post("/api/pending-changes")
def create_pending_change(payload: PendingChangeCreate, token: str | None = None):
    _require_device_token(token)
    conn = get_connection()
    if not _unlock_status(conn)["active"]:
        conn.close()
        # 端末側のUIも承認ウィンドウを見て出し分けているはずだが、ここはサーバー側の最終防衛線
        # (端末のUIをいじって直接POSTすればすり抜けられてしまうのを塞ぐ。教訓43/48と同じ、
        # エスケープなし方針をここにも適用する)。
        raise HTTPException(status_code=403, detail="unlock window not active")
    apply_after = (datetime.now() + timedelta(hours=PENDING_CHANGE_DELAY_HOURS)).isoformat(sep=" ", timespec="seconds")
    cur = conn.execute(
        "INSERT INTO pending_changes (action_type, payload, apply_after) VALUES (?, ?, ?)",
        (payload.action_type, payload.payload, apply_after),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id, "apply_after": apply_after}


@app.get("/api/pending-changes")
def list_pending_changes(token: str | None = None):
    _require_device_token(token)
    conn = get_connection()
    result = rows_to_dicts(conn.execute(
        "SELECT id, action_type, payload, created_at, apply_after FROM pending_changes "
        "WHERE applied = 0 ORDER BY created_at ASC"
    ))
    conn.close()
    return result


@app.get("/api/pending-changes/due")
def list_due_pending_changes(token: str | None = None):
    _require_device_token(token)
    conn = get_connection()
    # apply_afterはPythonのdatetime.now()(サーバーのローカル時刻)由来の文字列。
    # SQLite側のdatetime('now')はUTCなので、SQL側で比較するとサーバーのタイムゾーンが
    # UTCでない環境ではズレる。他の期限判定(todo/eventのnotify_at等)と同じく、
    # Python側でdatetime.now()と比較する。
    rows = rows_to_dicts(conn.execute(
        "SELECT id, action_type, payload, created_at, apply_after FROM pending_changes WHERE applied = 0"
    ))
    conn.close()
    now = datetime.now()
    return [row for row in rows if datetime.fromisoformat(row["apply_after"]) <= now]


@app.post("/api/pending-changes/{change_id}/applied")
def mark_pending_change_applied(change_id: int, token: str | None = None):
    _require_device_token(token)
    conn = get_connection()
    conn.execute(
        "UPDATE pending_changes SET applied = 1, applied_at = datetime('now') WHERE id = ?",
        (change_id,),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/pending-changes/{change_id}")
def cancel_pending_change(change_id: int, token: str | None = None):
    _require_device_token(token)
    conn = get_connection()
    conn.execute("DELETE FROM pending_changes WHERE id = ? AND applied = 0", (change_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------- goals ----------

@app.get("/api/goals")
def list_goals():
    conn = get_connection()
    cur = conn.execute("SELECT * FROM goals ORDER BY created_at ASC")
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.post("/api/goals")
def create_goal(goal: GoalCreate):
    conn = get_connection()
    cur = conn.execute("INSERT INTO goals (title) VALUES (?)", (goal.title,))
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


@app.post("/api/goals/{goal_id}/toggle")
def toggle_goal(goal_id: int):
    conn = get_connection()
    row = conn.execute("SELECT done FROM goals WHERE id = ?", (goal_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="goal not found")
    new_done = 0 if row[0] else 1
    conn.execute("UPDATE goals SET done = ? WHERE id = ?", (new_done, goal_id))
    conn.commit()
    conn.close()
    return {"id": goal_id, "done": bool(new_done)}


@app.delete("/api/goals/{goal_id}")
def delete_goal(goal_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


DEFAULT_COUNTDOWN_LABEL = "Eiken Pre-1 / CEFR C1 goal (end of study abroad)"
DEFAULT_COUNTDOWN_TARGET_DATE = date(2026, 11, 30)


@app.get("/api/goals/countdown")
def goal_countdown():
    conn = get_connection()
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE key IN ('countdown_label', 'countdown_target_date')"
    ).fetchall()
    conn.close()
    d = {row[0]: row[1] for row in rows}
    label = d.get("countdown_label") or DEFAULT_COUNTDOWN_LABEL
    target = date.fromisoformat(d["countdown_target_date"]) if d.get("countdown_target_date") else DEFAULT_COUNTDOWN_TARGET_DATE
    days_left = (target - date.today()).days
    return {"target_date": target.isoformat(), "days_left": days_left, "label": label}


# ---------- events (calendar) ----------

@app.get("/api/events")
def list_events(year: int, month: int):
    conn = get_connection()
    rows = rows_to_dicts(conn.execute("SELECT * FROM events"))
    conn.close()

    days_in_month = calendar.monthrange(year, month)[1]
    month_start = date(year, month, 1)
    month_end = date(year, month, days_in_month)

    occurrences = []
    for row in rows:
        anchor = date.fromisoformat(row["date"])
        if not row["recurrence"]:
            if month_start <= anchor <= month_end:
                occurrences.append({**row, "occurrence_date": row["date"]})
            continue
        days = set(row["recurrence"].split(","))
        until = date.fromisoformat(row["recurrence_until"]) if row["recurrence_until"] else None
        range_start = max(month_start, anchor)
        range_end = month_end if until is None else min(month_end, until)
        d = range_start
        while d <= range_end:
            if WEEKDAY_CODES[d.weekday()] in days:
                occurrences.append({**row, "occurrence_date": d.isoformat()})
            d += timedelta(days=1)

    occurrences.sort(key=lambda r: (r["occurrence_date"], r["start_time"]))
    return occurrences


@app.post("/api/events")
def create_event(event: EventCreate):
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO events (title, category, date, start_time, end_time, recurrence, recurrence_until, "
        "notify_offset_minutes, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (event.title, event.category, event.date, event.start_time, event.end_time,
         event.recurrence, event.recurrence_until, event.notify_offset_minutes, event.note),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


@app.put("/api/events/{event_id}")
def update_event(event_id: int, event: EventUpdate):
    conn = get_connection()
    row = conn.execute("SELECT id FROM events WHERE id = ?", (event_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="event not found")
    conn.execute(
        "UPDATE events SET title = ?, category = ?, date = ?, start_time = ?, end_time = ?, "
        "recurrence = ?, recurrence_until = ?, notify_offset_minutes = ?, note = ? WHERE id = ?",
        (event.title, event.category, event.date, event.start_time, event.end_time,
         event.recurrence, event.recurrence_until, event.notify_offset_minutes, event.note, event_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/events/{event_id}")
def delete_event(event_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------- push notifications ----------

NOTIFY_OFFSET_CHOICES = (0, 10, 30, 60)


@app.get("/api/push/vapid-public-key")
def push_vapid_public_key():
    return {"publicKey": VAPID_PUBLIC_KEY}


@app.post("/api/push/subscribe")
def push_subscribe(sub: PushSubscribeIn):
    keys = sub.keys or {}
    conn = get_connection()
    conn.execute(
        """
        INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
        """,
        (sub.endpoint, keys.get("p256dh"), keys.get("auth")),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/push/unsubscribe")
def push_unsubscribe(sub: PushSubscribeIn):
    conn = get_connection()
    conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (sub.endpoint,))
    conn.commit()
    conn.close()
    return {"ok": True}


# focus-timer countdowns run entirely client-side (localStorage), so a backgrounded/suspended
# tab has nothing watching the clock once its own setInterval gets throttled. This mirrors that
# one active countdown's target end time into `settings` so the existing push_check() cron can
# catch completion server-side too, as a backstop for when the client-side notify never fires.
@app.post("/api/focus-session/sync")
def focus_session_sync(payload: FocusSessionSync):
    conn = get_connection()
    if payload.remaining_seconds is None:
        conn.execute(
            "DELETE FROM settings WHERE key IN "
            "('focus_target_end_at', 'focus_target_notified', 'focus_target_subject')"
        )
    else:
        target_end_at = (datetime.now() + timedelta(seconds=payload.remaining_seconds)).isoformat()
        for key, value in (
            ("focus_target_end_at", target_end_at),
            ("focus_target_notified", "0"),
            ("focus_target_subject", payload.subject or ""),
        ):
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
    conn.commit()
    conn.close()
    return {"ok": True}


# JpBlocker(Android)側で「今study-trackerのセッションが動いているか」を判定するための状態。
# 上のfocus_session_sync()とは別管理(あちらはカウントダウンのみ・push通知の保険用途)。
# こちらはカウントアップ/カウントダウン問わず、セッション開始〜終了(一時停止中は維持)を反映する。
@app.post("/api/focus-session/active")
def focus_session_active(payload: SessionActiveSync):
    conn = get_connection()
    if payload.active:
        started_at = datetime.now().isoformat(sep=" ", timespec="seconds")
        for key, value in (
            ("session_active", "1"),
            ("session_subject", payload.subject or ""),
            ("session_started_at", started_at),
        ):
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
    else:
        conn.execute(
            "DELETE FROM settings WHERE key IN "
            "('session_active', 'session_subject', 'session_started_at')"
        )
    conn.commit()
    conn.close()
    return {"ok": True}


# クライアント側のactive:false送信(discard/finish時)が何らかの理由でサーバーに届かないと
# (PWAを閉じるタイミングと重なる等)、session_activeが1のまま永久に残り、JpBlocker側の
# マナーモード解除・アプリブロック解除が二度と発火しなくなる(discardSession()にkeepalive:true
# を足して主要因は塞いだが、それでも防げない失敗経路の保険としてここでも自己修復する)。
# 通常の勉強セッションがこれを超えることはまず無いはずの余裕を持った上限。
FOCUS_SESSION_MAX_AGE_HOURS = 4


def _focus_session_status(conn) -> dict:
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE key IN "
        "('session_active', 'session_subject', 'session_started_at')"
    ).fetchall()
    values = dict(rows)
    if values.get("session_active") != "1":
        return {"active": False}

    started_at = values.get("session_started_at")
    stale = False
    if started_at:
        try:
            age = datetime.now() - datetime.fromisoformat(started_at)
            stale = age > timedelta(hours=FOCUS_SESSION_MAX_AGE_HOURS)
        except ValueError:
            pass
    if stale:
        conn.execute(
            "DELETE FROM settings WHERE key IN "
            "('session_active', 'session_subject', 'session_started_at')"
        )
        conn.commit()
        return {"active": False}

    return {
        "active": True,
        "subject": values.get("session_subject") or None,
        "started_at": started_at,
    }


@app.get("/api/focus-session/status")
def focus_session_status(token: str | None = None):
    if not DEVICE_TOKEN or token != DEVICE_TOKEN:
        raise HTTPException(status_code=403, detail="invalid token")
    conn = get_connection()
    result = _focus_session_status(conn)
    conn.close()
    return result


# 上のstatus()はJpBlocker(Android)専用でDEVICE_TOKEN必須。こちらはWebフロント(PWA)が
# 「今どちらかのデバイスでセッション中か」を軽くポーリングしてバナー表示するための公開版。
# このアプリは個人利用でユーザー認証自体が存在せず、他の読み取り系(/api/screen-time/daily等)
# も同様に無認証で公開している方針に揃え、書き込み系のみDEVICE_TOKENを要求する既存の線引きは崩さない。
@app.get("/api/focus-session/current")
def focus_session_current():
    conn = get_connection()
    result = _focus_session_status(conn)
    conn.close()
    return result


def _send_push_to_all(conn, payload: dict) -> int:
    subs = rows_to_dicts(conn.execute("SELECT * FROM push_subscriptions"))
    sent = 0
    for sub in subs:
        subscription_info = {
            "endpoint": sub["endpoint"],
            "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=json.dumps(payload),
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": f"mailto:{VAPID_CLAIMS_EMAIL}"},
            )
            sent += 1
        except WebPushException as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            if status_code in (404, 410):
                conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (sub["endpoint"],))
    return sent


@app.post("/api/push/check")
def push_check(token: str | None = None):
    if not CRON_SECRET or token != CRON_SECRET:
        raise HTTPException(status_code=403, detail="invalid token")
    if not VAPID_PRIVATE_KEY or not VAPID_PUBLIC_KEY:
        raise HTTPException(status_code=500, detail="VAPID keys not configured")

    conn = get_connection()
    now = datetime.now()
    sent_count = 0

    todo_rows = rows_to_dicts(conn.execute(
        "SELECT * FROM todos WHERE done = 0 AND due_date IS NOT NULL AND due_time IS NOT NULL "
        "AND notify_offset_minutes IS NOT NULL AND notified_at IS NULL"
    ))
    for todo in todo_rows:
        due_dt = datetime.fromisoformat(f"{todo['due_date']}T{todo['due_time']}")
        notify_at = due_dt - timedelta(minutes=todo["notify_offset_minutes"])
        if notify_at <= now:
            sent_count += _send_push_to_all(conn, {
                "title": "Task due",
                "body": todo["title"],
                "tag": f"todo-{todo['id']}",
            })
            conn.execute("UPDATE todos SET notified_at = datetime('now') WHERE id = ?", (todo["id"],))

    event_rows = rows_to_dicts(conn.execute(
        "SELECT * FROM events WHERE notify_offset_minutes IS NOT NULL"
    ))
    window = [now.date() + timedelta(days=offset) for offset in (-1, 0, 1)]
    for event in event_rows:
        anchor = date.fromisoformat(event["date"])
        until = date.fromisoformat(event["recurrence_until"]) if event["recurrence_until"] else None
        last_notified = date.fromisoformat(event["last_notified_occurrence"]) if event["last_notified_occurrence"] else None
        occurrence_dates = []
        if not event["recurrence"]:
            if anchor in window:
                occurrence_dates.append(anchor)
        else:
            days = set(event["recurrence"].split(","))
            for d in window:
                if d < anchor:
                    continue
                if until is not None and d > until:
                    continue
                if WEEKDAY_CODES[d.weekday()] in days:
                    occurrence_dates.append(d)
        occurrence_dates.sort()
        for occ_date in occurrence_dates:
            if last_notified is not None and occ_date <= last_notified:
                continue
            start_dt = datetime.fromisoformat(f"{occ_date.isoformat()}T{event['start_time']}")
            notify_at = start_dt - timedelta(minutes=event["notify_offset_minutes"])
            if notify_at <= now:
                sent_count += _send_push_to_all(conn, {
                    "title": "Event",
                    "body": event["title"],
                    "tag": f"event-{event['id']}-{occ_date.isoformat()}",
                })
                conn.execute(
                    "UPDATE events SET last_notified_occurrence = ? WHERE id = ?",
                    (occ_date.isoformat(), event["id"]),
                )
                last_notified = occ_date

    activation_rows = rows_to_dicts(conn.execute(
        "SELECT * FROM activation_logs WHERE returned_at IS NULL AND reminded_at IS NULL"
    ))
    for act in activation_rows:
        triggered_dt = datetime.fromisoformat(act["triggered_at"].replace(" ", "T"))
        if now - triggered_dt >= timedelta(minutes=ACTIVATION_REMINDER_MINUTES):
            sent_count += _send_push_to_all(conn, {
                "title": "Activation Log",
                "body": "You haven't logged your return yet",
                "tag": f"activation-{act['id']}",
            })
            conn.execute(
                "UPDATE activation_logs SET reminded_at = datetime('now') WHERE id = ?", (act["id"],)
            )

    if int(conn.execute("SELECT CAST(strftime('%H', 'now') AS INTEGER)").fetchone()[0]) >= ACTIVATION_ENCOURAGEMENT_HOUR:
        today_str = conn.execute("SELECT date('now')").fetchone()[0]
        last_notified_row = conn.execute(
            "SELECT value FROM settings WHERE key = 'activation_encouragement_notified_date'"
        ).fetchone()
        if not last_notified_row or last_notified_row[0] != today_str:
            avg_count = conn.execute(
                "SELECT COUNT(*) * 1.0 / ? FROM activation_logs "
                "WHERE triggered_at >= datetime('now', ?, 'start of day') "
                "AND triggered_at < datetime('now', 'start of day')",
                (ACTIVATION_ENCOURAGEMENT_WINDOW_DAYS, f"-{ACTIVATION_ENCOURAGEMENT_WINDOW_DAYS} days"),
            ).fetchone()[0]
            today_count = conn.execute(
                "SELECT COUNT(*) FROM activation_logs WHERE triggered_at >= datetime('now', 'start of day')"
            ).fetchone()[0]
            avg_first_min = conn.execute(
                "SELECT AVG(first_min) FROM ("
                "SELECT MIN(CAST(strftime('%H', triggered_at) AS INTEGER) * 60 "
                "+ CAST(strftime('%M', triggered_at) AS INTEGER)) AS first_min "
                "FROM activation_logs "
                "WHERE triggered_at >= datetime('now', ?, 'start of day') "
                "AND triggered_at < datetime('now', 'start of day') "
                "GROUP BY date(triggered_at))",
                (f"-{ACTIVATION_ENCOURAGEMENT_WINDOW_DAYS} days",),
            ).fetchone()[0]
            today_first_min = conn.execute(
                "SELECT MIN(CAST(strftime('%H', triggered_at) AS INTEGER) * 60 "
                "+ CAST(strftime('%M', triggered_at) AS INTEGER)) "
                "FROM activation_logs WHERE triggered_at >= datetime('now', 'start of day')"
            ).fetchone()[0]

            notably_fewer = avg_count >= 1 and today_count <= avg_count * 0.5
            notably_later = (
                avg_first_min is not None
                and today_first_min is not None
                and today_first_min - avg_first_min >= 120
            )

            if notably_fewer or notably_later:
                sent_count += _send_push_to_all(conn, {
                    "title": "Compass",
                    "body": "It's been a bit quiet today. No pressure, take it easy",
                    "tag": "activation-encouragement",
                })
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES ('activation_encouragement_notified_date', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (today_str,),
                )

    if MOOD_REMINDER_ENABLED and int(conn.execute("SELECT CAST(strftime('%H', 'now') AS INTEGER)").fetchone()[0]) >= MOOD_REMINDER_HOUR:
        today_str = conn.execute("SELECT date('now')").fetchone()[0]
        mood_logged_today = conn.execute(
            "SELECT 1 FROM mood_logs WHERE date = ?", (today_str,)
        ).fetchone()
        if not mood_logged_today:
            last_notified_row = conn.execute(
                "SELECT value FROM settings WHERE key = 'mood_reminder_notified_date'"
            ).fetchone()
            if not last_notified_row or last_notified_row[0] != today_str:
                sent_count += _send_push_to_all(conn, {
                    "title": "Today's Mood",
                    "body": "You haven't logged your mood today yet",
                    "tag": "mood-reminder",
                })
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES ('mood_reminder_notified_date', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (today_str,),
                )

    focus_rows = {row[0]: row[1] for row in conn.execute(
        "SELECT key, value FROM settings WHERE key IN "
        "('focus_target_end_at', 'focus_target_notified', 'focus_target_subject')"
    ).fetchall()}
    focus_end_at = focus_rows.get("focus_target_end_at")
    if focus_end_at and focus_rows.get("focus_target_notified") != "1":
        if datetime.fromisoformat(focus_end_at) <= now:
            sent_count += _send_push_to_all(conn, {
                "title": "Compass",
                "body": f"{focus_rows.get('focus_target_subject') or 'Study'}: time's up",
                "tag": "focus-session",
            })
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('focus_target_notified', '1') "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            )

    conn.commit()
    conn.close()
    return {"notifications_sent": sent_count}


# ---------- static frontend ----------

app.mount("/static", StaticFiles(directory="static"), name="static")

# デプロイのたびに変わるLAST_UPDATEDをapp.js/style.cssのURLに付与し、
# ブラウザのキャッシュに古いJSが残ったままにならないようにする。
_INDEX_HTML_CACHE: str | None = None


def _render_index_html() -> str:
    global _INDEX_HTML_CACHE
    if _INDEX_HTML_CACHE is None:
        with open("static/index.html", encoding="utf-8") as f:
            html = f.read()
        v = quote(LAST_UPDATED, safe="")
        html = html.replace('href="/static/style.css"', f'href="/static/style.css?v={v}"')
        html = html.replace('src="/static/app.js"', f'src="/static/app.js?v={v}"')
        _INDEX_HTML_CACHE = html
    return _INDEX_HTML_CACHE


@app.get("/")
def index():
    return HTMLResponse(content=_render_index_html(), headers={"Cache-Control": "no-cache"})


@app.get("/manifest.json")
def manifest():
    return FileResponse("static/manifest.json")


@app.get("/service-worker.js")
def service_worker():
    return FileResponse("static/service-worker.js", headers={"Cache-Control": "no-cache"})


@app.get("/api/build-info")
def build_info():
    return {"lastUpdated": LAST_UPDATED}


def _rows_to_csv_bytes(rows: list[dict]) -> bytes:
    buf = io.StringIO()
    if rows:
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    # Excelでそのまま開いても文字化けしないようUTF-8 BOM付きにする
    return buf.getvalue().encode("utf-8-sig")


@app.get("/api/export")
def export_data():
    conn = get_connection()
    todos = rows_to_dicts(
        conn.execute(
            "SELECT id, title, category, priority, done, created_at, completed_at, "
            "due_date, due_time, recurrence, note FROM todos ORDER BY id"
        )
    )
    study_logs = rows_to_dicts(
        conn.execute(
            "SELECT id, subject, minutes, note, logged_at, start_trigger FROM study_logs ORDER BY id"
        )
    )
    conn.close()

    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("todos.csv", _rows_to_csv_bytes(todos))
        zf.writestr("study_logs.csv", _rows_to_csv_bytes(study_logs))
    zip_buf.seek(0)

    filename = f"compass-export-{datetime.now().strftime('%Y%m%d')}.zip"
    return StreamingResponse(
        zip_buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
