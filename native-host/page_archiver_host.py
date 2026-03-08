#!/usr/bin/env python3
"""
page_archiver_host.py — Native Messaging Host for Page Archiver
Receives JSON messages from the Chrome/Brave extension and writes
to a SQLite database at ~/page-archiver/archive.db
"""

import sys
import json
import struct
import sqlite3
import os
import logging
from datetime import datetime

# ── Config ────────────────────────────────────────────────────────────────────

DB_DIR  = os.path.expanduser("~/page-archiver")
DB_PATH = os.path.join(DB_DIR, "archive.db")
LOG_PATH = os.path.join(DB_DIR, "host.log")

os.makedirs(DB_DIR, exist_ok=True)

logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

# ── SQLite schema ─────────────────────────────────────────────────────────────

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")  # safe for concurrent reads
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS pages (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                url           TEXT    NOT NULL UNIQUE,
                title         TEXT,
                first_seen    TEXT    NOT NULL,
                last_seen     TEXT    NOT NULL,
                snapshot_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                page_id     INTEGER NOT NULL REFERENCES pages(id),
                url         TEXT    NOT NULL,
                title       TEXT,
                filename    TEXT,
                captured_at TEXT    NOT NULL,
                size_bytes  INTEGER NOT NULL DEFAULT 0,
                trigger     TEXT    NOT NULL  -- 'visit' | 'interval' | 'manual'
            );

            CREATE INDEX IF NOT EXISTS idx_snapshots_page_id
                ON snapshots(page_id);
            CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at
                ON snapshots(captured_at);
            CREATE INDEX IF NOT EXISTS idx_pages_url
                ON pages(url);
        """)
    logging.info(f"DB initialised at {DB_PATH}")

# ── DB operations ─────────────────────────────────────────────────────────────

def record_snapshot(url, title, filename, captured_at, size_bytes, trigger):
    with get_conn() as conn:
        # Upsert page
        conn.execute("""
            INSERT INTO pages (url, title, first_seen, last_seen, snapshot_count)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(url) DO UPDATE SET
                title          = excluded.title,
                last_seen      = excluded.last_seen,
                snapshot_count = snapshot_count + 1
        """, (url, title, captured_at, captured_at))

        page_id = conn.execute(
            "SELECT id FROM pages WHERE url = ?", (url,)
        ).fetchone()["id"]

        conn.execute("""
            INSERT INTO snapshots
                (page_id, url, title, filename, captured_at, size_bytes, trigger)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (page_id, url, title, filename, captured_at, size_bytes, trigger))

    logging.info(f"Recorded snapshot: {trigger} | {url} | {filename}")
    return {"ok": True, "page_id": page_id}

def get_stats():
    with get_conn() as conn:
        pages     = conn.execute("SELECT COUNT(*) FROM pages").fetchone()[0]
        snapshots = conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
        mb        = conn.execute(
            "SELECT COALESCE(SUM(size_bytes),0) FROM snapshots"
        ).fetchone()[0] / (1024 * 1024)
        recent = conn.execute("""
            SELECT p.url, p.title, p.last_seen, p.snapshot_count
            FROM pages p
            ORDER BY p.last_seen DESC
            LIMIT 30
        """).fetchall()
    return {
        "ok": True,
        "pages": pages,
        "snapshots": snapshots,
        "mb": round(mb, 2),
        "recent": [dict(r) for r in recent],
    }

def clear_db():
    with get_conn() as conn:
        conn.execute("DELETE FROM snapshots")
        conn.execute("DELETE FROM pages")
        conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('pages','snapshots')")
    logging.info("DB cleared")
    return {"ok": True}

# ── Native Messaging I/O ──────────────────────────────────────────────────────
# Chrome sends: 4-byte little-endian length prefix + UTF-8 JSON
# We reply the same way.

def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    raw_msg = sys.stdin.buffer.read(msg_len)
    return json.loads(raw_msg.decode("utf-8"))

def send_message(obj):
    encoded = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

# ── Main loop ─────────────────────────────────────────────────────────────────

def handle(msg):
    t = msg.get("type")
    try:
        if t == "RECORD_SNAPSHOT":
            return record_snapshot(
                url         = msg["url"],
                title       = msg.get("title", ""),
                filename    = msg.get("filename", ""),
                captured_at = msg.get("capturedAt", datetime.utcnow().isoformat()),
                size_bytes  = msg.get("sizeBytes", 0),
                trigger     = msg.get("trigger", "visit"),
            )
        elif t == "GET_STATS":
            return get_stats()
        elif t == "CLEAR_DB":
            return clear_db()
        elif t == "PING":
            return {"ok": True, "db": DB_PATH}
        else:
            return {"ok": False, "error": f"Unknown type: {t}"}
    except Exception as e:
        logging.exception(f"Error handling {t}")
        return {"ok": False, "error": str(e)}

if __name__ == "__main__":
    init_db()
    logging.info("Native host started")
    while True:
        msg = read_message()
        if msg is None:
            break
        resp = handle(msg)
        send_message(resp)
    logging.info("Native host exiting")
