"""Append-only audit log in SQLite (UPDATE/DELETE blocked by triggers)."""
from __future__ import annotations

import csv
import io
import json
import sqlite3
import threading
import time

from app import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, tick INTEGER, actor TEXT NOT NULL,
  event TEXT NOT NULL, asset TEXT, level TEXT, payload TEXT);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'append-only'); END;
"""


class Audit:
    def __init__(self, path=None):
        self.db = sqlite3.connect(str(path or config.DATA_DIR / "audit.db"), check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()

    def log(self, actor: str, event: str, asset: str | None = None, level: str | None = None,
            payload: dict | None = None, tick: int | None = None) -> dict:
        row = (time.time(), tick, actor, event, asset, level, json.dumps(payload or {}, default=str))
        with self.lock:
            cur = self.db.execute("INSERT INTO audit (ts,tick,actor,event,asset,level,payload) VALUES (?,?,?,?,?,?,?)", row)
            self.db.commit()
        return {"id": cur.lastrowid, "ts": row[0], "tick": tick, "actor": actor, "event": event, "asset": asset,
                "level": level, "payload": payload or {}}

    def query(self, actor=None, asset=None, q=None, limit=500) -> list[dict]:
        sql, args = "SELECT id,ts,tick,actor,event,asset,level,payload FROM audit WHERE 1=1", []
        if actor:
            sql, args = sql + " AND actor=?", args + [actor]
        if asset:
            sql, args = sql + " AND asset=?", args + [asset]
        if q:
            sql, args = sql + " AND (event LIKE ? OR payload LIKE ?)", args + [f"%{q}%", f"%{q}%"]
        sql += " ORDER BY id DESC LIMIT ?"
        with self.lock:
            rows = self.db.execute(sql, args + [limit]).fetchall()
        return [{"id": r[0], "ts": r[1], "tick": r[2], "actor": r[3], "event": r[4], "asset": r[5], "level": r[6],
                 "payload": json.loads(r[7] or "{}")} for r in rows]

    def csv(self) -> str:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["id", "time", "tick", "actor", "event", "asset", "provenance_level", "payload"])
        for r in reversed(self.query(limit=100000)):
            w.writerow([r["id"], time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["ts"])), r["tick"], r["actor"],
                        r["event"], r["asset"], r["level"], json.dumps(r["payload"])])
        return buf.getvalue()
