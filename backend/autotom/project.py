import fcntl
import json
import shutil
from contextlib import contextmanager
from pathlib import Path
from .adapter import ADAPTER_VERSION, Conflict, GENERATED_FILES, ModelError, atomic_write, adapter_status, install, read_config, revision, validate_inputs, write_config
from .store import Store, run_id
from .inspection import STATE_FIELDS, snapshot_inputs


class Project:
    def __init__(self, model: Path, store: Store):
        self.model, self.store = model, store

    @contextmanager
    def locked(self):
        if not self.model.is_dir():
            raise ModelError("Model folder is not mounted")
        with (self.model / ".autotom.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def setup(self):
        with self.locked():
            install(self.model)
        return self.read()

    def read(self):
        with self.locked():
            config = read_config(self.model)
            rev = revision(self.model)
            installed = (self.model / ".autotom-adapter.json").exists()
            inputs = {folder: sorted(p.name for p in (self.model / "input" / folder).glob("*.csv"))
                      for folder in ("dynamic_input", "temperature", "light_spectrum", "light_emission_pattern")}
            inputs = {folder: [name for name in names if not name.startswith("autotom_effective_")] for folder, names in inputs.items()}
            return {"config": config.model_dump(), "revision": rev, "installed": installed, "inputs": inputs, "adapter": adapter_status(self.model)}

    def assert_revision(self, expected):
        if revision(self.model) != expected:
            raise Conflict("Model files changed outside this editor. Reload the configuration before saving or running.")
        if not adapter_status(self.model)["compatible"]:
            raise ModelError("Install or upgrade the model adapter before saving or running")

    def save(self, expected, config):
        with self.locked():
            self.assert_revision(expected)
            originals = {name: (self.model / name).read_bytes() if (self.model / name).exists() else None for name in GENERATED_FILES}
            try:
                write_config(self.model, config)
            except Exception:
                for name, content in originals.items():
                    if content is None:
                        (self.model / name).unlink(missing_ok=True)
                    else:
                        atomic_write(self.model / name, content)
                raise
        return self.read()

    def create_run(self, expected, name):
        identifier = run_id()
        pending = self.store.runs / (".creating-" + identifier)
        final = self.store.runs / identifier
        try:
            with self.locked():
                self.assert_revision(expected)
                config = read_config(self.model)
                validate_inputs(self.model, config)
                def ignore(directory, names):
                    return [name for name in names if name.startswith(".") or
                            (Path(directory) == self.model and name == "output")]
                shutil.copytree(self.model, pending / "model", ignore=ignore)
                if revision(self.model) != expected or revision(pending / "model") != expected:
                    raise Conflict("Model files changed while taking the run snapshot. Reload and try again.")
                atomic_write(pending / "config.json", config.model_dump_json(indent=2))
                atomic_write(pending / 'inspection-inputs.json', json.dumps({
                    'version': 1, 'fields': STATE_FIELDS,
                    **snapshot_inputs(pending / 'model', config.model_dump(mode='json'))}, allow_nan=False))
                atomic_write(pending / "provenance.json", json.dumps({"source_revision": expected,
                    "adapter_version": adapter_status(self.model)['version'] or ADAPTER_VERSION, "groimp": "2.2", "java": "21", "coordinates": "Z-up, metres, Euler XYZ degrees"}, indent=2))
                pending.rename(final)
                return self.store.create(identifier, name, expected, config)
        except Exception:
            shutil.rmtree(pending, ignore_errors=True)
            shutil.rmtree(final, ignore_errors=True)
            raise
