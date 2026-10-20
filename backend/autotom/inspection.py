"""Versioned, identity-preserving plant inspection exports and snapshot inputs."""
import csv
import json
import math
from pathlib import Path
from .parameters import preview

STATE_FIELDS = json.loads(Path(__file__).with_name('plant_state.json').read_text())


def export_helper():
    keys = ','.join(field['key'] for field in STATE_FIELDS)
    values = '+","+'.join('pb[' + field['key'] + ']' for field in STATE_FIELDS)
    return '''
static void autoTomInspectDay(String dir) {
    PrintWriter state = new PrintWriter(new FileWriter(dir+"plant_state.csv", false));
    state.println("''' + keys + '''");
    [pb:PlantBase ::> {
        state.println(""+''' + values + ''');
    }]
    state.close();
    PrintWriter instances = new PrintWriter(new FileWriter(dir+"instances.csv", false));
    instances.println("index,border,source,m00,m01,m02,m03,m10,m11,m12,m13,m20,m21,m22,m23");
    [root:AutoTomInstance ::> {
        de.grogra.vecmath.Matrix34d pose = transformation(root);
        int source = root[border] ? UI_BORDER_SOURCE[root[index]] : UI_IDS[root[index]];
        if (!root[border]) { export3DScene(dir+"plant-"+source+".obj", "obj", root); }
        instances.println(root[index]+","+root[border]+","+source+","+
            pose.m00+","+pose.m01+","+pose.m02+","+pose.m03+","+
            pose.m10+","+pose.m11+","+pose.m12+","+pose.m13+","+
            pose.m20+","+pose.m21+","+pose.m22+","+pose.m23);
    }]
    instances.close();
}
'''


def snapshot_inputs(root, config):
    """Only read this snapshot, including on legacy runs with missing sources."""
    sim = config['simulation']
    try:
        data = preview(root, sim['plant_input'], sim['temperature_input'])
    except (ValueError, OSError):
        return {'parameters': [], 'temperatures': [], 'inputs_available': False}
    for spec in data['parameters']:
        spec['value'] = config.get('parameter_overrides', {}).get(spec['key'], spec['value'])
        if spec['key'] == 'density':
            spec['value'] = sim['density']
    temperatures = data['temperatures']
    for key, value in config.get('temperature_overrides', {}).items():
        index = int(key)
        if index < sim['days']:
            temperatures.extend([None] * max(0, index + 1 - len(temperatures)))
            temperatures[index] = value
    return {**data, 'temperatures': temperatures[:sim['days']], 'inputs_available': True}


def inspection_metadata(root, config):
    days = sorted(int(p.parent.name) for p in (root / 'days').glob('[0-9][0-9][0-9][0-9]/inspection.json'))
    frozen = root / 'inspection-inputs.json'
    inputs = json.loads(frozen.read_text()) if frozen.exists() else {
        'version': 1, 'fields': STATE_FIELDS, **snapshot_inputs(root / 'model', config)}
    return {**inputs, 'available_days': days}


def publish_inspection(source, stage, config, day):
    """Validate all identities and state before the worker atomically publishes a day."""
    central = [p for p in config['planting']['plants'] if p['enabled'] and p['role'] == 'central']
    borders = [p for p in config['planting']['plants'] if p['enabled'] and p['role'] == 'border']
    reports = {p['reporting_id']: p for p in central}
    with (source / 'plant_state.csv').open() as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != [field['key'] for field in STATE_FIELDS]:
            raise ValueError('Incomplete inspection plant state fields')
        states = {}
        for row in reader:
            state = {}
            for field in STATE_FIELDS:
                value = row[field['key']]
                if field['type'] == 'boolean':
                    if value not in ('true', 'false'):
                        raise ValueError('Invalid inspection boolean')
                    value = value == 'true'
                elif field['type'] == 'integer':
                    value = int(value)
                else:
                    value = float(value)
                    value = value if math.isfinite(value) else None
                state[field['key']] = value
            report = state['plant_number']
            if report in states:
                raise ValueError('Duplicate inspection plant state')
            states[report] = state
    if states.keys() != reports.keys():
        raise ValueError('Inspection plant state does not match run')
    instances, seen = [], set()
    with (source / 'instances.csv').open() as stream:
        for row in csv.DictReader(stream):
            if row['border'] not in ('true', 'false'):
                raise ValueError('Invalid inspection instance role')
            border = row['border'] == 'true'
            index, report = int(row['index']), int(row['source'])
            candidates = borders if border else central
            if index < 0 or index >= len(candidates) or report not in reports:
                raise ValueError('Unknown inspection instance or clone source')
            plant = candidates[index]
            if plant['id'] in seen or (not border and plant['reporting_id'] != report):
                raise ValueError('Duplicate or mismatched inspection identity')
            seen.add(plant['id'])
            matrix = [float(row[f'm{r}{c}']) for r in range(3) for c in range(4)] + [0, 0, 0, 1]
            if not all(math.isfinite(n) for n in matrix):
                raise ValueError('Invalid inspection transform')
            # Exported plant poses must be rigid and invertible for clone reuse.
            for r in range(3):
                for c in range(3):
                    dot = sum(matrix[r*4+k]*matrix[c*4+k] for k in range(3))
                    if abs(dot - (1 if r == c else 0)) > 1e-5:
                        raise ValueError('Non-rigid inspection transform')
            instances.append({'id': plant['id'], 'geometry': f'plant_{report}', 'source_id': reports[report]['id'],
                              'matrix': matrix, 'state': None if border else states[report]})
    if seen != {p['id'] for p in central + borders}:
        raise ValueError('Incomplete inspection instance identities')
    from .geometry import combine_plants
    combine_plants(source, stage / 'plants.obj', [p['reporting_id'] for p in central])
    for path in stage.glob('plant-*.obj'):
        path.unlink()
    (stage / 'inspection.json').write_text(json.dumps({'version': 1, 'day': day, 'instances': instances}, allow_nan=False))
