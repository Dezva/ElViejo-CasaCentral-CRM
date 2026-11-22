import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID as uid} from 'node:crypto';import {createAlertTracker} from '../shared/order-alerts.js';import {databaseV11,mockEnvironment,restBridge} from './v11-helpers.mjs';import {localDate} from '../shared/viejo-engine.js';
import api from '../netlify/functions/api.mjs';
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)};};const order=(id,status='pending',service='chiperia')=>({id,number:id,status,service,created_at:'2026-11-21T00:00:00Z'});
test('V1.4 alertas: contador, primera carga silenciosa, novedades sin duplicados, estados y recarga',()=>{
 const storage=memory(),key='fixture',t=createAlertTracker({storage,key}),old=order('old');assert.deepEqual(t.ingest([old]),[]);assert.equal(t.snapshot().pending.length,1);assert.equal(t.snapshot().unread.length,0);
 t.setSound(true);const fresh=order('new','pending','buffet');assert.equal(t.ingest([fresh,old]).length,1);assert.equal(t.isNew('new'),true);assert.equal(t.ingest([fresh,old]).length,0);assert.equal(t.snapshot().pending.length,2);
 const reloaded=createAlertTracker({storage,key});assert.equal(reloaded.ingest([fresh,old]).length,0);assert.equal(reloaded.isNew('new'),true);assert.equal(reloaded.snapshot().sound,true);reloaded.markRead(['new']);assert.equal(reloaded.isNew('new'),false);
 reloaded.ingest([{...old,status:'accepted'},fresh]);assert.equal(reloaded.snapshot().pending.length,1);reloaded.ingest([{...old,status:'pending'},fresh]);assert.equal(reloaded.isNew('old'),false);
 const anotherTab=createAlertTracker({storage,key});assert.equal(anotherTab.ingest([fresh,old]).length,0);const anotherAccount=createAlertTracker({storage,key:'other-account'});assert.equal(anotherAccount.ingest([fresh,old]).length,0);
});
test('V1.4 alertas: almacenamiento no disponible, fallos de JSON y privacidad',()=>{
 const t=createAlertTracker({storage:{getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}},key:'fixture'});t.ingest([]);assert.equal(t.ingest([order('one')]).length,1);assert.equal(t.ingest([order('one')]).length,0);assert.equal(t.snapshot().persisted,false);
 let value='invalid JSON';const storage={getItem:()=>value,setItem:(_,v)=>value=v},safe=createAlertTracker({storage,key:'fixture'});safe.ingest([{...order('one'),customer_name:'PRIVADO',address:'DIRECCIÓN'}]);assert.doesNotMatch(value,/PRIVADO|DIRECCIÓN|customer_name|address/);
});
test('V1.4 alertas SQL/API: todos los pendientes, sin límite del listado, sesión y datos mínimos',async()=>{
 const c=await databaseV11(),restore=mockEnvironment(),saved=globalThis.fetch;try{
 await c.db.exec(await readFile(new URL('../database/014_avisos_pedidos.sql',import.meta.url),'utf8'));
 const ing=await c.rpc('guarni_ingest',['fixture.alert.'+uid(),'595000001212','Prueba','hola']);const chat=await c.one('select * from guarni_conversations where id=$1',[ing.conversation_id]);
 await c.staff('menu',{id:uid(),day:localDate(),status:'published',reviewed:true,items:[{id:'dish',name:'Plato de prueba',category_id:'carne',available:true}]});
 const ids=[];for(let i=0;i<3;i++){const id=uid();ids.push(id);await c.staff('create_order',{request_id:id,client_id:chat.client_id,service:'buffet',items:[{variant_id:'dish',qty:1}],fulfillment:'retiro'});}
 await c.db.query("update guarni_orders set status='cancelled' where id=$1",[ids[2]]);
 await c.db.query("insert into guarni_orders(client_id,conversation_id,items,subtotal,customer_name) select $1,$2,'[]'::jsonb,1,'Prueba ficticia' from generate_series(1,501)",[chat.client_id,chat.id]);
 const bridge=restBridge(c);globalThis.fetch=bridge.fetch;const r=await api(new Request('https://crm.test/api?pending_orders=1',{headers:{authorization:'Bearer fixture'}}));assert.equal(r.status,200);const body=await r.json();assert.equal(body.orders.length,503);assert.deepEqual(Object.keys(body.orders[0]).sort(),['created_at','id','number','service','status']);assert.doesNotMatch(JSON.stringify(body),/595000|client_id|address|items/);
 const denied=await api(new Request('https://crm.test/api?pending_orders=1'));assert.equal(denied.status,401);await c.db.exec('set role authenticated');await assert.rejects(()=>c.db.exec('select viejo_pending_orders()'),/permission denied/);await c.db.exec('reset role');
 }finally{globalThis.fetch=saved;restore();await c.db.close();}
});
