import json
import shutil
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, data: Path):
        self.data = data
        self.runs = data / "runs"
        self.runs.mkdir(parents=True, exist_ok=True)
        self.db = data / "autotom.sqlite"
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute('''CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
                created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                days INTEGER NOT NULL, current_day INTEGER NOT NULL DEFAULT 0,
                cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT,
                revision TEXT NOT NULL, config TEXT NOT NULL)''')

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.db, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    @staticmethod
    def decode(row):
        if row is None:
            return None
        result = dict(row)
        result["config"] = json.loads(result["config"])
        result["cancel_requested"] = bool(result["cancel_requested"])
        return result

    def get(self, run_id):
        with self.connection() as conn:
            return self.decode(conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone())

    def list(self):
        with self.connection() as conn:
            return [self.decode(row) for row in conn.execute("SELECT * FROM runs ORDER BY created_at DESC LIMIT 100")]

    def create(self, run_id, name, rev, config):
        with self.connection() as conn:
            conn.execute("INSERT INTO runs (id,name,status,created_at,days,revision,config) VALUES (?,?,?,?,?,?,?)",
                         (run_id, name, "queued", now(), config.simulation.days, rev, config.model_dump_json()))
        return self.get(run_id)

    def claim(self):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1").fetchone()
            if row is None:
                return None
            conn.execute("UPDATE runs SET status='running',started_at=? WHERE id=?", (now(), row["id"]))
            run_id = row["id"]
        return self.get(run_id)

    def update(self, run_id, **values):
        allowed = {"status", "started_at", "finished_at", "current_day", "cancel_requested", "error"}
        if not values or set(values) - allowed:
            raise ValueError("Unsupported run update")
        with self.connection() as conn:
            conn.execute("UPDATE runs SET " + ",".join(f"{key}=?" for key in values) + " WHERE id=?",
                         (*values.values(), run_id))

    def cancel(self, run_id):
        with self.connection() as conn:
            conn.execute("UPDATE runs SET cancel_requested=1 WHERE id=? AND status IN ('queued','running')", (run_id,))
            conn.execute("UPDATE runs SET status='cancelled',finished_at=? WHERE id=? AND status='queued'",
                         (now(), run_id))

    def rename(self, run_id, name):
        with self.connection() as conn:
            result = conn.execute("UPDATE runs SET name=? WHERE id=?", (name.strip(), run_id))
            if result.rowcount == 0:
                raise FileNotFoundError("Run not found")
        return self.get(run_id)

    def delete(self, run_id):
        with self.connection() as conn:
            # Serialize against worker claims so a queued run cannot start during deletion.
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT status FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                raise FileNotFoundError("Run not found")
            if row["status"] in ("queued", "running"):
                raise ValueError("Cancel the run and wait for it to stop before deleting it")
            directory = self.runs / run_id
            if directory.exists():
                shutil.rmtree(directory)
            conn.execute("DELETE FROM runs WHERE id=?", (run_id,))

    def interrupt_old_runs(self):
        with self.connection() as conn:
            conn.execute("UPDATE runs SET status='failed',error='Worker restarted during simulation; completed days are preserved',finished_at=? WHERE status='running'", (now(),))


def run_id():
    return uuid.uuid4().hex
