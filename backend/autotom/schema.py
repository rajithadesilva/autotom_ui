"""The browser and model share metres, degrees, Z-up, Euler XYZ rotations."""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .layout import generate_layout
from .parameters import validate_overrides

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


class Plant(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    name: str = Field(min_length=1, max_length=80)
    role: Literal["central", "border"] = "central"
    reporting_id: int | None = Field(default=None, ge=1, le=2147483647)
    position: Vector
    rotation: Vector = (0, 0, 0)
    enabled: bool = True
    row: int = 1
    col: int = 1

    @model_validator(mode="after")
    def valid_plant(self):
        if any(abs(n) > 100 for n in self.position) or self.rotation[:2] != (0, 0) or abs(self.rotation[2]) > 360:
            raise ValueError("Plants must be upright, within ±100 metres and ±360 degrees")
        if (self.role == "central") != (self.reporting_id is not None):
            raise ValueError("Only central plants must have reporting IDs")
        return self


class Planting(StrictModel):
    mode: Literal["preset", "custom"] = "preset"
    pattern: Literal["grid", "staggered"] = "grid"
    plant_spacing: Positive | None = None
    row_spacing: Positive | None = None
    center: Vector = (0.6, 0.6, 0)
    rotation: Finite = Field(default=0, ge=-360, le=360)
    plants: list[Plant] = Field(max_length=2000)
    next_reporting_id: int = Field(ge=1, le=2147483647)


class EditorGroup(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    name: str = Field(min_length=1, max_length=80)
    members: list[str] = Field(min_length=2, max_length=2200)


class LayoutRequest(StrictModel):
    simulation: Simulation
    room: Room
    pattern: Literal["grid", "staggered"] = "grid"
    plant_spacing: Positive | None = None
    row_spacing: Positive | None = None
    center: Vector
    rotation: Finite = Field(default=0, ge=-360, le=360)


class InputPreviewRequest(StrictModel):
    plant_input: str
    temperature_input: str


class SpectrumPoint(StrictModel):
    wavelength: Finite = Field(ge=400, le=700)
    amplitude: Finite = Field(ge=0, le=1e6)


class Configuration(StrictModel):
    version: Literal[2] = 2
    room: Room = Field(default_factory=Room)
    simulation: Simulation = Field(default_factory=Simulation)
    objects: list[SceneObject] = Field(default_factory=list, max_length=200)
    spectrum: list[SpectrumPoint] = Field(min_length=2, max_length=301)

    planting: Planting
    groups: list[EditorGroup] = Field(default_factory=list, max_length=1100)
    parameter_overrides: dict[str, int | float | bool | list[float]] = Field(default_factory=dict)
    temperature_overrides: dict[str, Finite] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def migrate(cls, data):
        if not isinstance(data, dict):
            return data
        data = dict(data)
        if data.get('version', 1) == 1 or 'planting' not in data:
            sim = Simulation.model_validate(data.get('simulation', {})).model_dump()
            room = Room.model_validate(data.get('room', {})).model_dump()
            if 'planting' not in data:
                layout = generate_layout(sim, room, legacy=True)
                used = {o.get('id') for o in data.get('objects', []) if isinstance(o, dict)}
                for index, plant in enumerate(layout['plants']):
                    suffix = 0
                    while plant['id'] in used:
                        suffix += 1
                        plant['id'] = f'plant-{index+1}-migrated-{suffix}'
                    used.add(plant['id'])
                data['planting'] = layout
            if data.get('version', 1) == 1:
                data['version'] = 2
        validate_overrides(data.get('parameter_overrides', {}))
        temperatures = data.get('temperature_overrides', {})
        if not isinstance(temperatures, dict):
            raise ValueError('Temperature overrides must be an object')
        for key in temperatures:
            if not isinstance(key, str) or not key.isdigit() or str(int(key)) != key or not 0 <= int(key) < 365:
                raise ValueError('Temperature override days must be integers from 0 to 364')
        return data

    @model_validator(mode="after")
    def consistent_scene(self):
        ids = [o.id for o in self.objects] + [p.id for p in self.planting.plants]
        reports = [p.reporting_id for p in self.planting.plants if p.role == 'central']
        if len(reports) != len(set(reports)) or (reports and self.planting.next_reporting_id <= max(reports)):
            raise ValueError('Plant reporting IDs must be unique and below next_reporting_id')
        central = sum(p.enabled and p.role == 'central' for p in self.planting.plants)
        border = sum(p.enabled and p.role == 'border' for p in self.planting.plants)
        if not 1 <= central <= 100 or border > 1000:
            raise ValueError('Require 1–100 enabled central plants and at most 1000 enabled border clones')
        members = [m for group in self.groups for m in group.members]
        if len({g.id for g in self.groups}) != len(self.groups) or set(g.id for g in self.groups) & set(ids):
            raise ValueError('Group IDs must be unique and separate from item IDs')
        if len(members) != len(set(members)) or not set(members) <= set(ids):
            raise ValueError('Group members must exist and belong to only one group')
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


class AdapterStatus(StrictModel):
    version: int | None
    required_version: int
    compatible: bool
    upgrade_available: bool


class ParameterDefinition(StrictModel):
    key: str
    symbol: str
    row: int | None = None
    label: str
    type: Literal["number", "integer", "array", "boolean"]
    group: str
    unit: str
    description: str = ""
    min: Finite | None = None
    max: Finite | None = None
    length: int | None = None
    default: int | float | bool | list[Finite] | None = None
    value: int | float | bool | list[Finite]


class InputPreviewResponse(StrictModel):
    parameters: list[ParameterDefinition]
    temperatures: list[Finite]
    revision: str


class ConfigurationResponse(StrictModel):
    config: Configuration
    revision: str
    installed: bool
    inputs: dict[str, list[str]]
    adapter: AdapterStatus


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
