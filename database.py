import os
from pathlib import Path

import libsql

DB_PATH = Path(__file__).parent / "data.db"
TURSO_DATABASE_URL = os.environ.get("TURSO_DATABASE_URL")
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")

SCHEMA = """
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT,
    priority TEXT DEFAULT 'medium',
    done INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    due_date TEXT,
    due_time TEXT,
    recurrence TEXT
);

CREATE TABLE IF NOT EXISTS study_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    note TEXT,
    logged_at TEXT DEFAULT (datetime('now')),
    start_trigger TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    recurrence TEXT,
    recurrence_until TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    notify_offset_minutes INTEGER,
    last_notified_occurrence TEXT,
    note TEXT
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    done INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS activation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    triggered_at TEXT NOT NULL,
    note TEXT,
    returned_at TEXT,
    reminded_at TEXT,
    mood TEXT,
    mood_reason TEXT
);

CREATE TABLE IF NOT EXISTS mood_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    score INTEGER NOT NULL,
    note TEXT,
    reason TEXT,
    logged_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mood_logs_date ON mood_logs(date);

CREATE TABLE IF NOT EXISTS sleep_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bedtime_at TEXT NOT NULL,
    wake_at TEXT,
    logged_at TEXT DEFAULT (datetime('now'))
);
"""

DEFAULT_CATEGORIES = ("英語", "数学", "世界史", "その他")


def get_connection():
    if TURSO_DATABASE_URL:
        return libsql.connect(database=TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN)
    return libsql.connect(str(DB_PATH))


def rows_to_dicts(cursor):
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def row_to_dict(cursor, row):
    if row is None:
        return None
    columns = [col[0] for col in cursor.description]
    return dict(zip(columns, row))


def init_db():
    conn = get_connection()
    conn.executescript(SCHEMA)
    conn.commit()
    _migrate(conn)
    _seed_categories(conn)
    conn.close()


def _migrate(conn):
    cols = [row[1] for row in conn.execute("PRAGMA table_info(todos)").fetchall()]
    if "due_date" not in cols:
        conn.execute("ALTER TABLE todos ADD COLUMN due_date TEXT")
    if "recurrence" not in cols:
        conn.execute("ALTER TABLE todos ADD COLUMN recurrence TEXT")
    if "due_time" not in cols:
        conn.execute("ALTER TABLE todos ADD COLUMN due_time TEXT")
    if "notify_offset_minutes" not in cols:
        conn.execute("ALTER TABLE todos ADD COLUMN notify_offset_minutes INTEGER")
    if "notified_at" not in cols:
        conn.execute("ALTER TABLE todos ADD COLUMN notified_at TEXT")
    if "note" not in cols:
        conn.execute("ALTER TABLE todos ADD COLUMN note TEXT")
    conn.execute("UPDATE todos SET recurrence = 'mon,tue,wed,thu,fri,sat,sun' WHERE recurrence = 'daily'")
    conn.execute("UPDATE todos SET recurrence = 'mon,tue,wed,thu,fri' WHERE recurrence = 'weekdays'")

    event_cols = [row[1] for row in conn.execute("PRAGMA table_info(events)").fetchall()]
    if "notify_offset_minutes" not in event_cols:
        conn.execute("ALTER TABLE events ADD COLUMN notify_offset_minutes INTEGER")
    if "last_notified_occurrence" not in event_cols:
        conn.execute("ALTER TABLE events ADD COLUMN last_notified_occurrence TEXT")
    if "note" not in event_cols:
        conn.execute("ALTER TABLE events ADD COLUMN note TEXT")

    activation_cols = [row[1] for row in conn.execute("PRAGMA table_info(activation_logs)").fetchall()]
    if "mood" not in activation_cols:
        conn.execute("ALTER TABLE activation_logs ADD COLUMN mood TEXT")
    if "mood_reason" not in activation_cols:
        conn.execute("ALTER TABLE activation_logs ADD COLUMN mood_reason TEXT")

    mood_log_cols = [row[1] for row in conn.execute("PRAGMA table_info(mood_logs)").fetchall()]
    if "reason" not in mood_log_cols:
        conn.execute("ALTER TABLE mood_logs ADD COLUMN reason TEXT")

    # 旧スキーマは date に UNIQUE 制約があり1日1件しか記録できなかった。
    # 1日に複数回記録できるよう、UNIQUE制約なしのテーブルに作り直す(SQLiteはUNIQUE制約を直接DROPできない)。
    mood_unique_date = False
    for idx in conn.execute("PRAGMA index_list(mood_logs)").fetchall():
        idx_name, idx_unique = idx[1], idx[2]
        if idx_unique:
            idx_cols = [c[2] for c in conn.execute(f"PRAGMA index_info({idx_name})").fetchall()]
            if idx_cols == ["date"]:
                mood_unique_date = True
                break
    if mood_unique_date:
        conn.execute("ALTER TABLE mood_logs RENAME TO mood_logs_old")
        conn.execute(
            """
            CREATE TABLE mood_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                score INTEGER NOT NULL,
                note TEXT,
                reason TEXT,
                logged_at TEXT DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            "INSERT INTO mood_logs (id, date, score, note, reason, logged_at) "
            "SELECT id, date, score, note, reason, logged_at FROM mood_logs_old"
        )
        conn.execute("DROP TABLE mood_logs_old")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mood_logs_date ON mood_logs(date)")

    study_log_cols = [row[1] for row in conn.execute("PRAGMA table_info(study_logs)").fetchall()]
    if "start_trigger" not in study_log_cols:
        conn.execute("ALTER TABLE study_logs ADD COLUMN start_trigger TEXT")
    conn.commit()


def _seed_categories(conn):
    count = conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    if count == 0:
        for name in DEFAULT_CATEGORIES:
            conn.execute("INSERT INTO categories (name) VALUES (?)", (name,))
        conn.commit()
