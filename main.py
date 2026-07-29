from datetime import date, timedelta

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from database import get_connection, init_db, row_to_dict, rows_to_dicts

app = FastAPI(title="study-tracker")

init_db()


# ---------- schemas ----------

class TodoCreate(BaseModel):
    title: str
    category: str | None = None
    priority: str = "medium"
    due_date: str | None = None
    recurrence: str | None = None  # None or "daily"


class DiaryUpsert(BaseModel):
    date: str
    content: str


class StudyLogCreate(BaseModel):
    subject: str
    minutes: int
    note: str | None = None


class GoalCreate(BaseModel):
    title: str


def next_occurrence(base: date, recurrence: str) -> date:
    next_date = base + timedelta(days=1)
    if recurrence == "weekdays":
        while next_date.weekday() >= 5:  # 5=Sat, 6=Sun
            next_date += timedelta(days=1)
    return next_date


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
        "INSERT INTO todos (title, category, priority, due_date, recurrence) VALUES (?, ?, ?, ?, ?)",
        (todo.title, todo.category, todo.priority, todo.due_date, todo.recurrence),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


@app.post("/api/todos/{todo_id}/toggle")
def toggle_todo(todo_id: int):
    conn = get_connection()
    row = conn.execute(
        "SELECT done, title, category, priority, due_date, recurrence FROM todos WHERE id = ?",
        (todo_id,),
    ).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="todo not found")
    done, title, category, priority, due_date, recurrence = row
    new_done = 0 if done else 1
    completed_at = "datetime('now')" if new_done else "NULL"
    conn.execute(
        f"UPDATE todos SET done = ?, completed_at = {completed_at} WHERE id = ?",
        (new_done, todo_id),
    )
    if new_done and recurrence in ("daily", "weekdays"):
        base = date.fromisoformat(due_date) if due_date else date.today()
        base = max(base, date.today())
        next_due = next_occurrence(base, recurrence)
        conn.execute(
            "INSERT INTO todos (title, category, priority, due_date, recurrence) VALUES (?, ?, ?, ?, ?)",
            (title, category, priority, next_due.isoformat(), recurrence),
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


# ---------- diary ----------

@app.get("/api/diary")
def list_diary():
    conn = get_connection()
    cur = conn.execute("SELECT * FROM diary_entries ORDER BY date DESC")
    result = rows_to_dicts(cur)
    conn.close()
    return result


@app.get("/api/diary/{entry_date}")
def get_diary_entry(entry_date: str):
    conn = get_connection()
    cur = conn.execute("SELECT * FROM diary_entries WHERE date = ?", (entry_date,))
    row = cur.fetchone()
    result = row_to_dict(cur, row)
    conn.close()
    if result is None:
        return {"date": entry_date, "content": ""}
    return result


@app.put("/api/diary")
def upsert_diary(entry: DiaryUpsert):
    conn = get_connection()
    conn.execute(
        """
        INSERT INTO diary_entries (date, content) VALUES (?, ?)
        ON CONFLICT(date) DO UPDATE SET content = excluded.content,
                                         updated_at = datetime('now')
        """,
        (entry.date, entry.content),
    )
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
    cur = conn.execute(
        "INSERT INTO study_logs (subject, minutes, note) VALUES (?, ?, ?)",
        (log.subject, log.minutes, log.note),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


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
