import calendar
import json
import os
from datetime import date, datetime, timedelta

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pywebpush import WebPushException, webpush

from database import get_connection, init_db, row_to_dict, rows_to_dicts

app = FastAPI(title="study-tracker")

init_db()

VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY")
VAPID_CLAIMS_EMAIL = os.environ.get("VAPID_CLAIMS_EMAIL", "example@example.com")
CRON_SECRET = os.environ.get("CRON_SECRET")


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


class CategoryCreate(BaseModel):
    name: str


class CategoryUpdate(BaseModel):
    name: str


class SettingsUpdate(BaseModel):
    weekly_goal_minutes: int | None = None
    monthly_goal_minutes: int | None = None
    daily_minimum_minutes: int | None = None


class StudyLogCreate(BaseModel):
    subject: str
    minutes: int
    note: str | None = None
    logged_at: str | None = None  # "YYYY-MM-DD HH:MM:SS", optional; defaults to now


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


class ActivationLogReturn(BaseModel):
    returned_at: str  # "YYYY-MM-DD HH:MM:SS", client local time


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


@app.post("/api/study-logs")
def create_study_log(log: StudyLogCreate):
    conn = get_connection()
    if log.logged_at:
        cur = conn.execute(
            "INSERT INTO study_logs (subject, minutes, note, logged_at) VALUES (?, ?, ?, ?)",
            (log.subject, log.minutes, log.note, log.logged_at),
        )
    else:
        cur = conn.execute(
            "INSERT INTO study_logs (subject, minutes, note) VALUES (?, ?, ?)",
            (log.subject, log.minutes, log.note),
        )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


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
    conn.commit()
    result = _read_settings(conn)
    conn.close()
    return result


# ---------- activation logs ----------

ACTIVATION_REMINDER_MINUTES = 45


@app.get("/api/activation-logs")
def list_activation_logs(limit: int = 200):
    conn = get_connection()
    cur = conn.execute(
        "SELECT * FROM activation_logs ORDER BY triggered_at DESC LIMIT ?", (limit,)
    )
    result = rows_to_dicts(cur)
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
        line = f"- 発動 {triggered} きっかけ: {note}"
        if r["returned_at"]:
            line += f" / 復帰 {r['returned_at'][:16]}"
        lines.append(line)
    return {"text": "\n".join(lines), "count": len(lines)}


@app.post("/api/activation-logs")
def create_activation_log(log: ActivationLogCreate):
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO activation_logs (triggered_at, note) VALUES (?, ?)",
        (log.triggered_at, log.note),
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


@app.get("/api/goals/countdown")
def goal_countdown():
    target = date(2026, 11, 30)
    days_left = (target - date.today()).days
    return {"target_date": target.isoformat(), "days_left": days_left}


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
                "title": "ToDoの期限",
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
                    "title": "予定",
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
                "title": "発動ログ",
                "body": "まだ復帰の記録がないよ",
                "tag": f"activation-{act['id']}",
            })
            conn.execute(
                "UPDATE activation_logs SET reminded_at = datetime('now') WHERE id = ?", (act["id"],)
            )

    conn.commit()
    conn.close()
    return {"notifications_sent": sent_count}


# ---------- static frontend ----------

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def index():
    return FileResponse("static/index.html")


@app.get("/manifest.json")
def manifest():
    return FileResponse("static/manifest.json")


@app.get("/service-worker.js")
def service_worker():
    return FileResponse("static/service-worker.js")
