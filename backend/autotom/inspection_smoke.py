"""Isolated real-GPU acceptance for plant identity, state, and clone reconstruction."""
import argparse
import json
import math
import tempfile
from pathlib import Path
from .adapter import install, read_config, revision, write_config
from .inspection import STATE_FIELDS, inspection_metadata
from .project import Project
from .schema import Planting
from .smoke import pristine_copy
from .store import Store
from .worker import execute, gpu_check


def vertices(path):
    with path.open() as stream:
        return [[float(parts[1]), float(parts[3]), float(parts[2])]
                for line in stream if (parts := line.split()) and parts[0] == 'v']


def check_clone(root, day, manifest):
    native = root / 'model/output/days' / day
    source = next(i for i in manifest['instances'] if i['id'] == 'central-a')['matrix']
    border = next(i for i in manifest['instances'] if i['id'] == 'border-a')
    assert border['source_id'] == 'central-a' and border['state'] is None
    target = border['matrix']
    buckets = {}
    for point in vertices(native / 'plants.obj'):
        buckets.setdefault(tuple(round(n, 3) for n in point), []).append(point)
    maximum = 0
    for point in vertices(native / 'plant-3.obj')[::30]:
        local = [sum(source[r*4+c]*(point[r]-source[r*4+3]) for r in range(3)) for c in range(3)]
        world = [sum(target[r*4+c]*local[c] for c in range(3))+target[r*4+3] for r in range(3)]
        key = tuple(round(n, 3) for n in world)
        candidates = []
        for x in (-.001, 0, .001):
            for y in (-.001, 0, .001):
                for z in (-.001, 0, .001):
                    candidates.extend(buckets.get(tuple(round(n+d, 3) for n, d in zip(key, (x,y,z))), []))
        assert candidates, 'Reconstructed border vertex is absent from GroIMP output'
        maximum = max(maximum, min(math.dist(world, v) for v in candidates))
    assert maximum < .00003, f'Clone geometry mismatch: {maximum} metres'
    return maximum


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', default='/reference')
    parser.add_argument('--output', default='/tmp')
    args = parser.parse_args()
    state = gpu_check()
    if not state['ready']:
        raise SystemExit(state['error'])
    work = Path(tempfile.mkdtemp(prefix='autotom-inspection-', dir=args.output))
    model = work / 'model'
    pristine_copy(Path(args.reference), model)
    install(model)
    config = read_config(model)
    config.simulation.days, config.simulation.rays = 2, 200000
    def plant(identifier, name, role, report, position, angle, col):
        return dict(id=identifier, name=name, role=role, reporting_id=report, position=position,
                    rotation=[0,0,angle], enabled=True, row=1, col=col)
    config.planting = Planting(mode='custom', next_reporting_id=10, plants=[
        plant('central-a','Central A','central',3,[.5,.5,.1],35,1),
        plant('central-b','Central B','central',9,[.52,.51,.1],-25,2),
        plant('border-a','Border A','border',None,[.8,.7,.15],80,0)])
    write_config(model, config)
    store = Store(work / 'data')
    run = Project(model, store).create_run(revision(model), 'Inspection acceptance')
    execute(store, store.claim(), state)
    final = store.get(run['id'])
    root = store.runs / run['id']
    if final['status'] != 'completed':
        print((root/'console.log').read_text()[-18000:])
        raise SystemExit(final['error'])
    errors = []
    for day in ('0001', '0002'):
        manifest = json.loads((root/'days'/day/'inspection.json').read_text())
        metrics = json.loads((root/'days'/day/'metrics.json').read_text())
        assert {i['id'] for i in manifest['instances']} == {'central-a','central-b','border-a'}
        for metric in metrics['plants']:
            item = next(i for i in manifest['instances'] if i['geometry'] == f"plant_{metric['plant']}" and i['state'])
            assert set(item['state']) == {f['key'] for f in STATE_FIELDS}
            assert math.isclose(item['state']['dry_biomass_plant_with_roots_mg']/1000, metric['biomass_g'])
        errors.append(check_clone(root, day, manifest))
    (root/'inspection-metadata.json').write_text(json.dumps(inspection_metadata(root, run['config'])))
    print(json.dumps({'status': final['status'], 'days':2, 'state_fields':len(STATE_FIELDS),
                      'maximum_clone_error_m':max(errors), 'INSPECTION_RUN_DIR':str(root)}, indent=2))


if __name__ == '__main__':
    main()
