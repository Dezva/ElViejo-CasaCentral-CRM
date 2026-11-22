import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';import {randomUUID as uid} from 'node:crypto';
test('El Viejo PostgreSQL: migraciones, seguridad, menú, precios, confirmación, idempotencia y atención humana',async t=>{
 const db=new PGlite({initialMemory:128*1024*1024});const actor=uid(),employee=uid();
 const rpc=async(name,args)=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;`);
  for(const name of ['001_base_crm','002_guarnipitan','005_eliminacion_admin','006_ubicaciones_delivery','007_el_viejo','008_catalogo_el_viejo'])await db.exec(await readFile(new URL('../database/'+name+'.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../database/007_el_viejo.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../database/008_catalogo_el_viejo.sql',import.meta.url),'utf8'));
  assert.equal((await one('select count(*)::int as n from guarni_catalog')).n,31);
  await db.query('insert into auth.users values($1,$2),($3,$4)',[actor,'admin@example.test',employee,'staff@example.test']);
  await db.query("insert into crm_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Empleado','member')",[actor,employee]);
  const ingested=await rpc('guarni_ingest',['fixture.1','595000000001','Prueba','hola']);const chat=ingested.conversation_id,cl=(await one('select client_id from guarni_conversations where id=$1',[chat])).client_id;
  const staff=async(action,p={},who=actor)=>{if(action==='order_status'&&p.status==='accepted'&&!p.expected_items)p={...p,expected_items:(await one('select items from guarni_orders where id=$1',[p.id])).items};return rpc('viejo_staff',[who,action,p]);};
  const product=await one("select * from guarni_catalog where name='Tradicional'");
  const items=[{variant_id:product.id,qty:3,unit_price:1}];
  let orderId=uid();await staff('create_order',{request_id:orderId,client_id:cl,service:'chiperia',items,fulfillment:'retiro'});await staff('create_order',{request_id:orderId,client_id:cl,service:'chiperia',items,fulfillment:'retiro'});
  assert.equal((await one('select count(*)::int n from guarni_orders')).n,1);assert.equal((await one('select subtotal from guarni_orders where id=$1',[orderId])).subtotal,10500);
  await assert.rejects(()=>staff('catalog',{...product,price:1},employee),/admin_required/);
  await assert.rejects(()=>staff('take',{id:chat},uid()),/not_member/);
  await staff('member',{id:employee,display_name:'Empleado autorizado',role:'member',catalog_editor:true});
  await staff('catalog',{...product,price:4000},employee);
  assert.equal((await staff('order_status',{id:orderId,status:'accepted',fulfillment:'retiro',schedule_reviewed:true})).requote,true);
  assert.equal((await one('select status from guarni_orders where id=$1',[orderId])).status,'pending');
  assert.equal((await rpc('viejo_staff',[actor,'order_status',{id:orderId,status:'accepted',fulfillment:'retiro',expected_items:[{variant_id:product.id,qty:3,unit_price:3500}],schedule_reviewed:true}])).requote,true);
  assert.equal((await one('select status from guarni_orders where id=$1',[orderId])).status,'pending');
  assert.equal((await one("select count(*)::int n from guarni_messages where body like 'La cotización%' ")).n,1);
  await staff('order_status',{id:orderId,status:'accepted',fulfillment:'retiro',shipping_fee:8888,schedule_reviewed:true});
  assert.equal((await one('select total,shipping_fee from guarni_orders where id=$1',[orderId])).total,12000);
  assert.equal((await one('select shipping_fee from guarni_orders where id=$1',[orderId])).shipping_fee,0);
  await assert.rejects(()=>staff('order_status',{id:orderId,status:'accepted',fulfillment:'retiro',schedule_reviewed:true}),/invalid_transition/);
  assert.equal((await one("select count(*)::int n from guarni_messages where body like 'El local confirmó%' ")).n,1);
  await assert.rejects(()=>staff('menu',{id:uid(),day:'2026-11-20',status:'published',items:[{id:'test',name:'Ficticio',category:'Prueba'}]}),/human_review_required/);
  const day=(await one("select (now() at time zone 'America/Asuncion')::date::text as today")).today;
  await staff('menu',{id:uid(),day,status:'published',reviewed:true,items:[{id:'test',name:'Plato ficticio de prueba',category:'Prueba',available:true}]});
  orderId=uid();await staff('create_order',{request_id:orderId,client_id:cl,service:'buffet',items:[{variant_id:'test',qty:1}],fulfillment:'retiro'});
  const order=await one('select * from guarni_orders where id=$1',[orderId]);assert.equal(order.subtotal,null);assert.equal(order.items[0].unit_price,null);
  const accept={id:orderId,status:'accepted',fulfillment:'retiro',buffet_amount:50000,price_agreed:true,schedule_reviewed:true};
  await assert.rejects(()=>staff('order_status',accept),/take_conversation_first/);await staff('take',{id:chat});await staff('order_status',accept);assert.equal((await one('select total from guarni_orders where id=$1',[orderId])).total,50000);
  // Explicit cost even for free deliveries, location required; no arbitrary unit prices.
  orderId=uid();await staff('create_order',{request_id:orderId,client_id:cl,service:'chiperia',items,fulfillment:'delivery'});
  await assert.rejects(()=>staff('order_status',{id:orderId,status:'accepted',fulfillment:'delivery',address:'Prueba',schedule_reviewed:true,shipping_fee:0}),/delivery_location_required/);
  await rpc('guarni_ingest_location',['fixture.loc','595000000001','Prueba',{latitude:-25,longitude:-57},'location']);
  const loc=(await one('select id from guarni_locations')).id;
  await rpc('guarni_assign_location',[actor,orderId,loc,null,true]);
  await assert.rejects(()=>staff('order_status',{id:orderId,status:'accepted',fulfillment:'delivery',address:'Prueba',schedule_reviewed:true}),/explicit_delivery_fee_required/);
  await staff('order_status',{id:orderId,status:'accepted',fulfillment:'delivery',address:'Prueba',schedule_reviewed:true,shipping_fee:0});
  await staff('payment_status',{id:orderId,payment_status:'paid'});assert.equal((await one('select payment_status from guarni_orders where id=$1',[orderId])).payment_status,'paid');
  // Nuevo flujo WhatsApp por reserva: no se usa create_order para esta comprobación.
  const incoming=await rpc('guarni_ingest',['fixture.bot','595000000002','WhatsApp prueba','pedido']);
  const cq=await rpc('viejo_quote',['chiperia',items]);
  const cart={service:'chiperia',items:cq.items,quoted:true,fulfillment:'retiro',customer_name:'WhatsApp prueba',address:'',payment:'Efectivo'};
  await db.query('update guarni_conversations set cart=$1 where id=$2',[cart,incoming.conversation_id]);
  // Los mensajes anteriores no forman parte de esta reserva.
  await db.query("update guarni_jobs set status='done' where conversation_id<>$1",[incoming.conversation_id]);
  await db.query("update guarni_messages set status='sent' where status='queued' and conversation_id<>$1",[incoming.conversation_id]);
  let token=uid(),job=await rpc('guarni_claim',[token]);
  const saved=await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,cart,'','submit']);
  assert.equal(saved.order.service,'chiperia');assert.equal(saved.order.subtotal,12000);
  assert.equal((await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,cart,'','submit'])).duplicate,true);
  // Buffet pauses the bot atomically with the pending order.
  await db.query("update guarni_messages set status='sent' where status='queued'");
  await rpc('guarni_ingest',['fixture.buffet','595000000002','WhatsApp prueba','buffet']);
  const bq=await rpc('viejo_quote',['buffet',[{variant_id:'test',qty:1}]]);
  const bc={...cart,service:'buffet',items:bq.items};
  await db.query('update guarni_conversations set cart=$1 where id=$2',[bc,incoming.conversation_id]);
  token=uid();job=await rpc('guarni_claim',[token]);
  const buffet=await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,bc,'','submit']);
  assert.equal(buffet.order.subtotal,null);assert.ok(buffet.order.group_id);
  assert.equal((await one('select mode from guarni_conversations where id=$1',[incoming.conversation_id])).mode,'human');
  await db.exec('set role authenticated');
  assert.equal((await one('select count(*)::int n from guarni_orders')).n,0);
  await assert.rejects(()=>rpc('viejo_staff',[actor,'take',{id:chat}]),/permission denied/);
  await db.exec('reset role');
  assert.ok((await one('select count(*)::int n from viejo_history')).n>=4);
 }finally{await db.close();}
});
