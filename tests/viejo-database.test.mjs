import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';import {randomUUID as uid} from 'node:crypto';
test('El Viejo PostgreSQL: migraciones, seguridad, menú, precios, confirmación, idempotencia y atención humana',async t=>{
 const db=new PGlite({initialMemory:128*1024*1024});const actor=uid(),employee=uid();
 const rpc=async(name,args)=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;`);
  for(const name of ['001_base_crm','002_guarnipitan','005_eliminacion_admin','006_ubicaciones_delivery','007_el_viejo','009_v11_fiabilidad','010_buffet_categories','011_configuracion_ux','013_metricas_ia','014_avisos_pedidos'])await db.exec(await readFile(new URL('../database/'+name+'.sql',import.meta.url),'utf8'));
  assert.equal((await one('select count(*)::int as n from guarni_catalog')).n,0);
  assert.equal((await one('select count(*)::int as n from guarni_orders')).n,0);
  const {config}=await one('select config from guarni_settings');
  assert.deepEqual(Object.keys(config.schedules),['buffet']);
  assert.deepEqual(config.schedules.buffet.days,[]);
  await db.query('insert into auth.users values($1,$2),($3,$4)',[actor,'admin@example.test',employee,'staff@example.test']);
  await db.query("insert into crm_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Empleado','member')",[actor,employee]);
  const ingested=await rpc('guarni_ingest',['fixture.1','595000000001','Prueba','hola']);
  const chat=ingested.conversation_id,cl=(await one('select client_id from guarni_conversations where id=$1',[chat])).client_id;
  const staff=async(action,p={},who=actor)=>{
   if(action==='order_status'&&p.status==='accepted'&&!p.expected_items)p={...p,expected_items:(await one('select items from guarni_orders where id=$1',[p.id])).items};
   return rpc('viejo_staff',[who,action,p]);
  };
  const items=[{variant_id:'test',qty:3,unit_price:1}];
  await assert.rejects(()=>staff('create_order',{request_id:uid(),client_id:cl,service:'chiperia',items,fulfillment:'retiro'}),/invalid_items/);
  await assert.rejects(()=>staff('take',{id:chat},uid()),/not_member/);
  await staff('settings',{config});
  await assert.rejects(()=>staff('menu',{id:uid(),day:'2026-11-20',status:'published',items:[{id:'test',name:'Ficticio',category_id:'carne',available:true}]}),/human_review_required/);
  const day=(await one("select (now() at time zone 'America/Asuncion')::date::text as today")).today;
  await staff('menu',{id:uid(),day,status:'published',reviewed:true,items:[{id:'test',name:'Plato ficticio de prueba',category_id:'carne',available:true}]});
  const pickupId=uid();let orderId=pickupId;await staff('create_order',{request_id:orderId,client_id:cl,service:'buffet',items:[{variant_id:'test',qty:1}],fulfillment:'retiro'});
  await staff('create_order',{request_id:orderId,client_id:cl,service:'buffet',items:[{variant_id:'test',qty:1}],fulfillment:'retiro'});
  assert.equal((await one('select count(*)::int n from guarni_orders')).n,1);
  const order=await one('select * from guarni_orders where id=$1',[orderId]);assert.equal(order.subtotal,null);assert.equal(order.items[0].unit_price,null);
  const accept={id:orderId,status:'accepted',fulfillment:'retiro',buffet_amount:50000,price_agreed:true,schedule_reviewed:true};
  await assert.rejects(()=>staff('order_status',accept),/take_conversation_first/);await staff('take',{id:chat});await staff('order_status',accept);assert.equal((await one('select total from guarni_orders where id=$1',[orderId])).total,50000);
  // Explicit cost even for free deliveries, location required; no arbitrary unit prices.
  orderId=uid();await staff('create_order',{request_id:orderId,client_id:cl,service:'buffet',items,fulfillment:'delivery'});
  await assert.rejects(()=>staff('order_status',{id:orderId,status:'accepted',fulfillment:'delivery',address:'Prueba',schedule_reviewed:true,shipping_fee:0}),/delivery_location_required/);
  await rpc('guarni_ingest_location',['fixture.loc','595000000001','Prueba',{latitude:-25,longitude:-57},'location']);
  const loc=(await one('select id from guarni_locations')).id;
  await rpc('guarni_assign_location',[actor,orderId,loc,null,true]);
  await assert.rejects(()=>staff('order_status',{id:orderId,status:'accepted',fulfillment:'delivery',address:'Prueba',schedule_reviewed:true}),/explicit_delivery_fee_required/);
  await staff('order_status',{id:orderId,status:'accepted',fulfillment:'delivery',address:'Prueba',schedule_reviewed:true,shipping_fee:0,buffet_amount:50000,price_agreed:true});
  await staff('payment_status',{id:orderId,payment_status:'paid'});assert.equal((await one('select payment_status from guarni_orders where id=$1',[orderId])).payment_status,'paid');
  // Nuevo flujo WhatsApp por reserva: no se usa create_order para esta comprobación.
  const incoming=await rpc('guarni_ingest',['fixture.bot','595000000002','WhatsApp prueba','pedido']);
  const cq=await rpc('viejo_quote',['buffet',items]);
  const cart={service:'buffet',items:cq.items,quoted:true,fulfillment:'retiro',customer_name:'WhatsApp prueba',address:'',payment:'Efectivo'};
  await db.query('update guarni_conversations set cart=$1 where id=$2',[cart,incoming.conversation_id]);
  // Los mensajes anteriores no forman parte de esta reserva.
  await db.query("update guarni_jobs set status='done' where conversation_id<>$1",[incoming.conversation_id]);
  await db.query("update guarni_messages set status='sent' where status='queued' and conversation_id<>$1",[incoming.conversation_id]);
  let token=uid(),job=await rpc('guarni_claim',[token]);
  const saved=await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,cart,'','submit']);
  assert.equal(saved.order.service,'buffet');assert.equal(saved.order.subtotal,null);
  assert.equal((await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,cart,'','submit'])).duplicate,true);
  assert.equal((await one('select mode from guarni_conversations where id=$1',[incoming.conversation_id])).mode,'human');
  await staff('take',{id:incoming.conversation_id});await staff('release',{id:incoming.conversation_id});
  await db.query("update guarni_messages set status='sent' where status='queued'");
  await rpc('guarni_ingest',['fixture.buffet','595000000002','WhatsApp prueba','buffet']);
  const bq=await rpc('viejo_quote',['buffet',[{variant_id:'test',qty:1}]]);
  const bc={...cart,service:'buffet',items:bq.items};
  await db.query('update guarni_conversations set cart=$1 where id=$2',[bc,incoming.conversation_id]);
  token=uid();job=await rpc('guarni_claim',[token]);
  const buffet=await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,bc,'','submit']);
  assert.equal(buffet.order.subtotal,null);assert.equal(buffet.order.group_id,null);
  assert.equal((await one('select mode from guarni_conversations where id=$1',[incoming.conversation_id])).mode,'human');
  await db.exec('set role authenticated');
  assert.equal((await one('select count(*)::int n from guarni_orders')).n,0);
  await assert.rejects(()=>rpc('viejo_staff',[actor,'take',{id:chat}]),/permission denied/);
  await db.exec('reset role');
  const {rows: history}=await db.query('select action,order_id,after_data from viejo_history where order_id in ($1,$2)',[pickupId,orderId]);
  for(const id of [pickupId,orderId])assert.ok(history.some(row=>row.order_id===id&&row.action==='order_status'&&row.after_data.status==='accepted'));
  assert.ok(history.some(row=>row.order_id===orderId&&row.action==='payment_status'&&row.after_data.payment_status==='paid'));
 }finally{await db.close();}
});
