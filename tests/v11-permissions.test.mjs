import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID as uid} from 'node:crypto';
import {databaseV11,mockEnvironment,restBridge} from './v11-helpers.mjs';import api from '../netlify/functions/api.mjs';import recognize from '../netlify/functions/menu-recognize.mjs';import photos from '../netlify/functions/menu-photo.mjs';import {localDate} from '../shared/viejo-engine.js';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=';
test('V1.1 menu_editor: permiso y revocación en API, visión, upload, RPC y RLS; originales preservados',async()=>{
 const c=await databaseV11(),restore=mockEnvironment(),saved=globalThis.fetch;let actor=c.employee;
 try{
  const bridge=restBridge(c,{actor:()=>actor});globalThis.fetch=bridge.fetch;
  const menu={id:uid(),day:localDate(),status:'published',reviewed:true,image:png,items:[{id:'p',name:'Plato ficticio',category_id:'guarniciones',available:true}]};
  const req=data=>new Request('https://crm.test/api',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({action:'menu',data})});
  assert.equal((await api(req(menu))).status,403);
  await assert.rejects(()=>c.staff('menu',menu,c.employee),/menu_permission_required/);
  for(const endpoint of [recognize,photos])assert.equal((await endpoint(new Request('https://crm.test/function',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({image:png})}))).status,403);
  // Admin grants only menu_editor, not an administrator role.
  await c.staff('member',{id:c.employee,display_name:'Encargado',role:'member',menu_editor:true});actor=c.employee;
  assert.equal((await api(req(menu))).status,200);
  for(const action of ['settings','member'])await assert.rejects(()=>c.staff(action,{config:{}},actor),/admin_required/);
  await assert.rejects(()=>c.staff('catalog',{id:'x'},actor),/invalid_action/);
  const mutation={...menu,id:uid(),source_menu_id:menu.id,image:'',items:[{...menu.items[0],available:false}]};await c.staff('menu',mutation,actor);
  assert.equal((await c.one('select image from viejo_menus where id=$1',[mutation.id])).image,png);
  assert.equal((await c.one('select count(*)::int n from viejo_menus')).n,2);
  await c.staff('member',{id:actor,display_name:'Empleado',role:'member',menu_editor:false});
  assert.equal((await api(req({...menu,id:uid()}))).status,403);
  await assert.rejects(()=>c.staff('menu',{...menu,id:uid()},actor),/menu_permission_required/);
  await c.db.exec('set role authenticated');await assert.rejects(()=>c.db.query('update crm_members set menu_editor=true where user_id=$1',[actor]),/permission denied/);
  await assert.rejects(()=>c.db.query('insert into viejo_menu_photos(hash,path,content_type,byte_size) values($1,$2,$3,$4)',['a'.repeat(64),'a.png','image/png',10]),/permission denied/);
  await assert.rejects(()=>c.rpc('viejo_staff',[actor,'menu',menu]),/permission denied/);
  assert.equal((await c.one('select count(*)::int n from viejo_menus')).n,0);await c.db.exec('reset role');
 }finally{globalThis.fetch=saved;restore();await c.db.close();}
});
