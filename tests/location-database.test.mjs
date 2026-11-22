import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {emptyCart,reduceOrder} from '../shared/order-engine.js';

test('PostgreSQL: ubicaciones, delivery y compatibilidad con datos existentes',async t=>{
 const db=new PGlite({initialMemory:128*1024*1024,postgresqlconf:'shared_buffers=16MB\nmax_connections=10'});
 const admin=randomUUID(),member=randomUUID(),outsider=randomUUID();let sequence=0;
 const rpc=async(name,args)=>{const r=await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args);return r.rows[0].result;};
 const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 const external=()=> 'wamid.location-test.'+randomUUID();
 const claim=async()=>{const token=randomUUID();return {token,job:await rpc('guarni_claim',[token])};};
 async function drain(){
  for(let i=0;i<50;i++){
   const {token,job}=await claim();if(!job)return;
   if(job.kind==='send')await rpc('guarni_sent',[token,job.message.id,'sent',external(),null]);
   else if(job.kind==='inbound')await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,job.conversation.cart,'','ignore']);
  }
  assert.fail('La cola no se vació.');
 }
 let catalog,sku;
 async function start(fulfillment='delivery'){
  const wa='59500000'+String(++sequence).padStart(4,'0');
  const ingested=await rpc('guarni_ingest',[external(),wa,'Cliente de prueba','2 Kikito']);
  const {token,job}=await claim();assert.equal(job.conversation.id,ingested.conversation_id);
  const result=reduceOrder({text:'2 Kikito',cart:emptyCart('Cliente de prueba'),catalog,command:{intent:'update_cart',items:[{variant_id:sku.id,qty:2,notes:'Sin tomate'}],fulfillment,address:'Calle de prueba'}});
  await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,result.cart,result.reply,'reply']);await drain();
  return {wa,chat:ingested.conversation_id,cart:result.cart,client:job.conversation.client_id};
 }
 async function receive(customer,latitude=-25.509215,longitude=-57.5601){
  const id=external();const result=await rpc('guarni_ingest_location',[id,customer.wa,'Cliente de prueba',{latitude,longitude,name:'Casa de prueba',address:'Dirección descriptiva'},'location']);
  const {token,job}=await claim();assert.equal(job.conversation.id,customer.chat);assert.equal(job.message.content_type,'location');
  const processed=await rpc('guarni_process_location',[token,job.job.id,true]);
  const location=await one('select * from guarni_locations where message_id=$1',[job.message.id]);
  await drain();return {id,location,processed,token,job,result};
 }
 async function submit(customer){
  const id=external();await rpc('guarni_ingest',[id,customer.wa,'Cliente de prueba','CONFIRMAR PEDIDO']);
  const {token,job}=await claim();assert.equal(job.conversation.id,customer.chat);
  const result=reduceOrder({text:'CONFIRMAR PEDIDO',cart:{...job.conversation.cart,delivery_location_id:job.conversation.draft_location_id},catalog});
  const finished=await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,result.cart,result.reply,result.kind]);
  await drain();return {id,token,job,result,finished};
 }
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key,email text);
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  for(const file of ['001_base_crm.sql','002_guarnipitan.sql','003_catalogo.sql','005_eliminacion_admin.sql'])await db.exec(await readFile(new URL(file==='003_catalogo.sql'?'./fixtures/legacy-catalog.sql':'../database/'+file,import.meta.url),'utf8'));
  await db.query('insert into auth.users values($1,$2),($3,$4),($5,$6)',[admin,'admin@test',member,'member@test',outsider,'outsider@test']);
  await db.query("insert into crm_members values($1,'Admin','admin',now()),($2,'Member','member',now())",[admin,member]);
  const legacy=await rpc('guarni_ingest',[external(),'595000000999','Cliente anterior','[Contenido location recibido: requiere atención humana]']);
  const legacyClient=(await one('select client_id from guarni_conversations where id=$1',[legacy.conversation_id])).client_id;
  await db.query("insert into guarni_orders(client_id,conversation_id,items,subtotal,customer_name,fulfillment,address) values($1,$2,'[]',10000,'Cliente anterior','delivery','Dirección antigua')",[legacyClient,legacy.conversation_id]);
  const migration=await readFile(new URL('../database/006_ubicaciones_delivery.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
  await drain();catalog=(await db.query('select * from guarni_catalog')).rows;sku=catalog.find(p=>p.name==='Kikito');

  await t.test('Migración incremental conserva mensajes, pedidos anteriores y valores nulos compatibles',async()=>{
   assert.equal((await one('select content_type from guarni_messages where conversation_id=$1 and direction=$2',[legacy.conversation_id,'inbound'])).content_type,'text');
   assert.equal((await one('select delivery_location_id from guarni_orders where client_id=$1',[legacyClient])).delivery_location_id,null);
   assert.equal((await one('select count(*)::integer as n from guarni_locations')).n,0);
  });
  await t.test('Persistencia estructurada, deduplicación y procesamiento idempotente de la ubicación',async()=>{
   const customer=await start(),received=await receive(customer);
   assert.equal(received.location.latitude,-25.509215);assert.equal(received.location.longitude,-57.5601);assert.equal(received.location.conversation_id,customer.chat);assert.ok(received.location.received_at);assert.equal(received.location.address,'Dirección descriptiva');
   assert.equal((await rpc('guarni_ingest_location',[received.id,customer.wa,'Cliente',{latitude:0,longitude:0},'location'])).duplicate,true);
   assert.equal((await rpc('guarni_process_location',[received.token,received.job.job.id,true])).duplicate,true);
   assert.equal((await one('select count(*)::integer as n from guarni_locations where conversation_id=$1',[customer.chat])).n,1);
   const reply=await one("select body from guarni_messages where conversation_id=$1 and direction='outbound' order by created_at desc,id desc limit 1",[customer.chat]);assert.match(reply.body,/recibí tu ubicación/);assert.doesNotMatch(reply.body,/archivo/i);
  });
  await t.test('Coordenadas inválidas se rechazan sin insertar mensajes ni trabajos parciales',async()=>{
   const before=(await one('select count(*)::integer as n from guarni_messages')).n;
   for(const location of [{latitude:91,longitude:0},{latitude:0,longitude:181},{latitude:null,longitude:0},{latitude:true,longitude:0},{latitude:'NaN',longitude:0}])await assert.rejects(()=>rpc('guarni_ingest_location',[external(),'595000000777','Cliente',location,'location']),/invalid_location/);
   assert.equal((await one('select count(*)::integer as n from guarni_messages')).n,before);
  });
  await t.test('Delivery sin ubicación bloquea registro incluso si se omite la interfaz',async()=>{
   const customer=await start();await rpc('guarni_ingest',[external(),customer.wa,'Cliente','CONFIRMAR PEDIDO']);
   const {token,job}=await claim();
   await assert.rejects(()=>rpc('guarni_finish',[token,job.job.id,job.conversation.revision,customer.cart,'','submit']),/delivery_location_required/);
   assert.equal((await one('select count(*)::integer as n from guarni_orders where conversation_id=$1',[customer.chat])).n,0);
   const after=await one('select cart from guarni_conversations where id=$1',[customer.chat]);assert.deepEqual(after.cart.items,customer.cart.items);
   await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,after.cart,'Enviame tu ubicación actual.','reply']);await drain();
  });
  await t.test('Retiro se registra y acepta sin exigir coordenadas',async()=>{
   const customer=await start('retiro'),result=await submit(customer);assert.equal(result.finished.order.status,'pending');assert.equal(result.finished.order.delivery_location_id,null);
   await rpc('guarni_staff',[member,'order_status',{id:result.finished.order.id,status:'accepted',fulfillment:'retiro',shipping_fee:0,address:''}]);await drain();
   assert.equal((await one('select status from guarni_orders where id=$1',[result.finished.order.id])).status,'accepted');
  });
  await t.test('Delivery válido crea solicitud pending y asocia el punto sin duplicar pedidos',async()=>{
   const customer=await start(),received=await receive(customer),result=await submit(customer);const order=result.finished.order;
   assert.equal(order.status,'pending');assert.equal(order.delivery_location_id,received.location.id);
   assert.equal((await one('select draft_location_id from guarni_conversations where id=$1',[customer.chat])).draft_location_id,null);
   assert.equal((await rpc('guarni_finish',[result.token,result.job.job.id,result.job.conversation.revision,result.result.cart,'','submit'])).duplicate,true);
   assert.equal((await rpc('guarni_ingest',[result.id,customer.wa,'Cliente','CONFIRMAR PEDIDO'])).duplicate,true);
   assert.equal((await one('select count(*)::integer as n from guarni_orders where conversation_id=$1',[customer.chat])).n,1);
   await rpc('guarni_staff',[member,'order_status',{id:order.id,status:'accepted',fulfillment:'delivery',shipping_fee:5000,address:'Dirección del cliente'}]);await drain();
   const accepted=await one('select * from guarni_orders where id=$1',[order.id]);assert.equal(accepted.status,'accepted');assert.equal(accepted.total,84000);
  });
  await t.test('Aceptación de delivery exige punto aunque el personal complete una dirección',async()=>{
   const oldOrder=await one('select id from guarni_orders where client_id=$1',[legacyClient]);
   await assert.rejects(()=>rpc('guarni_staff',[member,'order_status',{id:oldOrder.id,status:'accepted',fulfillment:'delivery',shipping_fee:0,address:'Dirección válida'}]),/delivery_location_required/);
   assert.equal((await one('select status from guarni_orders where id=$1',[oldOrder.id])).status,'pending');
  });
  await t.test('Ubicación nueva actualiza borrador y luego el único delivery pendiente, con trazabilidad',async()=>{
   const customer=await start(),first=await receive(customer),second=await receive(customer,-25.6,-57.7),result=await submit(customer);
   assert.equal(result.finished.order.delivery_location_id,second.location.id);
   assert.equal((await one('select count(*)::integer as n from guarni_locations where conversation_id=$1',[customer.chat])).n,2);
   const third=await receive(customer,-25.7,-57.8);assert.equal(third.processed.association,'pending_order');
   assert.equal((await one('select delivery_location_id from guarni_orders where id=$1',[result.finished.order.id])).delivery_location_id,third.location.id);
   assert.equal((await one('select count(*)::integer as n from guarni_order_locations where order_id=$1',[result.finished.order.id])).n,2);
   assert.notEqual(first.location.id,third.location.id);
  });
  await t.test('Una ubicación en atención humana se conserva sin responder ni reactivar el bot',async()=>{
   const customer=await start();await rpc('guarni_staff',[member,'take',{id:customer.chat}]);
   const before=(await one("select count(*)::integer as n from guarni_messages where conversation_id=$1 and direction='outbound'",[customer.chat])).n;
   const received=await receive(customer);const conversation=await one('select * from guarni_conversations where id=$1',[customer.chat]);
   assert.equal(conversation.mode,'human');assert.equal(conversation.owner_id,member);assert.equal(conversation.draft_location_id,received.location.id);
   assert.equal((await one("select count(*)::integer as n from guarni_messages where conversation_id=$1 and direction='outbound'",[customer.chat])).n,before);
  });
  await t.test('Varios pedidos requieren selección del personal y rechazan ubicaciones de otra conversación',async()=>{
   const customer=await start();await receive(customer);const first=(await submit(customer)).finished.order;
   const secondId=randomUUID();await rpc('guarni_staff',[member,'create_order',{request_id:secondId,client_id:customer.client,items:[{variant_id:sku.id,qty:1,notes:''}]}]);
   const received=await receive(customer,-25.8,-57.9);assert.equal(received.processed.association,'review');assert.equal(received.location.review_reason,'multiple_orders');
   assert.notEqual((await one('select delivery_location_id from guarni_orders where id=$1',[first.id])).delivery_location_id,received.location.id);
   assert.equal((await one('select delivery_location_id from guarni_orders where id=$1',[secondId])).delivery_location_id,null);
   await rpc('guarni_assign_location',[member,secondId,received.location.id,null,true]);
   assert.equal((await one('select delivery_location_id from guarni_orders where id=$1',[secondId])).delivery_location_id,received.location.id);
   const other=await start();const otherPoint=await receive(other);
   await assert.rejects(()=>rpc('guarni_assign_location',[member,secondId,otherPoint.location.id,received.location.id,true]),/invalid_location/);
   await assert.rejects(()=>rpc('guarni_assign_location',[outsider,secondId,received.location.id,received.location.id,true]),/not_member/);
  });
  await t.test('Un pedido aceptado conserva su punto hasta aprobar el cambio y detecta cambios concurrentes',async()=>{
   const customer=await start(),first=await receive(customer),order=(await submit(customer)).finished.order;
   await rpc('guarni_staff',[member,'order_status',{id:order.id,status:'accepted',fulfillment:'delivery',shipping_fee:0,address:'Dirección válida'}]);await drain();
   const second=await receive(customer,-25.61,-57.71);assert.equal(second.location.review_reason,'accepted_order');
   assert.equal((await one('select delivery_location_id from guarni_orders where id=$1',[order.id])).delivery_location_id,first.location.id);
   await assert.rejects(()=>rpc('guarni_assign_location',[member,order.id,second.location.id,first.location.id,false]),/location_approval_required/);
   await rpc('guarni_assign_location',[member,order.id,second.location.id,first.location.id,true]);
   await assert.rejects(()=>rpc('guarni_assign_location',[member,order.id,first.location.id,first.location.id,true]),/location_changed/);
   await rpc('guarni_assign_location',[member,order.id,first.location.id,second.location.id,true]);
   assert.equal((await one('select count(*)::integer as n from guarni_order_locations where order_id=$1',[order.id])).n,3);
   for(const status of ['preparing','ready','delivered']){await rpc('guarni_staff',[member,'order_status',{id:order.id,status}]);await drain();}
   await receive(customer,-25.62,-57.72);
   assert.equal((await one('select delivery_location_id from guarni_orders where id=$1',[order.id])).delivery_location_id,first.location.id);
   await assert.rejects(()=>rpc('guarni_assign_location',[member,order.id,second.location.id,first.location.id,true]),/location_order_closed/);
  });
  await t.test('Retiro, reinicio y nuevo pedido limpian el punto para evitar reutilizar ubicaciones anteriores',async()=>{
   const customer=await start('retiro');const received=await receive(customer);const order=(await submit(customer)).finished.order;
   assert.equal(order.delivery_location_id,null);assert.equal((await one('select draft_location_id from guarni_conversations where id=$1',[customer.chat])).draft_location_id,null);
   await rpc('guarni_ingest',[external(),customer.wa,'Cliente','2 Kikito para delivery']);const {token,job}=await claim();
   const cart=reduceOrder({text:'2 Kikito para delivery',cart:emptyCart(),catalog,command:{intent:'update_cart',fulfillment:'delivery',items:[{variant_id:sku.id,qty:2,notes:''}]}});
   await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,cart.cart,cart.reply,'reply']);await drain();
   const missing=await submit(customer);assert.equal(missing.result.kind,'reply');assert.equal(missing.finished.order,null);
   await receive(customer);await rpc('guarni_ingest',[external(),customer.wa,'Cliente','/cancelar']);const cancelled=await claim();
   await rpc('guarni_finish',[cancelled.token,cancelled.job.job.id,cancelled.job.conversation.revision,emptyCart(),'Borrador cancelado.','reply']);await drain();
   assert.equal((await one('select draft_location_id from guarni_conversations where id=$1',[customer.chat])).draft_location_id,null);
   assert.ok(await one('select id from guarni_locations where id=$1',[received.location.id]));
  });
  await t.test('Ubicación anticipada se usa en el primer borrador sin pedir otra',async()=>{
   const wa='59500000'+String(++sequence).padStart(4,'0');
   const message=await rpc('guarni_ingest',[external(),wa,'Cliente','hola']);await drain();
   const customer={wa,chat:message.conversation_id};const received=await receive(customer);
   await rpc('guarni_ingest',[external(),wa,'Cliente','2 Kikito para delivery']);const {token,job}=await claim();
   const result=reduceOrder({text:'2 Kikito para delivery',cart:{...emptyCart(),delivery_location_id:job.conversation.draft_location_id},catalog,command:{intent:'update_cart',fulfillment:'delivery',items:[{variant_id:sku.id,qty:2,notes:''}]}});
   assert.doesNotMatch(result.reply,/enviame tu ubicación/);
   await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,result.cart,result.reply,'reply']);await drain();
   assert.equal((await submit(customer)).finished.order.delivery_location_id,received.location.id);
  });
  await t.test('El personal puede convertir un retiro pendiente a delivery y no cambia pedidos cancelados',async()=>{
   const customer=await start('retiro'),order=(await submit(customer)).finished.order;
   const point=await receive(customer);assert.equal(point.processed.association,'review');
   await rpc('guarni_assign_location',[member,order.id,point.location.id,null,true]);
   await rpc('guarni_staff',[member,'order_status',{id:order.id,status:'accepted',fulfillment:'delivery',shipping_fee:0,address:'Dirección escrita por el equipo'}]);await drain();
   assert.equal((await one('select fulfillment from guarni_orders where id=$1',[order.id])).fulfillment,'delivery');
   await rpc('guarni_staff',[member,'order_status',{id:order.id,status:'cancelled'}]);await drain();
   const another=await receive(customer,-25.91,-57.91);
   assert.equal((await one('select delivery_location_id from guarni_orders where id=$1',[order.id])).delivery_location_id,point.location.id);
   await assert.rejects(()=>rpc('guarni_assign_location',[member,order.id,another.location.id,point.location.id,true]),/location_order_closed/);
  });
  await t.test('Los avisos de ubicación inválida o tiempo real no guardan puntos ni derivan a atención humana',async()=>{
   const customer=await start();
   for(const type of ['invalid_location','live_location']){
    await rpc('guarni_ingest_location',[external(),customer.wa,'Cliente',null,type]);const {token,job}=await claim();
    await rpc('guarni_process_location',[token,job.job.id,true]);await drain();
    assert.equal((await one('select mode from guarni_conversations where id=$1',[customer.chat])).mode,'bot');
    assert.equal((await one('select count(*)::integer as n from guarni_locations where conversation_id=$1',[customer.chat])).n,0);
    const reply=await one("select body from guarni_messages where conversation_id=$1 and direction='outbound' order by created_at desc,id desc limit 1",[customer.chat]);assert.match(reply.body,/ubicación actual puntual/);assert.doesNotMatch(reply.body,/archivo/);
   }
  });
  await t.test('Una entrega demorada conserva la hora original y requiere revisión sin sustituir puntos actuales',async()=>{
   const customer=await start(),first=await receive(customer),order=(await submit(customer)).finished.order;
   await rpc('guarni_ingest_location',[external(),customer.wa,'Cliente',{latitude:-25.1,longitude:-57.1},'location','946684800']);
   const {token,job}=await claim();await rpc('guarni_process_location',[token,job.job.id,true]);await drain();
   const old=await one('select * from guarni_locations where message_id=$1',[job.message.id]);
   assert.equal(new Date(old.whatsapp_sent_at).getUTCFullYear(),2000);assert.ok(old.received_at);assert.equal(old.review_reason,'stale_location');
   assert.equal((await one('select delivery_location_id from guarni_orders where id=$1',[order.id])).delivery_location_id,first.location.id);
  });
  await t.test('RLS y permisos protegen coordenadas y RPC contra visitantes y usuarios no autorizados',async()=>{
   await db.exec('set role anon');await assert.rejects(()=>db.query('select * from guarni_locations'),/permission denied/);await db.exec('reset role');
   await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[outsider]);assert.equal((await db.query('select * from guarni_locations')).rows.length,0);
   await db.query("select set_config('request.jwt.claim.sub',$1,false)",[member]);assert.ok((await db.query('select * from guarni_locations')).rows.length>0);
   await assert.rejects(()=>db.query('delete from guarni_locations'),/permission denied/);
   await assert.rejects(()=>rpc('guarni_ingest_location',[external(),'595000000777','Cliente',{latitude:0,longitude:0},'location']),/permission denied/);
   await assert.rejects(()=>rpc('guarni_assign_location',[member,randomUUID(),randomUUID(),null,true]),/permission denied/);
   await db.exec('reset role');
  });
  await t.test('Borrado administrativo conserva la compatibilidad y limpia ubicaciones e historial asociado',async()=>{
   const customer=await start();await receive(customer);const order=(await submit(customer)).finished.order;
   await rpc('guarni_delete',[admin,'client',customer.client,true]);
   assert.equal((await one('select count(*)::integer as n from guarni_locations where conversation_id=$1',[customer.chat])).n,0);
   assert.equal((await one('select count(*)::integer as n from guarni_order_locations where order_id=$1',[order.id])).n,0);
  });
 }finally{await db.close();}
});
