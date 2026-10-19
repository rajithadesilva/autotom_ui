"""Allowlisted inputs to the upstream dynamic reader, expressed before its equations."""
import csv
import io
import json
import math
from pathlib import Path

CATALOGUE = json.loads(Path(__file__).with_name('parameters.json').read_text())
BY_KEY = {item['key']: item for item in CATALOGUE}


def validate_overrides(values):
    if not isinstance(values, dict):
        raise ValueError('Parameter overrides must be an object')
    for key, value in values.items():
        if key not in BY_KEY:
            raise ValueError(f'Unknown model parameter: {key}')
        spec = BY_KEY[key]
        if spec['type'] == 'boolean':
            if type(value) is not bool:
                raise ValueError(f'{key} must be boolean')
            continue
        numbers = value if isinstance(value, list) else [value]
        if spec['type'] == 'array':
            if not isinstance(value, list) or len(value) != spec['length']:
                raise ValueError(f'{key} requires {spec["length"]} values')
        elif isinstance(value, list):
            raise ValueError(f'{key} must be a scalar')
        for n in numbers:
            if type(n) not in (int, float) or not math.isfinite(n):
                raise ValueError(f'{key} must contain finite numbers')
            if n < spec['min'] or n > spec['max'] or (spec['type'] == 'integer' and int(n) != n):
                raise ValueError(f'{key} must be {spec["type"]} within {spec["min"]}–{spec["max"]}')
        if spec['type'] == 'array' and abs(sum(numbers) - 1) > 1e-5:
            raise ValueError(f'{key} proportions must sum to 1')
        if key == 'root_fraction' and value >= 1:
            raise ValueError('Root fraction must be less than 1')


def input_rows(root, folder, filename):
    if filename.startswith('autotom_effective_') or not filename.endswith('.csv') or '/' in filename or '\\' in filename or filename.startswith('.'):
        raise ValueError('Inputs must be CSV filenames within the model input folders')
    path = root / 'input' / folder / filename
    if not path.is_file() or path.is_symlink():
        raise ValueError(f'Missing model input: input/{folder}/{filename}')
    with path.open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.reader(stream))


def preview(root, plant_input, temperature_input):
    rows = input_rows(root, 'dynamic_input', plant_input)
    definitions = []
    for spec in CATALOGUE:
        if 'row' in spec:
            try:
                raw = rows[spec['row'] + 1][1]
                value = [float(n) for n in raw.split(';')] if spec['type'] == 'array' else float(raw)
            except (ValueError, IndexError) as error:
                raise ValueError(f'Invalid input row for {spec["label"]}') from error
        else:
            value = spec['default']
        numbers = value if isinstance(value, list) else [value]
        if any(not math.isfinite(n) for n in numbers):
            raise ValueError(f'Non-finite source value for {spec["label"]}')
        definitions.append({**spec, 'value': value})
    temperatures = []
    for day, row in enumerate(input_rows(root, 'temperature', temperature_input)[1:]):
        try:
            if int(row[0]) != day or not math.isfinite(float(row[1])):
                raise ValueError()
            temperatures.append(float(row[1]))
        except (ValueError, IndexError) as error:
            raise ValueError('Temperature rows must contain consecutive days starting at 0 and finite temperatures') from error
    return {'parameters': definitions, 'temperatures': temperatures}


def effective_inputs(root, config):
    sim = config.simulation
    data = preview(root, sim.plant_input, sim.temperature_input)
    effective = {spec['key']: config.parameter_overrides.get(spec['key'], spec['value']) for spec in data['parameters']}
    validate_overrides(effective)
    # These are the upstream beta-growth domain and biomass partitions.
    for age, duration in [('age_maximum_growth_internode_dd_mean','growth_duration_internode_dd_mean'),
                          ('age_maximum_growth_mid_and_last_leaves_dd','growth_duration_mid_and_last_leaves_dd'),
                          ('age_maximum_growth_truss_dd','growth_duration_truss_dd'),
                          ('age_maximum_growth_fruit_dd_mean','growth_duration_fruit_dd_mean')]:
        if ({age, duration} & config.parameter_overrides.keys()) and not 0 <= effective[age] < effective[duration]:
            raise ValueError(f'{age} must be nonnegative and less than {duration}')
    for prefix, keys in [
        ('cotyledons', ['fraction_petiole_cotyledons','fraction_blades_cotyledons']),
        ('first leaves', ['fraction_petiole_first_leaves','fraction_petiolule_first_leaves','fraction_blades_first_leaves']),
        ('upper leaves', ['fraction_petiole_mid_and_last_leaves','fraction_segment_mid_and_last_leaves','fraction_petiolule_mid_and_last_leaves','fraction_blades_mid_and_last_leaves'])]:
        if abs(sum(effective[key] for key in keys) - 1) > 1e-5:
            raise ValueError(f'Biomass fractions for {prefix} must sum to 1')
    rows = input_rows(root, 'dynamic_input', sim.plant_input)
    rows[1][1] = str(sim.density)
    for spec in CATALOGUE:
        if 'row' in spec and spec['key'] in config.parameter_overrides:
            value = config.parameter_overrides[spec['key']]
            rows[spec['row'] + 1][1] = ';'.join(map(str, value)) if isinstance(value, list) else str(int(value)) if spec['type'] == 'integer' else str(value)
    temps = data['temperatures'][:]
    for key, value in config.temperature_overrides.items():
        day = int(key)
        while len(temps) <= day:
            temps.append(None)
        temps[day] = value
    if len(temps) < sim.days or any(n is None for n in temps[:sim.days]):
        raise ValueError(f'Temperature input has {len(data["temperatures"])} days; {sim.days} are required')
    def serialize(table):
        out = io.StringIO(newline='')
        csv.writer(out, lineterminator='\n').writerows(table)
        return out.getvalue()
    # Retain distant overrides in JSON; generate only the contiguous usable temperature prefix.
    end = next((i for i, value in enumerate(temps) if value is None), len(temps))
    return serialize(rows), serialize([['DAT','temperature']] + [[i,n] for i,n in enumerate(temps[:end])])
