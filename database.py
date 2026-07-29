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

CREATE TABLE IF NOT EXISTS diary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS study_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    note TEXT,
    logged_at TEXT DEFAULT (datetime('now'))
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
    conn.execute("UPDATE todos SET recurrence = 'mon,tue,wed,thu,fri,sat,sun' WHERE recurrence = 'daily'")
    conn.execute("UPDATE todos SET recurrence = 'mon,tue,wed,thu,fri' WHERE recurrence = 'weekdays'")
    conn.commit()


def _seed_categories(conn):
    count = conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    if count == 0:
        for name in DEFAULT_CATEGORIES:
            conn.execute("INSERT INTO categories (name) VALUES (?)", (name,))
        conn.commit()
