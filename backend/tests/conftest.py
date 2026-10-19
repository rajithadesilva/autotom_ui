import os
from pathlib import Path
import pytest
from autotom.smoke import pristine_copy
from autotom.adapter import install


@pytest.fixture
def model(tmp_path):
    target = tmp_path / "model"
    reference = Path(os.getenv("REFERENCE_MODEL", "/reference"))
    if not reference.is_dir():
        pytest.fail("Mount the upstream model read-only at /reference to run integration tests")
    pristine_copy(reference, target)
    return target


@pytest.fixture
def installed(model):
    install(model)
    return model
