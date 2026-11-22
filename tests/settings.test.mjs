import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID as uid} from 'node:crypto';
import {defaults,reduceOrder,emptyCart,quote,availability,localDate,activeCatalog} from '../shared/viejo-engine.js';
import {validateSettings,normalizeSettings,deliveryMode,PAYMENT_METHODS} from '../shared/settings.js';
import {databaseV11,mockEnvironment,restBridge} from './v11-helpers.mjs';import api from '../netlify/functions/api.mjs';import {runWorker} from '../netlify/lib/worker.mjs';
const copy=()=>structuredClone(defaults);
test('Configuración: validaciones comprensibles, modos independientes, días/pagos sin texto libre y sin inventar horario',()=>{
 const c=copy();
 assert.equal(validateSettings(c),c);
 assert.deepEqual(c.schedules.buffet.days,[]);
 assert.deepEqual(c.payment_methods,[]);
 assert.match(availability('buffet','retiro',c),/pendiente/);
 assert.match(availability('buffet','delivery',c),/coordinar/);
 c.payment_methods=['QR'];assert.equal(validateSettings(c),c);
 const schedule=c.schedules.buffet;
 Object.assign(schedule,{days:[5],open:'11:00',close:'16:00',delivery_mode:'scheduled',delivery_open:'12:00',delivery_close:'14:00'});
 assert.equal(validateSettings(c),c);
 for(const change of [x=>x.schedules.buffet.days=[],x=>x.schedules.chiperia={},x=>x.schedules.buffet.days=[1,1],x=>x.schedules.buffet.close='10:00',x=>x.schedules.buffet.open='29:00',x=>x.schedules.buffet.delivery_open='10:00',x=>x.payment_methods=['Cheque'],x=>x.payment_methods=['QR','QR'],x=>x.reference_prices.carne=1.5]){
  const bad=structuredClone(c);change(bad);assert.throws(()=>validateSettings(bad));
 }
 const legacy=structuredClone(c);delete legacy.schedules.buffet.delivery_mode;
 assert.equal(normalizeSettings(legacy).schedules.buffet.delivery_mode,'scheduled');
 legacy.fulfillment_modes=['retiro'];
 assert.equal(normalizeSettings(legacy).schedules.buffet.delivery_mode,'disabled');
 assert.ok(PAYMENT_METHODS.some(p=>p.value==='QR'));
 const disabled=copy();disabled.schedules.buffet.delivery_mode='disabled';
 assert.throws(()=>validateSettings(disabled),/modalidades de delivery/);
 disabled.fulfillment_modes=['retiro'];assert.equal(validateSettings(disabled),disabled);
});
test('Configuración SQL: migración conservadora, backup, validación y persistencia con permisos administrativos',async()=>{
 const c=await databaseV11({settings:false}),restore=mockEnvironment(),oldFetch=globalThis.fetch;try{
  const before=(await c.one('select config from guarni_settings')).config;before.payment_methods.push('Método antiguo por revisar');await c.db.query('update guarni_settings set config=$1',[before]);
  const migration=await readFile(new URL('../database/011_configuracion_ux.sql',import.meta.url),'utf8');await c.db.exec(migration);let current=(await c.one('select config from guarni_settings')).config;
  assert.equal(current.schedules.buffet.open,before.schedules.buffet.open);assert.equal(current.schedules.buffet.delivery_open,null);assert.equal(current.schedules.buffet.delivery_mode,'pending');assert.ok(current.legacy_payment_methods.includes('Método antiguo por revisar'));assert.deepEqual((await c.one("select config from viejo_settings_ux_backup where version='011'")).config,before);
  await c.db.exec(migration);assert.equal((await c.one('select count(*)::int n from viejo_settings_ux_backup')).n,1);
  const config=normalizeSettings(current);config.schedules.buffet.days=[1,3,5];config.schedules.buffet.open='11:00';config.schedules.buffet.close='16:00';config.fulfillment_modes=['retiro'];config.schedules.buffet.delivery_mode='disabled';config.payment_methods=['Efectivo','QR'];config.business_address='Dirección ficticia de prueba';validateSettings(config);
  await assert.rejects(()=>c.staff('settings',{config},c.editor),/admin_required/);await c.staff('settings',{config});assert.deepEqual((await c.one('select config from guarni_settings')).config,config);
  const invalid=[['schedule_time_required',x=>x.schedules.buffet.days=[]],['schedule_close_after_open',x=>x.schedules.buffet.close='10:00'],['invalid_schedule',x=>x.schedules.chiperia={}],['delivery_outside_hours',x=>{x.schedules.buffet.delivery_mode='scheduled';x.schedules.buffet.delivery_open='10:00';x.schedules.buffet.delivery_close='13:00';}],['invalid_payment_methods',x=>x.payment_methods=['Tarjeta inventada']]];
  for(const [message,change] of invalid){const bad=structuredClone(config);change(bad);await assert.rejects(()=>c.staff('settings',{config:bad}),new RegExp(message));assert.deepEqual((await c.one('select config from guarni_settings')).config,config);}
  let actor=c.editor;globalThis.fetch=restBridge(c,{actor:()=>actor}).fetch;const req=body=>new Request('https://crm.test/api',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({action:'settings',data:{config:body}})});
  assert.equal((await api(req(config))).status,403);actor=c.admin;const bad=structuredClone(config);bad.schedules.buffet.days=[];const r=await api(req(bad));assert.equal(r.status,400);assert.match((await r.json()).error,/Buffet.*horarios/);
  await c.db.exec('set role authenticated');await assert.rejects(()=>c.rpc('viejo_staff',[c.admin,'settings',{config}]),/permission denied/);await assert.rejects(()=>c.db.exec('update guarni_settings set config=\'{}\''),/permission denied/);await c.db.exec('reset role');
 }finally{globalThis.fetch=oldFetch;restore();await c.db.close();}
});
test('Delivery y asistente: SQL respeta disabled/pending y apagar el bot evita respuestas también a ubicaciones',async()=>{
 const c=await databaseV11(),restore=mockEnvironment(),oldFetch=globalThis.fetch;try{
  const bridge=restBridge(c);globalThis.fetch=bridge.fetch;
  const incoming=await c.rpc('guarni_ingest',['fixture.settings.'+uid(),'595000006666','Prueba','hola']);await runWorker();const chat=await c.one('select * from guarni_conversations where id=$1',[incoming.conversation_id]);
  const point={latitude:-25,longitude:-57};await c.rpc('guarni_ingest_location',['fixture.settings.loc.'+uid(),chat.wa_id,'Prueba',point,'location']);await runWorker();assert.equal((await c.one("select count(*)::int n from guarni_messages where direction='outbound'")).n,0);assert.equal((await c.one('select count(*)::int n from guarni_locations')).n,1);
  await c.db.query("insert into guarni_messages(conversation_id,direction,actor,body,status,revision) values($1,'outbound','bot','Respuesta antigua de prueba','queued',$2)",[chat.id,chat.revision]);await runWorker();assert.equal((await c.one("select status from guarni_messages where actor='bot'")).status,'cancelled');
  const config=normalizeSettings((await c.one('select config from guarni_settings')).config);config.schedules.buffet.delivery_mode='disabled';config.fulfillment_modes=['retiro'];await c.staff('settings',{config});
  const menu={id:uid(),day:localDate(),status:'published',reviewed:true,items:[{id:'prueba',name:'Plato ficticio',category_id:'carne',available:true}]};await c.staff('menu',menu);
  const items=[{variant_id:'prueba',qty:3}],request={request_id:uid(),client_id:chat.client_id,service:'buffet',items,fulfillment:'delivery'};await assert.rejects(()=>c.staff('create_order',request),/delivery_disabled/);
  const cart={...emptyCart('Prueba','buffet'),...quote(items,'buffet',activeCatalog('buffet',[],[menu])),fulfillment:'delivery',quoted:true};assert.match(reduceOrder({text:'CONFIRMAR PEDIDO',cart,catalog:[],menus:[menu],settings:config}).reply,/deshabilitado/);
  config.schedules.buffet.delivery_mode='pending';config.fulfillment_modes=['retiro','delivery'];await c.staff('settings',{config});await c.staff('create_order',request);let order=await c.one('select * from guarni_orders where id=$1',[request.request_id]);
  const loc=await c.one('select * from guarni_locations');await c.rpc('guarni_assign_location',[c.admin,order.id,loc.id,null,true]);const accept={id:order.id,status:'accepted',fulfillment:'delivery',address:'Referencia ficticia',shipping_fee:8000,buffet_amount:10500,price_agreed:true,expected_items:order.items};await assert.rejects(()=>c.staff('order_status',accept),/schedule_review_required/);await c.staff('take',{id:chat.id});await c.staff('order_status',{...accept,schedule_reviewed:true});await c.staff('release',{id:chat.id});assert.equal((await c.one('select total from guarni_orders where id=$1',[order.id])).total,18500);
  config.schedules.buffet.delivery_mode='disabled';config.fulfillment_modes=['retiro'];await c.staff('settings',{config});await c.staff('order_status',{id:order.id,status:'preparing'});assert.equal((await c.one('select status from guarni_orders where id=$1',[order.id])).status,'preparing'); // Un cambio de configuración no cancela pedidos previos.
  const info=reduceOrder({text:'horarios',cart:emptyCart('Prueba','buffet'),catalog:[],command:{intent:'info'},settings:config}).reply;assert.match(info,/Delivery deshabilitado/);assert.doesNotMatch(info,/delivery_mode|scheduled|"days"/);
  config.schedules.buffet.delivery_mode='pending';config.fulfillment_modes=['retiro','delivery'];config.bot_enabled=true;await c.staff('settings',{config});await c.rpc('guarni_ingest_location',['fixture.settings.active.'+uid(),chat.wa_id,'Prueba',point,'location']);await runWorker();assert.ok((await c.one("select count(*)::int n from guarni_messages where actor='bot' and status<>'cancelled'")).n>0);
 }finally{globalThis.fetch=oldFetch;restore();await c.db.close();}
});
