"""Versioned, backed-up integration of the upstream XL model; no biology rewrite."""
import csv
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from pydantic import ValidationError
from .schema import Configuration, SceneObject, SpectrumPoint

ADAPTER_VERSION = 1
UPSTREAM_COMMIT = "2d727a3364f87392b3f8b74d8ff7127cc5090c3a"
PATCHED_FILES = ["Model.rgg", "initiation.rgg", "light.rgg", "surroundings.rgg",
                 "param/parameters.rgg", "param/parameters_derived.rgg", "project.gs", "META-INF/MANIFEST.MF"]
GENERATED_FILES = ["autotom.json", "autotom.properties", "autotom_scene.rgg"]


class ModelError(ValueError):
    pass


class Conflict(ModelError):
    pass


def atomic_write(path: Path, content: str | bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = content.encode("utf-8") if isinstance(content, str) else content
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".autotom-")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def revision(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if any(part.startswith(".") for part in rel.parts) or rel.parts[0] == "output":
            continue
        if path.is_symlink():
            raise ModelError(f"Model symlinks are not supported: {rel}")
        if path.is_file():
            digest.update(str(rel).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def read_config(root: Path) -> Configuration:
    if (root / "autotom.json").exists():
        try:
            return Configuration.model_validate_json((root / "autotom.json").read_text())
        except ValidationError as error:
            raise ModelError(f"Invalid host autotom.json: {error}") from error
    return default_config(root)


def default_config(root: Path) -> Configuration:
    try:
        with (root / "input/light_spectrum/spectrum.csv").open(encoding="utf-8-sig") as f:
            points = [SpectrumPoint(wavelength=float(r[0]), amplitude=float(r[1]))
                      for r in list(csv.reader(f))[1:] if r and 400 <= float(r[0]) <= 700]
    except (OSError, ValueError, IndexError) as e:
        raise ModelError("The upstream spectrum.csv is missing or invalid; mount the complete model folder") from e
    # Original GridLamp is a 3x3 set of downward-facing point emitters.
    lamps = [SceneObject(id=f"led-{x}-{y}", name=f"LED {x * 3 + y + 1}", kind="led",
                         position=(0.2 + x * 0.4, 0.2 + y * 0.4, 0.725), rotation=(180, 0, 0))
             for x in range(3) for y in range(3)]
    return Configuration(objects=lamps, spectrum=points)


def validate_inputs(root: Path, config: Configuration):
    sim = config.simulation
    for folder, filename in [("dynamic_input", sim.plant_input), ("temperature", sim.temperature_input),
                             ("light_spectrum", sim.spectrum_input), ("light_emission_pattern", sim.emission_input)]:
        path = root / "input" / folder / filename
        if not path.is_file() or path.is_symlink():
            raise ModelError(f"Missing model input: input/{folder}/{filename}")
    with (root / "input/temperature" / sim.temperature_input).open(encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))[1:]
    if len(rows) < sim.days:
        raise ModelError(f"Temperature input has {len(rows)} days; {sim.days} are required")
    try:
        for i, row in enumerate(rows[:sim.days]):
            if int(row[0]) != i or not math.isfinite(float(row[1])):
                raise ValueError()
    except (ValueError, IndexError) as e:
        raise ModelError("Temperature rows must contain consecutive days starting at 0 and finite temperatures") from e


def matrix(position, rotation) -> list[float]:
    """Row-major T*Rx*Ry*Rz, matching Three Euler(order='XYZ'), Z-up."""
    x, y, z = (math.radians(v) for v in rotation)
    a, b, c, d, e, f = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    return [c*e, -c*f, d, position[0], a*f+b*e*d, a*e-b*f*d, -b*c, position[1],
            b*f-a*e*d, b*e+a*f*d, a*c, position[2], 0, 0, 0, 1]


def number(value):
    return format(float(value), ".12g") + (".0" if float(value).is_integer() else "")


def scene_source(config: Configuration) -> str:
    branches = ["[if(ROOM)(Walls RoomFloor Ceiling)]"]
    for obj in config.objects:
        if not obj.enabled or (obj.kind == "led" and obj.power_w == 0):
            continue
        pose = ",".join(number(v) for v in matrix(obj.position, obj.rotation))
        prefix = f"[AutoTomPose(new double[]{{{pose}}}) "
        if obj.kind == "led":
            branches.append(prefix + f"AutoTomLED({number(obj.power_w)})]")
        else:
            # GroIMP Box: length along local Z, width X, height Y, anchored at Z=0.
            # Panels use a thin physical slab, giving the same two-sided surface in both views.
            sx, sy, sz = obj.size
            branches.append(prefix + f"Translate(0,0,{-sz/2:.12g}) Box({number(sz)},{number(sx)},{number(sy)}).(setShader(autoTomSurface({number(obj.reflectance)})))]")
    return '''// Generated from autotom.json. Coordinates: metres, Z-up; Euler XYZ degrees.
import static parameters.*;
import static parameters_derived.*;
import static surroundings.*;
import de.grogra.gpuflux.imp3d.spectral.IrregularSpectralCurve;
import de.grogra.gpuflux.imp3d.objects.*;
import de.grogra.gpuflux.imp3d.shading.ChannelSPD;
import javax.vecmath.Matrix4d;

module AutoTomPose(double[] values) extends Null {
    { if (values != null) { setTransform(new Matrix4d(values)); } }
}

module AutoTomLED(double power) extends LightNode {
    { if (power > 0) { setLight(new SpectralLight(new IrregularSpectralCurve(WAVELENGTHS, AMPLITUDES)).(
        setPower(power), setLight(new PhysicalLight(LIGHT_DISTRIBUTION)))); } }
}

static Phong autoTomSurface(double value) {
    float[] values = new float[WAVELENGTHS.length];
    java.util.Arrays.fill(values, (float)value);
    return new Phong().(setDiffuse(new ChannelSPD(new IrregularSpectralCurve(WAVELENGTHS, values))));
}

module AutoTomEnvironment ==> [
''' + "\n".join(branches) + "\n];\n"


def properties(config: Configuration) -> str:
    sim, room = config.simulation, config.room
    entries = {**sim.model_dump(), **room.model_dump()}
    entries["room_enabled"] = entries.pop("enabled")
    entries["spectrum_wavelengths"] = ",".join(str(p.wavelength) for p in config.spectrum)
    entries["spectrum_amplitudes"] = ",".join(str(p.amplitude) for p in config.spectrum)
    return "# Generated by AutoTom; editable via the browser.\n" + "\n".join(
        f"{key}={str(value).lower() if isinstance(value, bool) else value}"
        for key, value in entries.items() if value is not None) + "\n"


def write_config(root: Path, config: Configuration):
    validate_inputs(root, config)
    atomic_write(root / "autotom_scene.rgg", scene_source(config))
    atomic_write(root / "autotom.properties", properties(config))
    atomic_write(root / "autotom.json", config.model_dump_json(indent=2) + "\n")


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if source.count(old) != 1:
        raise ModelError(f"Unsupported or modified model region: {label}; no files were patched")
    return source.replace(old, new, 1)


def replace_method(source: str, signature: str, body: str) -> str:
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 1
    cursor = opening + 1
    while depth:
        if source[cursor] == "{":
            depth += 1
        elif source[cursor] == "}":
            depth -= 1
        cursor += 1
    return source[:opening] + "{\n" + body + "\n}" + source[cursor:]


PROPERTIES_HELPERS = '''// AutoTom adapter v1. Read configuration before scene/material construction.
static java.util.Properties UI_CFG = uiLoad();
static java.util.Properties uiLoad() {
    java.util.Properties p = new java.util.Properties();
    java.io.File file = new java.io.File(System.getProperty("autotom.modelDir", getWD())+"autotom.properties");
    if (!file.isFile()) { throw new IllegalStateException("Missing autotom.properties; run AutoTom setup"); }
    java.io.FileInputStream stream = new java.io.FileInputStream(file);
    p.load(stream);
    stream.close();
    return p;
}
static String uiText(String key, String fallback) { return UI_CFG.getProperty(key, fallback); }
static double uiDouble(String key, double fallback) { return Double.parseDouble(uiText(key, ""+fallback)); }
static float uiFloat(String key, float fallback) { return (float)uiDouble(key, fallback); }
static int uiInt(String key, int fallback) { return (int)uiDouble(key, fallback); }
static boolean uiBool(String key, boolean fallback) { return Boolean.parseBoolean(uiText(key, ""+fallback)); }
static float[] uiOptics(String key, float[] original, boolean transmission) {
    if (UI_CFG.getProperty(key) == null) { return original; }
    float[] values = new float[original.length];
    java.util.Arrays.fill(values, transmission ? 0.0f : uiFloat(key, 0.0f));
    return values;
}
static float[] uiSpectrum(float[] wavelengths, float[] original) {
    if (UI_CFG.getProperty("spectrum_wavelengths") == null) { return original; }
    String[] ws = uiText("spectrum_wavelengths", "").split(",");
    String[] vs = uiText("spectrum_amplitudes", "").split(",");
    float[] values = new float[wavelengths.length];
    for(int i=0; i<values.length; i++) {
        int j=0;
        while(j<ws.length-2 && Double.parseDouble(ws[j+1])<wavelengths[i]) { j++; }
        double t=(wavelengths[i]-Double.parseDouble(ws[j]))/(Double.parseDouble(ws[j+1])-Double.parseDouble(ws[j]));
        values[i]=(float)((1-t)*Double.parseDouble(vs[j])+t*Double.parseDouble(vs[j+1]));
    }
    return values;
}
'''

RUN_BODY = '''    try {
        println("AUTOTOM_STARTED");
        reset();
        runHeadless();
        println("AUTOTOM_COMPLETE");
        System.exit(0);
    } catch (Throwable error) {
        error.printStackTrace();
        System.exit(1);
    }'''

HEADLESS_BODY = '''    dynamicModel = true;
    nr_file = 0;
    String filename = listOfFiles[0].getName();
    resetFilesDynamic(filename);
    for (int day=1; day<=DURATION_DAYS; day++) {
        if (time == 0) {
            MTG = readMTGData(PATH_INPUT+PATH_DYNAMIC_IN+filename);
            derive();
            createMTG((* PlantBase *));
        } else { develop(); }
        derive();
        update_light();
        update_crop();
        derive();
        exportDynamicToFile(filename);
        autoTomExportDay(day);
        println("AUTOTOM_DAY " + day);
    }'''

EXPORT_HELPER = '''
// Each ready marker follows all exports; the worker publishes the whole day atomically.
static void autoTomExportDay(int day) {
    String dir = PATH_OUTPUT+"days/"+String.format("%04d", day)+"/";
    new File(dir).mkdirs();
    export3DScene(dir+"scene.obj", "obj");
    export3DScene(dir+"plants.obj", "obj", first((* CropBase *)));
    PrintWriter metrics = new PrintWriter(new FileWriter(dir+"metrics.csv", false));
    metrics.println("plant,model_age_days,biomass_g,fruit_g,leaf_area_m2,par_umol_s,par_mmol_day,carbon_mmol_day");
    [pb:PlantBase ::> {
        metrics.println(pb[plant_number]+","+pb[age_in_days_d]+","+
            pb[dry_biomass_plant_with_roots_mg]/1000.0+","+pb[dry_biomass_fruits_mg]/1000.0+","+
            pb[leaf_area_m2]+","+pb[PAR_absorbed_per_plant_all_second_umol]+","+
            pb[PAR_absorbed_per_plant_all_second_umol]*PHOTOPERIOD*3.6+","+
            pb[carbon_assimilation_plant_daily_umol]/1000.0);
    }]
    metrics.close();
    new File(dir+"ready").createNewFile();
}
'''


def patched_sources(root: Path) -> dict[str, bytes]:
    sources = {name: (root / name).read_bytes().decode("cp1252").replace("\r\n", "\n") for name in PATCHED_FILES}
    param = PROPERTIES_HELPERS + "\n" + sources["param/parameters.rgg"]
    fields = {"DURATION_DAYS": ("days", "int"), "LENGTH1": ("length", "float"), "WIDTH": ("width", "float"),
              "NR_PLANTS": ("plants_per_row", "int"), "NR_ROWS": ("rows", "int"),
              "NR_BORDER_ROWS": ("border_rows", "int"), "NR_BORDER_PLANTS_IN_ROW": ("border_plants", "int"),
              "PHOTOPERIOD": ("photoperiod", "double"), "SET_SEED": ("seed", "int"), "RAYS_GPU": ("rays", "int"),
              "ROOM": ("room_enabled", "boolean")}
    for symbol, (key, kind) in fields.items():
        pattern = rf"((?:static|const)\s+{kind}\s+{symbol}\s*=\s*)([^;]+)(;)"
        method = {"int": "uiInt", "float": "uiFloat", "double": "uiDouble", "boolean": "uiBool"}[kind]
        def replacement(m):
            fallback = m[2].strip() + ("f" if kind == "float" else "")
            return m[1]+f'{method}("{key}", {fallback})'+m[3]
        param, count = re.subn(pattern, replacement, param, count=1)
        if count != 1:
            raise ModelError(f"Unsupported model parameter {symbol}")
    param, count = re.subn(r"(static\s+float\s+HEIGHT)\s*;", r'\1 = uiFloat("height", 0.735f);', param, count=1)
    if count != 1:
        raise ModelError("Unsupported model HEIGHT declaration")
    param = param.replace('getWD()+"input/"', 'System.getProperty("autotom.modelDir", getWD())+"input/"')
    param = param.replace('getWD()+"output/"', 'System.getProperty("autotom.modelDir", getWD())+"output/"')
    sources["param/parameters.rgg"] = param

    derived = sources["param/parameters_derived.rgg"]
    start = derived.index("{\nif (DENSITY == 35)")
    end = derived.index("\n\tLENGTH_EXPERIMENTAL", start)
    # UI values replace this experimental density-to-lamp-height/power table.
    derived = derived[:start] + '{\nLIGHT_POWER = 43.8;\n' + derived[end:]
    selections = [("listOfFiles_light_distribution", "folder_light_distribution", "emission_input", "light_distribution.csv"),
                  ("listOfFiles_spectrum", "folder_light_spectrum", "spectrum_input", "spectrum.csv"),
                  ("listOfFiles_temperatures", "folder_temperatures", "temperature_input", "total_daily_avg_temperature_group_exp2.csv")]
    for variable, folder, key, fallback in selections:
        derived = replace_once(derived, f"{folder}.listFiles()", f'new File[]{{new File({folder}, uiText("{key}", "{fallback}"))}}', variable)
    derived = replace_once(derived, "listOfFiles = folder.listFiles();", 'listOfFiles = new File[]{new File(folder, uiText("plant_input", "base_plant_dynamic_50.csv"))};', "dynamic input") if derived.count("listOfFiles = folder.listFiles();") == 1 else derived.replace("listOfFiles = folder.listFiles();", 'listOfFiles = new File[]{new File(folder, uiText("plant_input", "base_plant_dynamic_50.csv"))};', 1)
    anchor = "read_dynamic_input(readCSV(PATH_INPUT+PATH_DYNAMIC_IN+listOfFiles[0].getName()));"
    derived = replace_once(derived, anchor, anchor+'\n        DENSITY = uiDouble("density", DENSITY);', "density override")
    sources["param/parameters_derived.rgg"] = derived

    init = sources["initiation.rgg"]
    start, end = init.index("\t//Construction of the room"), init.index("\t// start field setup")
    init = "import static autotom_scene.*;\n" + init[:start] + "\t[AutoTomEnvironment]\n\n" + init[end:]
    init = replace_once(init, "time\t\t\t\t=\t0;", "time = 0;\n    TOTAL_PLANTS = 0;", "reset counter")
    sources["initiation.rgg"] = init

    surroundings = sources["surroundings.rgg"]
    for name in ("WALL", "FLOOR", "CEILING"):
        key = name.lower()+"_reflectance"
        for field, transmission in [("SPD", "false"), ("SPT", "true")]:
            old = f"new IrregularSpectralCurve(WAVELENGTHS, {name}_{field})"
            surroundings = replace_once(surroundings, old, f'new IrregularSpectralCurve(WAVELENGTHS, uiOptics("{key}", {name}_{field}, {transmission}))', name+field)
    sources["surroundings.rgg"] = surroundings
    sources["light.rgg"] = replace_once(sources["light.rgg"], "new IrregularSpectralCurve(WAVELENGTHS, AMPLITUDES)", "new IrregularSpectralCurve(WAVELENGTHS, uiSpectrum(WAVELENGTHS, AMPLITUDES))", "LED spectrum")
    sources["light.rgg"] = replace_once(sources["light.rgg"], "static void lightModelSettings () {", "static void lightModelSettings () {\n    lmGPU.setSeed(Math.max(1, SET_SEED));", "light seed")
    # Also used by explicit LEDs, before their construction.
    sources["param/parameters_derived.rgg"] = replace_once(sources["param/parameters_derived.rgg"], anchor, anchor+"\n        AMPLITUDES = uiSpectrum(WAVELENGTHS, AMPLITUDES);", "shared spectrum")

    model = replace_method(sources["Model.rgg"], "protected void run(Object info)", RUN_BODY)
    model = replace_method(model, "protected void runHeadless()", HEADLESS_BODY)
    sources["Model.rgg"] = model + EXPORT_HELPER
    project = sources["project.gs"]
    anchor = '<de.grogra.pf.ui.registry.SourceFile mimeType="text/x-grogra-rgg" name="Model.rgg" systemId="pfs:Model.rgg"/>'
    sources["project.gs"] = replace_once(project, anchor, anchor+'\n     <de.grogra.pf.ui.registry.SourceFile mimeType="text/x-grogra-rgg" name="autotom_scene.rgg" systemId="pfs:autotom_scene.rgg"/>', "project source registration")
    sources["META-INF/MANIFEST.MF"] += "\nName: autotom_scene.rgg\nContent-Type: text/x-grogra-rgg; charset=windows-1252\n\n"
    return {name: content.encode("cp1252") for name, content in sources.items()}


def install(root: Path):
    state = root / ".autotom-adapter.json"
    if state.exists():
        if json.loads(state.read_text())["version"] != ADAPTER_VERSION:
            raise ModelError("Model adapter version mismatch; restore its backup before upgrading")
        for name in PATCHED_FILES:
            if not (root / name).is_file():
                raise ModelError(f"Adapter source is missing: {name}")
        return
    if not (root / "project.gs").exists():
        raise ModelError("Mount the model directory containing project.gs, not the repository root")
    config = default_config(root)
    validate_inputs(root, config)
    try:
        changes = patched_sources(root)
    except (ValueError, FileNotFoundError) as error:
        raise ModelError(f"Model does not match the supported upstream revision {UPSTREAM_COMMIT}: {error}") from error
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = root / ".autotom-backups" / stamp
    for name in PATCHED_FILES:
        target = backup / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, target)
    try:
        for name, content in changes.items():
            atomic_write(root / name, content)
        write_config(root, config)
        atomic_write(state, json.dumps({"version": ADAPTER_VERSION, "upstream": UPSTREAM_COMMIT,
                                       "backup": str(backup.relative_to(root))}, indent=2))
    except Exception:
        for name in PATCHED_FILES:
            shutil.copy2(backup / name, root / name)
        for name in GENERATED_FILES:
            (root / name).unlink(missing_ok=True)
        raise
