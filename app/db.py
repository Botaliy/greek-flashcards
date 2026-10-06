import os
import sqlite3
import time
from pathlib import Path

DB_PATH = os.environ.get("DB_PATH", "data/greek.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    greek TEXT NOT NULL,
    russian TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS words_group ON words(group_id);
-- Per-user state of a word. box = Leitner box 0..5, due_at = when to show again.
CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
    learned INTEGER NOT NULL DEFAULT 0,
    learned_at INTEGER,
    box INTEGER NOT NULL DEFAULT 0,
    correct INTEGER NOT NULL DEFAULT 0,
    wrong INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER,
    due_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, word_id)
);
-- Every single answer, for activity charts and streaks.
CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    word_id INTEGER REFERENCES words(id) ON DELETE SET NULL,
    ts INTEGER NOT NULL,
    correct INTEGER NOT NULL,
    direction TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_user_ts ON reviews(user_id, ts);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    if conn.execute("SELECT COUNT(*) FROM groups").fetchone()[0] == 0:
        from .seed import seed_rows

        now = int(time.time())
        for pos, (group, words) in enumerate(seed_rows()):
            gid = conn.execute(
                "INSERT INTO groups (name, position) VALUES (?, ?)", (group, pos)
            ).lastrowid
            conn.executemany(
                "INSERT INTO words (group_id, greek, russian, note, created_at) VALUES (?, ?, ?, ?, ?)",
                [(gid, g, r, n, now) for g, r, n in words],
            )
    conn.commit()
    conn.close()
