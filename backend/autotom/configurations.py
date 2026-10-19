"""Named experiment configurations, persisted independently of model files and runs."""
import re
from pathlib import Path

from .adapter import atomic_write
from .schema import SavedConfiguration
from .store import now, run_id


class Configurations:
    def __init__(self, data: Path):
        self.directory = data / "configurations"
        self.directory.mkdir(parents=True, exist_ok=True)

    def path(self, identifier):
        if not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise FileNotFoundError("Configuration not found")
        return self.directory / f"{identifier}.json"

    def get(self, identifier):
        return SavedConfiguration.model_validate_json(self.path(identifier).read_text())

    def list(self):
        records = []
        for path in self.directory.glob("*.json"):
            try:
                records.append(self.get(path.stem))
            except FileNotFoundError:
                continue  # A concurrent delete can remove a file after globbing.
        return sorted(records, key=lambda record: record.created_at, reverse=True)

    def create(self, body):
        record = SavedConfiguration(id=run_id(), name=body.name.strip(), created_at=now(), config=body.config)
        atomic_write(self.path(record.id), record.model_dump_json(indent=2) + "\n")
        return record

    def delete(self, identifier):
        self.path(identifier).unlink()
