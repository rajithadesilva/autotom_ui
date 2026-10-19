"""Isolated GPU checks for v1 migration and editable plant layouts/inputs.

Run with /reference mounted read-only and DATA_DIR set to a disposable check directory.
"""
import json
from pathlib import Path
from .adapter import (PATCHED_FILES, atomic_write, default_config, install, patched_sources_v1,
                      read_config, revision, write_config)
from .layout import generate_layout
from .project import Project
from .schema import Planting
from .smoke import pristine_copy
from .store import Store
from .worker import DATA, execute, gpu_check


def main():
    status=gpu_check()
    if not status['ready']:
        raise SystemExit(status['error'])
    store=Store(DATA)
    model=DATA/'feature-model'
    if model.exists():
        raise SystemExit('Use a fresh DATA_DIR for feature checks')
    pristine_copy(Path('/reference'),model)
    c=default_config(model)
    c.simulation.days=2
    c.simulation.rays=200000
    # Construct a genuine v1 source installation and config, then exercise the upgrader.
    c.simulation.rows=c.simulation.plants_per_row=2
    c.simulation.border_rows=c.simulation.border_plants=1
    old=c.model_dump();old['version']=1
    for key in ['planting','groups','parameter_overrides','temperature_overrides']:
        old.pop(key)
    backup=model/'.autotom-backups/original'
    changes=patched_sources_v1(model)
    for name in PATCHED_FILES:
        atomic_write(backup/name,(model/name).read_bytes())
        atomic_write(model/name,changes[name])
    atomic_write(model/'autotom.json',json.dumps(old))
    atomic_write(model/'autotom.properties','legacy=true\n')
    atomic_write(model/'autotom_scene.rgg','// legacy generated scene\n')
    atomic_write(model/'.autotom-adapter.json',json.dumps({'version':1,'backup':'.autotom-backups/original'}))
    install(model)
    def run(name):
        job=Project(model,store).create_run(revision(model),name)
        execute(store,store.claim(),status)
        result=store.get(job['id'])
        print(json.dumps({key:result[key] for key in ['id','name','status','current_day','error']}),flush=True)
        if result['status']!='completed':
            print((store.runs/job['id']/'console.log').read_text()[-15000:])
            raise SystemExit(1)
        expected={p['reporting_id'] for p in result['config']['planting']['plants'] if p['enabled'] and p['role']=='central'}
        for path in sorted((store.runs/job['id']/'days').glob('*/metrics.json')):
            daily=json.loads(path.read_text())
            assert {p['plant'] for p in daily['plants']}==expected
            assert all(p['biomass_g']>0 and p['leaf_area_m2']>0 for p in daily['plants'])
            assert (path.parent/'plants.obj').stat().st_size>100
        return job
    run('Migrated v1 layout with border clones')
    c=read_config(model)
    c.planting=Planting.model_validate(generate_layout(c.simulation.model_dump(),c.room.model_dump(),{
        'pattern':'staggered','plant_spacing':.22,'row_spacing':.25,'center':[.6,.6,.04],'rotation':15}))
    c.planting.mode='custom'
    for index,p in enumerate(c.planting.plants):
        if p.role=='central':p.reporting_id=(index+1)*3
    c.planting.next_reporting_id=13
    c.planting.plants[0].position=(.5,.5,.08)
    c.planting.plants[0].rotation=(0,0,35)
    border=next(p for p in c.planting.plants if p.role=='border')
    border.position=(.1,.1,.02)
    c.parameter_overrides={'base_temperature':6.2,'ray_depth':8,'rockwool_height':.08,'proportion_petiolules_first_leaves':[.5,.5]}
    c.temperature_overrides={'0':23,'1':24,'90':18}
    write_config(model,c)
    run('Custom staggered layout, moved clone, nonsequential reporting IDs and input overrides')


if __name__=='__main__':
    main()
