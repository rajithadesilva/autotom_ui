"""The browser and model share metres, degrees, Z-up, Euler XYZ rotations."""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

Finite = Annotated[float, Field(allow_inf_nan=False)]
Positive = Annotated[Finite, Field(gt=0, le=100)]
Unit = Annotated[Finite, Field(ge=0, le=1)]
Vector = tuple[Finite, Finite, Finite]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SceneObject(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    name: str = Field(min_length=1, max_length=80)
    kind: Literal["led", "box", "panel"]
    position: Vector
    rotation: Vector = (0, 0, 0)
    size: tuple[Positive, Positive, Positive] = (0.1, 0.1, 0.1)
    power_w: Finite = Field(default=43.8, ge=0, le=10000)
    reflectance: Unit = 0.5
    enabled: bool = True

    @model_validator(mode="after")
    def valid_pose(self):
        if any(abs(v) > 100 for v in self.position):
            raise ValueError("Object coordinates must be within ±100 metres")
        if any(abs(v) > 360 for v in self.rotation):
            raise ValueError("Rotation must be within ±360 degrees")
        return self


class Room(StrictModel):
    width: Positive = 1.2
    length: Positive = 1.2
    height: Positive = 0.735
    enabled: bool = True
    # None preserves the original spectral reflectance/transmission curves.
    wall_reflectance: Unit | None = None
    floor_reflectance: Unit | None = None
    ceiling_reflectance: Unit | None = None


class Simulation(StrictModel):
    days: int = Field(default=80, ge=1, le=365)
    rows: int = Field(default=3, ge=1, le=20)
    plants_per_row: int = Field(default=3, ge=1, le=20)
    density: Finite = Field(default=50, gt=0, le=500)
    border_rows: int = Field(default=2, ge=0, le=10)
    border_plants: int = Field(default=2, ge=0, le=10)
    seed: int = Field(default=0, ge=0, le=2147483647)
    rays: int = Field(default=21474000, ge=1000, le=2147482999)
    photoperiod: Finite = Field(default=16, gt=0, le=24)
    plant_input: str = "base_plant_dynamic_50.csv"
    temperature_input: str = "total_daily_avg_temperature_group_exp2.csv"
    emission_input: str = "light_distribution.csv"
    spectrum_input: str = "spectrum.csv"

    @model_validator(mode="after")
    def safe_filenames(self):
        for name in (self.plant_input, self.temperature_input, self.emission_input, self.spectrum_input):
            if not name.endswith(".csv") or "/" in name or "\\" in name or name.startswith("."):
                raise ValueError("Inputs must be CSV filenames within the model input folders")
        if self.rows * self.plants_per_row > 100:
            raise ValueError("At most 100 simulated plants per run")
        return self


class SpectrumPoint(StrictModel):
    wavelength: Finite = Field(ge=400, le=700)
    amplitude: Finite = Field(ge=0, le=1e6)


class Configuration(StrictModel):
    version: Literal[1] = 1
    room: Room = Field(default_factory=Room)
    simulation: Simulation = Field(default_factory=Simulation)
    objects: list[SceneObject] = Field(default_factory=list, max_length=200)
    spectrum: list[SpectrumPoint] = Field(min_length=2, max_length=301)

    @model_validator(mode="after")
    def consistent_scene(self):
        ids = [o.id for o in self.objects]
        if len(ids) != len(set(ids)):
            raise ValueError("Object IDs must be unique")
        wavelengths = [p.wavelength for p in self.spectrum]
        if wavelengths != sorted(set(wavelengths)) or wavelengths[0] != 400 or wavelengths[-1] != 700:
            raise ValueError("Spectrum must increase strictly from 400 to 700 nm")
        if not any(p.amplitude > 0 for p in self.spectrum):
            raise ValueError("Spectrum must have nonzero power")
        return self


class SaveConfiguration(StrictModel):
    revision: str
    config: Configuration


class CreateRun(StrictModel):
    revision: str
    name: str = Field(default="Tomato simulation", min_length=1, max_length=100)


class Metric(StrictModel):
    plant: int
    model_age_days: int
    biomass_g: Finite
    fruit_g: Finite
    leaf_area_m2: Finite
    par_umol_s: Finite
    par_mmol_day: Finite
    carbon_mmol_day: Finite


class DailyResult(StrictModel):
    day: int
    plants: list[Metric]


class ConfigurationResponse(StrictModel):
    config: Configuration
    revision: str
    installed: bool
    inputs: dict[str, list[str]]


class RunRecord(StrictModel):
    id: str
    name: str
    status: Literal["queued", "running", "completed", "failed", "cancelled"]
    created_at: str
    started_at: str | None
    finished_at: str | None
    days: int
    current_day: int
    cancel_requested: bool
    error: str | None
    revision: str
    config: Configuration


class RunDetail(RunRecord):
    available_days: list[int]
    raw_available: bool


class WorkerStatus(StrictModel):
    ready: bool
    error: str | None = None
    gpu: str | None = None
    groimp: str | None = None
    updated_at: str | None = None
    run_id: str | None = None


class HealthResponse(StrictModel):
    status: Literal["ok"]
    worker: WorkerStatus


class LogResponse(StrictModel):
    text: str
