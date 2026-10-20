import csv
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import ValidationError
from autotom import adapter
from autotom.adapter import default_config, read_config, revision, write_config, install, patched_sources_v1, ModelError
from autotom.layout import generate_layout
from autotom.parameters import CATALOGUE, preview
from autotom.project import Project
from autotom.schema import Configuration, Planting, EditorGroup
from autotom.store import Store


def legacy_install(root):
    config = default_config(root).model_dump()
    config['version'] = 1
    for key in ['planting','groups','parameter_overrides','temperature_overrides']:
        config.pop(key)
    backup = root / '.autotom-backups/original'
    changes = patched_sources_v1(root)
    for name, content in changes.items():
        adapter.atomic_write(backup / name, (root / name).read_bytes())
        adapter.atomic_write(root / name, content)
    (root / 'autotom.json').write_text(json.dumps(config))
    (root / 'autotom.properties').write_text('legacy=true\n')
    (root / 'autotom_scene.rgg').write_text('// legacy generated\n')
    (root / '.autotom-adapter.json').write_text(json.dumps({'version':1,'backup':'.autotom-backups/original'}))
    return backup


def test_v1_migration_exact_positions_and_border_order(model):
    c = default_config(model)
    assert c.version == 2
    assert len(c.planting.plants) == 49
    plants = c.planting.plants
    assert sum(p.role == 'central' for p in plants) == 9
    spacing = 50 ** -.5
    assert plants[0].position == pytest.approx([.6-spacing,.6-spacing,0])
    assert plants[9].position == pytest.approx([.6-spacing,.6-3*spacing,0])
    assert plants[15].position == pytest.approx([.6-spacing,.6+2*spacing,0])
    assert [p.reporting_id for p in plants[:9]] == list(range(1,10))
    assert all(p.reporting_id is None for p in plants[9:])


def test_staggered_resolver_rotates_about_center(model):
    c=default_config(model)
    sim={**c.simulation.model_dump(),'rows':2,'plants_per_row':2,'border_rows':0,'border_plants':0}
    layout=generate_layout(sim,c.room.model_dump(),dict(pattern='staggered',plant_spacing=.2,row_spacing=.4,center=[1,2,.3],rotation=90))
    assert layout['plants'][0]['position'] == pytest.approx([1.2,1.9,.3])
    assert layout['plants'][2]['position'] == pytest.approx([.8,2,.3])
    assert all(p['rotation']==[0,0,90] for p in layout['plants'])


def test_effective_inputs_keep_originals_and_apply_raw_values(model):
    install(model)
    c=read_config(model)
    path=model/'input/dynamic_input'/c.simulation.plant_input
    original=path.read_bytes()
    temperatures=model/'input/temperature'/c.simulation.temperature_input
    original_temperatures=temperatures.read_bytes()
    c.parameter_overrides={'base_temperature':7.2,'proportion_petiolules_first_leaves':[.5,.5], 'ray_depth':12,'rockwool_height':.08,'remove_ripe_fruit':True}
    c.temperature_overrides={'0':23,'90':18}
    write_config(model,c)
    rows=list(csv.reader((model/adapter.GENERATED_FILES[3]).open()))
    spec=next(s for s in CATALOGUE if s['key']=='base_temperature')
    assert float(rows[spec['row']+1][1])==7.2
    assert path.read_bytes()==original and temperatures.read_bytes()==original_temperatures
    assert 'ray_depth=12' in (model/'autotom.properties').read_text()
    assert list(csv.reader((model/adapter.GENERATED_FILES[4]).open()))[1]==['0','23']
    assert read_config(model).temperature_overrides['90']==18
    assert preview(model,c.simulation.plant_input,c.simulation.temperature_input)['parameters'][2]['value'] != 7.2


def test_temperature_overrides_can_extend_short_input(model):
    c=default_config(model)
    c.simulation.days=3
    path=model/'input/temperature'/c.simulation.temperature_input
    path.write_text('DAT,temperature\n0,20\n')
    c.temperature_overrides={'1':21,'2':22,'90':18}
    write_config(model,c)
    assert len(list(csv.reader((model/adapter.GENERATED_FILES[4]).open())))==4
    c.temperature_overrides.pop('1')
    with pytest.raises(ModelError,match='required'):
        write_config(model,c)


@pytest.mark.parametrize('overrides',[
    {'unknown':1}, {'root_fraction':1}, {'ray_depth':1.5}, {'ray_depth':True},
    {'base_temperature':float('inf')}, {'proportion_petiolules_first_leaves':[.1,.2]},
    {'proportion_petiolules_first_leaves':[1]}, {'remove_ripe_fruit':1},
])
def test_parameter_types_and_bounds(model,overrides):
    c=default_config(model).model_dump(); c['parameter_overrides']=overrides
    with pytest.raises(ValidationError): Configuration.model_validate(c)


@pytest.mark.parametrize('mutate',[
    lambda c:c['planting']['plants'][0].update(rotation=[10,0,0]),
    lambda c:c['planting']['plants'][0].update(position=[101,0,0]),
    lambda c:c['planting']['plants'][1].update(reporting_id=1),
    lambda c:c.update(groups=[{'id':'g','name':'group','members':['missing','led-0-0']}]),
    lambda c:c.update(groups=[{'id':'g','name':'group','members':['plant-1','plant-1']}]),
    lambda c:c.update(temperature_overrides={'01':20}),
    lambda c:c.update(temperature_overrides={'365':20}),
    lambda c:[p.update(enabled=False) for p in c['planting']['plants']],
])
def test_explicit_scene_validation(model,mutate):
    c=default_config(model).model_dump();mutate(c)
    with pytest.raises(ValidationError):Configuration.model_validate(c)


def test_upgrade_preserves_config_original_backup_and_unrelated_source(model):
    original=legacy_install(model)
    saved=json.loads((model/'autotom.json').read_text());saved['objects'][0]['power_w']=12
    (model/'autotom.json').write_text(json.dumps(saved))
    unrelated=model/'photosynthesis.rgg';unrelated.write_bytes(unrelated.read_bytes()+b'\n// custom\n')
    install(model)
    c=read_config(model)
    assert c.version==2 and c.objects[0].power_w==12
    state=json.loads((model/'.autotom-adapter.json').read_text())
    assert state['version']==adapter.ADAPTER_VERSION and state['backup']==str(original.relative_to(model))
    assert (model/state['previous_backup']/'autotom.json').exists()
    assert unrelated.read_bytes().endswith(b'// custom\n')
    before=revision(model);install(model);assert revision(model)==before


def test_upgrade_refuses_modified_managed_sources(model):
    legacy_install(model)
    source=model/'initiation.rgg';source.write_bytes(source.read_bytes()+b'\n// modification\n')
    before=revision(model)
    with pytest.raises(ModelError,match='modified adapter source'):install(model)
    assert revision(model)==before


def test_failed_upgrade_restores_every_generated_file_and_state(model):
    legacy_install(model)
    before={str(p.relative_to(model)):p.read_bytes() for p in model.rglob('*') if p.is_file() and '.autotom-backups' not in p.parts}
    real=adapter.atomic_write
    def fail(path,content):
        if str(path)==str(model/'autotom.json') and '\"version\": 2' in str(content):raise OSError('injected save failure')
        real(path,content)
    with patch.object(adapter,'atomic_write',side_effect=fail),pytest.raises(OSError):install(model)
    after={str(p.relative_to(model)):p.read_bytes() for p in model.rglob('*') if p.is_file() and '.autotom-backups' not in p.parts}
    assert before==after


def test_save_rollback_and_snapshot_include_effective_inputs(installed,tmp_path):
    project=Project(installed,Store(tmp_path/'data'));c=read_config(installed)
    original={name:(installed/name).read_bytes() for name in adapter.GENERATED_FILES}
    real=adapter.atomic_write
    def fail(path,content):
        if path==installed/'autotom.properties' and 'ray_depth=12' in str(content):raise OSError('failure')
        real(path,content)
    c.parameter_overrides={'ray_depth':12}
    with patch.object(adapter,'atomic_write',side_effect=fail),pytest.raises(OSError):project.save(revision(installed),c)
    assert original=={name:(installed/name).read_bytes() for name in adapter.GENERATED_FILES}
    c.groups=[EditorGroup(id='group',name='Mixed group',members=['led-0-0','plant-1'])]
    c=Configuration.model_validate(c.model_dump())
    project.save(revision(installed),c)
    run=project.create_run(revision(installed),'snapshot')
    directory=project.store.runs/run['id']
    assert (directory/'model'/adapter.GENERATED_FILES[3]).exists()
    assert json.loads((directory/'config.json').read_text())['groups'][0]['members']==['led-0-0','plant-1']


def test_v1_migration_avoids_user_object_id_collisions(model):
    data=default_config(model).model_dump();data['version']=1;data.pop('planting')
    data['objects'][0]['id']='plant-1'
    migrated=Configuration.model_validate(data)
    assert migrated.objects[0].id=='plant-1'
    assert migrated.planting.plants[0].id!='plant-1'
    assert migrated.planting.plants[0].reporting_id==1
