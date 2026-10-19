import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import { applyPoses, duplicate, sceneError, tidy, transformPoses } from '../src/editor';
import type { Config, SceneObject } from '../src/types';

function fixture():Config {
  return {version:2,room:{width:1.2,length:1.2,height:.735,enabled:true,wall_reflectance:null,floor_reflectance:null,ceiling_reflectance:null},
    simulation:{days:2,rows:1,plants_per_row:1,density:50,border_rows:0,border_plants:0,seed:0,rays:200000,photoperiod:16,plant_input:'p.csv',temperature_input:'t.csv',emission_input:'e.csv',spectrum_input:'s.csv'},
    spectrum:[{wavelength:400,amplitude:1},{wavelength:700,amplitude:1}],parameter_overrides:{},temperature_overrides:{},
    objects:[{id:'lamp',name:'Lamp',kind:'led',position:[1,0,1],rotation:[180,0,0],size:[.1,.1,.1],power_w:10,reflectance:.5,enabled:true}],
    planting:{mode:'custom',pattern:'grid',plant_spacing:null,row_spacing:null,center:[0,0,0],rotation:0,next_reporting_id:8,
      plants:[{id:'p',name:'Plant',role:'central',reporting_id:7,position:[0,1,0],rotation:[0,0,0],row:1,col:1,enabled:true}]},
    groups:[{id:'g',name:'Mixed',members:['lamp','p']}]};
}

test('rigid transforms preserve offsets, lamp emission and upright plant yaw',()=>{
  const c=fixture();const items=[...c.objects,...c.planting.plants];
  const delta=new THREE.Matrix4().makeTranslation(.2,-.3,.4).multiply(new THREE.Matrix4().makeRotationZ(Math.PI/2));
  const poses=transformPoses(items,new THREE.Vector3(0,0,0),delta);
  expect(poses[0].position[0]).toBeCloseTo(.2);expect(poses[0].position[1]).toBeCloseTo(.7);expect(poses[0].position[2]).toBeCloseTo(1.4);
  expect(poses[1].position[0]).toBeCloseTo(-.8);expect(poses[1].position[1]).toBeCloseTo(-.3);expect(poses[1].rotation[2]).toBeCloseTo(90);
  const distance=new THREE.Vector3(...poses[0].position).distanceTo(new THREE.Vector3(...poses[1].position));
  expect(distance).toBeCloseTo(Math.sqrt(3));
  const rotation=new THREE.Euler(...poses[0].rotation.map(THREE.MathUtils.degToRad) as [number,number,number],'XYZ');
  const direction=new THREE.Vector3(0,0,1).applyEuler(rotation);expect(direction.z).toBeCloseTo(-1);
  const next=applyPoses(c,poses);expect(sceneError(next)).toBeNull();expect(c.objects[0].position).toEqual([1,0,1]);
});

test('full 3D environment rotation composes orientations around a shared pivot',()=>{
  const c=fixture();const second:SceneObject={...c.objects[0],id:'box',kind:'box',position:[0,2,1],rotation:[15,25,35]};
  const pivot=new THREE.Vector3(.5,1,1);
  const rotation=new THREE.Matrix4().makeRotationX(Math.PI/3);
  const result=transformPoses([c.objects[0],second],pivot,rotation);
  for (const [index,item] of [c.objects[0],second].entries()) {
    const expected=new THREE.Vector3(...item.position).sub(pivot).applyMatrix4(rotation).add(pivot);
    expect(new THREE.Vector3(...result[index].position).distanceTo(expected)).toBeLessThan(1e-10);
  }
});

test('duplication allocates stable reports and groups; cleanup drops orphaned groups',()=>{
  const c=fixture();const result=duplicate(c,['lamp','p']);
  expect(result.config.groups).toHaveLength(2);expect(result.config.groups[1].members).toEqual(result.selected);
  expect(result.config.planting.plants.map(p=>p.reporting_id)).toEqual([7,8]);expect(result.config.planting.next_reporting_id).toBe(9);
  const invalid=applyPoses(c,[{id:'lamp',position:[101,0,0],rotation:[0,0,0]}]);expect(sceneError(invalid)).toContain('±100');expect(c.objects[0].position[0]).toBe(1);
  const removed=tidy({...result.config,objects:result.config.objects.filter(o=>o.id==='lamp')});
  expect(removed.groups).toHaveLength(1);expect(removed.groups[0].id).toBe('g');
});
