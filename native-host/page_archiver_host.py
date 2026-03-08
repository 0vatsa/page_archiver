#!/usr/bin/env python3
"""
page_archiver_host.py — Native Messaging Host for Page Archiver

DB path is read from page_archiver_host.conf (next to this script).
Default if no config: ~/Downloads/page-archiver/_sqlitedb/page_archiver.db
"""

import sys
import json
import struct
import sqlite3
import os
import base64
import logging
from datetime import datetime

# ── Config ────────────────────────────────────────────────────────────────────

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH  = os.path.join(SCRIPT_DIR, "page_archiver_host.conf")

def load_config():
    """Read DB path from .conf file. Falls back to default if missing."""
    default_db = os.path.join(
        os.path.expanduser("~"), "Downloads",
        "page-archiver", "_sqlitedb", "page_archiver.db"
    )
    if not os.path.isfile(CONFIG_PATH):
        return default_db
    try:
        with open(CONFIG_PATH) as f:
            for line in f:
                line = line.strip()
                if line.startswith("db_path"):
                    _, _, val = line.partition("=")
                    val = val.strip().strip('"').strip("'")
                    if val:
                        return os.path.expandvars(os.path.expanduser(val))
    except Exception:
        pass
    return default_db

DB_PATH  = load_config()
DB_DIR   = os.path.dirname(DB_PATH)
LOG_PATH = os.path.join(DB_DIR, "host.log")

os.makedirs(DB_DIR, exist_ok=True)

logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

# ── SQLite schema + migration ─────────────────────────────────────────────────

SCHEMA = """
    CREATE TABLE IF NOT EXISTS pages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        url            TEXT    NOT NULL UNIQUE,
        title          TEXT,
        first_seen     TEXT    NOT NULL,
        last_seen      TEXT    NOT NULL,
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
        trigger     TEXT    NOT NULL,
        mhtml_blob  BLOB             -- raw MHTML bytes; NULL if not stored
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_page_id   ON snapshots(page_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at ON snapshots(captured_at);
    CREATE INDEX IF NOT EXISTS idx_pages_url           ON pages(url);
"""

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
    logging.info(f"DB ready at {DB_PATH}")

def _migrate(conn):
    """Add mhtml_blob column to existing DBs that predate this version."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(snapshots)").fetchall()]
    if "mhtml_blob" not in cols:
        conn.execute("ALTER TABLE snapshots ADD COLUMN mhtml_blob BLOB")
        logging.info("Migration: added mhtml_blob column")

# ── DB operations ─────────────────────────────────────────────────────────────

def record_snapshot(url, title, filename, captured_at, size_bytes, trigger, mhtml_b64=None):
    # Decode base64 → raw bytes for BLOB storage
    blob = None
    if mhtml_b64:
        try:
            blob = base64.b64decode(mhtml_b64)
        except Exception as e:
            logging.warning(f"Could not decode mhtml_b64: {e}")

    with get_conn() as conn:
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
                (page_id, url, title, filename, captured_at, size_bytes, trigger, mhtml_blob)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (page_id, url, title, filename, captured_at, size_bytes, trigger, blob))

    blob_note = f" | blob: {len(blob):,} bytes" if blob else ""
    logging.info(f"Recorded: {trigger} | {url}{blob_note}")
    return {"ok": True, "page_id": page_id}

def get_stats():
    with get_conn() as conn:
        pages     = conn.execute("SELECT COUNT(*) FROM pages").fetchone()[0]
        snapshots = conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
        # size_bytes tracks the file size; also show blob storage size separately
        file_mb   = (conn.execute(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM snapshots"
        ).fetchone()[0] or 0) / (1024 * 1024)
        blob_mb   = (conn.execute(
            "SELECT COALESCE(SUM(LENGTH(mhtml_blob)), 0) FROM snapshots WHERE mhtml_blob IS NOT NULL"
        ).fetchone()[0] or 0) / (1024 * 1024)
        recent = conn.execute("""
            SELECT p.url, p.title, p.last_seen, p.snapshot_count
            FROM pages p
            ORDER BY p.last_seen DESC
            LIMIT 30
        """).fetchall()
    return {
        "ok":        True,
        "pages":     pages,
        "snapshots": snapshots,
        "mb":        round(file_mb, 2),
        "blob_mb":   round(blob_mb, 2),
        "recent":    [dict(r) for r in recent],
        "db":        DB_PATH,
    }

def clear_db():
    with get_conn() as conn:
        conn.execute("DELETE FROM snapshots")
        conn.execute("DELETE FROM pages")
        conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('pages','snapshots')")
    logging.info("DB cleared")
    return {"ok": True}

def export_mhtml(snapshot_id):
    """Return base64-encoded MHTML blob for a given snapshot id."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT mhtml_blob, filename FROM snapshots WHERE id = ?", (snapshot_id,)
        ).fetchone()
    if not row or row["mhtml_blob"] is None:
        return {"ok": False, "error": "No blob stored for this snapshot"}
    return {
        "ok":       True,
        "filename": row["filename"],
        "mhtml_b64": base64.b64encode(row["mhtml_blob"]).decode("ascii"),
    }

# ── Native Messaging I/O ──────────────────────────────────────────────────────

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
                mhtml_b64   = msg.get("mhtmlBase64"),
            )
        elif t == "GET_STATS":
            return get_stats()
        elif t == "CLEAR_DB":
            return clear_db()
        elif t == "EXPORT_MHTML":
            return export_mhtml(msg["snapshot_id"])
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
