import csv
import json
import re
import shutil
from pathlib import Path
import pytest
from autotom import adapter
from autotom.inspection import STATE_FIELDS, inspection_metadata
from autotom.project import Project
from autotom.schema import Planting
from autotom.store import Store
from autotom.worker import publish_days


def exported_run(model, tmp_path):
    config = adapter.default_config(model)
    plant = config.planting.plants[0].model_copy(update={'id':'central', 'reporting_id':7, 'position':(1,2,3), 'rotation':(0,0,90)})
    border = plant.model_copy(update={'id':'border', 'reporting_id':None, 'role':'border', 'position':(2,2,3)})
    config.planting = Planting(mode='custom', plants=[plant,border], next_reporting_id=8)
    store = Store(tmp_path / 'data')
    run = store.create('inspection', 'Inspection', 'r', config)
    root = store.runs / run['id']
    root.mkdir(parents=True)
    (root/'provenance.json').write_text(json.dumps({'adapter_version':3}))
    source = root/'model/output/days/0001'
    source.mkdir(parents=True)
    (source/'metrics.csv').write_text('plant,model_age_days,biomass_g,fruit_g,leaf_area_m2,par_umol_s,par_mmol_day,carbon_mmol_day\n7,1,1,0,0.01,10,576,0.3\n')
    obj = 'v 1 3 2 0.2 0.6 0.1\nv 2 3 2 0.2 0.6 0.1\nv 1 4 2 0.2 0.6 0.1\nf 1 2 3\n'
    for name in ('scene.obj','plants.obj','plant-7.obj'):
        (source/name).write_text(obj)
    with (source/'plant_state.csv').open('w') as stream:
        writer = csv.writer(stream)
        writer.writerow([f['key'] for f in STATE_FIELDS])
        writer.writerow([7 if f['key']=='plant_number' else 'false' if f['type']=='boolean' else 1 if f['type']=='integer' else 'NaN' if f['key']=='root_shoot' else 2.5 for f in STATE_FIELDS])
    with (source/'instances.csv').open('w') as stream:
        writer=csv.writer(stream)
        writer.writerow(['index','border','source']+[f'm{r}{c}' for r in range(3) for c in range(4)])
        for p, is_border in ((plant,False),(border,True)):
            writer.writerow([0,str(is_border).lower(),7]+adapter.matrix(p.position,p.rotation)[:12])
    (source/'ready').touch()
    return store,run,source,root/'days/0001'


def test_inspection_publishes_identified_geometry_complete_state_and_clone_source(model,tmp_path):
    store,run,source,target = exported_run(model,tmp_path)
    publish_days(store,run)
    day=json.loads((target/'inspection.json').read_text())
    assert day['version']==1 and day['day']==1
    central,border=day['instances']
    assert central['id']=='central' and border['source_id']=='central'
    assert central['geometry']==border['geometry']=='plant_7'
    assert len(central['state'])==len(STATE_FIELDS)
    assert central['state']['root_shoot'] is None
    assert central['state']['flowering'] is False
    assert border['state'] is None
    mesh=(target/'plants.obj').read_text()
    assert 'o plant_7\n' in mesh and 'v 1 2 3\n' in mesh
    assert 'f 3 2 1\n' in mesh
    assert not list(target.glob('plant-*.obj'))
    assert inspection_metadata(target.parent.parent,run['config'])['available_days']==[1]


@pytest.mark.parametrize('broken',['identity','source','state','mesh','missing'])
def test_incomplete_or_corrupt_inspection_never_advertises_a_day(model,tmp_path,broken):
    store,run,source,target = exported_run(model,tmp_path)
    if broken in ('identity','source'):
        path=source/'instances.csv'
        rows=list(csv.reader(path.open()))
        rows[-1][0 if broken=='identity' else 2]='99'
        with path.open('w') as stream:csv.writer(stream).writerows(rows)
    elif broken=='state':
        (source/'plant_state.csv').write_text('plant_number\n7\n')
    elif broken=='mesh':
        (source/'plant-7.obj').unlink()
    else:
        (source/'instances.csv').unlink()
    with pytest.raises((ValueError,FileNotFoundError)):
        publish_days(store,run)
    assert not target.exists()
    assert store.get(run['id'])['current_day']==0
    assert inspection_metadata(target.parent.parent,run['config'])['available_days']==[]


def test_plant_state_catalogue_covers_every_declared_primitive(model):
    declared=re.findall(r'^\s*(?:double|float|int|boolean)\s+(\w+)\s*;', (model/'plant_level.rgg').read_text(encoding='cp1252').split('// initiation of the plant')[0],re.M)
    assert set(declared)=={f['key'] for f in STATE_FIELDS}


def test_verified_v2_upgrade_preserves_snapshot_inputs_and_rejects_edits(model,tmp_path):
    backup=model/'.autotom-backups/original'
    for name,content in adapter.patched_sources_v2(model).items():
        adapter.atomic_write(backup/name,(model/name).read_bytes())
        adapter.atomic_write(model/name,content)
    config=adapter.default_config(model)
    config.parameter_overrides={'base_temperature':6.5}
    config.temperature_overrides={'0':23}
    adapter.write_config(model,config)
    (model/'.autotom-adapter.json').write_text(json.dumps({'version':2,'backup':str(backup.relative_to(model))}))
    assert adapter.adapter_status(model)['upgrade_available']
    before=(model/'Model.rgg').read_bytes()
    (model/'Model.rgg').write_bytes(before+b'\n// edit\n')
    with pytest.raises(adapter.ModelError,match='modified adapter source'):adapter.install(model)
    (model/'Model.rgg').write_bytes(before)
    adapter.install(model)
    project=Project(model,Store(tmp_path/'runs'))
    run=project.create_run(adapter.revision(model),'Snapshot')
    root=project.store.runs/run['id']
    metadata=inspection_metadata(root,run['config'])
    assert metadata['temperatures'][0]==23
    assert next(p for p in metadata['parameters'] if p['key']=='base_temperature')['value']==6.5
    config.parameter_overrides={'base_temperature':10}
    adapter.write_config(model,config)
    assert inspection_metadata(root,run['config'])==metadata
    assert json.loads((root/'provenance.json').read_text())['adapter_version']==3
    shutil.rmtree(root/'model/input')
    assert inspection_metadata(root,run['config'])==metadata
    (root/'inspection-inputs.json').unlink()
    legacy=inspection_metadata(root,run['config'])
    assert not legacy['inputs_available'] and legacy['parameters']==[]
