import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {emptyCart,reduceOrder} from '../shared/order-engine.js';
test('PostgreSQL: pedidos, atención humana y eliminación administrativa transaccional',async()=>{
 const db=new PGlite({initialMemory:128*1024*1024,postgresqlconf:'shared_buffers=16MB\nmax_connections=10'});
 const actor=randomUUID(),other=randomUUID(),outsider=randomUUID();
 try{
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
   create schema auth; create table auth.users(id uuid primary key,email text);
   create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   grant usage on schema auth to authenticated;
   grant execute on function auth.uid() to authenticated;`);
  for(const file of ['001_base_crm.sql','002_guarnipitan.sql','003_catalogo.sql','005_eliminacion_admin.sql','006_ubicaciones_delivery.sql'])await db.exec(await readFile(new URL(file==='003_catalogo.sql'?'./fixtures/legacy-catalog.sql':'../database/'+file,import.meta.url),'utf8'));
  // Reejecutar las migraciones debe conservar filas y reglas.
  await db.exec(await readFile(new URL('../database/002_guarnipitan.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../database/005_eliminacion_admin.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../database/006_ubicaciones_delivery.sql',import.meta.url),'utf8'));
  await db.query('insert into auth.users values ($1,$2),($3,$4),($5,$6)',[actor,'admin@example.test',other,'member@example.test',outsider,'outsider@example.test']);
  await db.query("insert into crm_members(user_id,display_name,role) values($1,'Admin','admin'),($2,'Member','member')",[actor,other]);
  const rpc=async(name,args)=>{const r=await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args);return r.rows[0].result;};
  const first=await rpc('guarni_ingest',['wamid.test.1','595000000101','Ana','2 Kikito']);
  const duplicate=await rpc('guarni_ingest',['wamid.test.1','595000000101','Ana','2 Kikito']);
  assert.equal(duplicate.duplicate,true);
  assert.equal((await db.query('select unread from guarni_conversations')).rows[0].unread,1);
  const cat=(await db.query('select * from guarni_catalog')).rows;
  const p=cat.find(x=>x.name==='Kikito');
  let token=randomUUID(),job=await rpc('guarni_claim',[token]);
  const quoted=reduceOrder({text:'2 Kikito',cart:emptyCart('Ana'),catalog:cat,command:{intent:'update_cart',items:[{variant_id:p.id,qty:2,notes:''}]}});
  await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,quoted.cart,quoted.reply,'reply']);
  token=randomUUID();job=await rpc('guarni_claim',[token]);assert.equal(job.kind,'send');
  await rpc('guarni_sent',[token,job.message.id,'sent','wamid.out.1',null]);
  await rpc('guarni_ingest',['wamid.test.2','595000000101','Ana','CONFIRMAR PEDIDO']);
  token=randomUUID();job=await rpc('guarni_claim',[token]);
  const created=await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,quoted.cart,'','submit']);
  assert.equal(created.order.status,'pending');assert.equal(created.order.subtotal,79000);assert.equal(created.order.total,null);
  await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,quoted.cart,'','submit']);
  assert.equal((await db.query('select count(*)::integer as n from guarni_orders')).rows[0].n,1);
  await assert.rejects(()=>rpc('guarni_staff',[outsider,'take',{id:first.conversation_id}]),/not_member/);
  await assert.rejects(()=>rpc('guarni_staff',[other,'catalog',{id:p.id,price:1,available:true}]),/admin_required/);
  await rpc('guarni_staff',[actor,'order_status',{id:created.order.id,status:'accepted',fulfillment:'retiro',shipping_fee:0,address:''}]);
  assert.equal((await db.query('select total from guarni_orders')).rows[0].total,79000);
  await assert.rejects(()=>rpc('guarni_staff',[actor,'order_status',{id:created.order.id,status:'accepted',fulfillment:'retiro',shipping_fee:0}]),/invalid_transition/);
  await rpc('guarni_staff',[other,'take',{id:first.conversation_id}]);
  await assert.rejects(()=>rpc('guarni_staff',[actor,'send',{id:first.conversation_id,body:'hola',request_id:randomUUID()}]),/take_conversation_first/);
  await rpc('guarni_staff',[other,'send',{id:first.conversation_id,body:'Atiende el equipo',request_id:randomUUID()}]);
  assert.equal((await db.query("select count(*)::integer as n from guarni_messages where actor='bot' and status='queued'")).rows[0].n,0);
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[outsider]);
  assert.equal((await db.query('select * from guarni_orders')).rows.length,0);
  await assert.rejects(()=>db.query("select public.guarni_ingest('x','595000000102','x','hola')"),/permission denied/);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);
  assert.equal((await db.query('select * from guarni_orders')).rows.length,1);
  await assert.rejects(()=>db.query("update guarni_orders set status='accepted'"),/permission denied/);
  await assert.rejects(()=>db.query('select public.guarni_delete($1,$2,$3,true)',[actor,'order',created.order.id]),/permission denied/);
  await assert.rejects(()=>db.query('delete from crm_clients'),/permission denied/);
  await db.exec('reset role');
  // Simular la identidad del servidor: tampoco permite borrar en nombre de un integrante común.
  await db.exec('set role service_role');
  await assert.rejects(()=>rpc('guarni_delete',[other,'order',created.order.id,true]),/admin_required/);
  await assert.rejects(()=>rpc('guarni_delete',[outsider,'order',created.order.id,true]),/not_member/);
  const preview=await rpc('guarni_delete',[actor,'order',created.order.id,false]);
  assert.equal(preview.orders,1);assert.equal(preview.messages,0);
  assert.equal((await db.query('select count(*)::integer as n from guarni_orders')).rows[0].n,1);
  const messagesBefore=(await db.query('select count(*)::integer as n from guarni_messages')).rows[0].n;
  await rpc('guarni_delete',[actor,'order',created.order.id,true]);
  assert.equal((await db.query('select count(*)::integer as n from guarni_orders')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::integer as n from guarni_messages')).rows[0].n,messagesBefore);
  assert.equal((await rpc('guarni_ingest',['wamid.test.2','595000000101','Ana','CONFIRMAR PEDIDO'])).duplicate,true);
  assert.equal((await rpc('guarni_delete',[actor,'order',created.order.id,true])).already_deleted,true);

  // Un cliente ajeno y su historial deben sobrevivir al borrado del cliente elegido.
  const keep=await rpc('guarni_ingest',['wamid.keep','595000000102','Otro cliente','hola']);
  const clientId=(await db.query('select client_id from guarni_conversations where id=$1',[first.conversation_id])).rows[0].client_id;
  await rpc('guarni_staff',[actor,'create_order',{request_id:randomUUID(),client_id:clientId,items:[{variant_id:p.id,qty:1,notes:''}]}]);
  const clientPreview=await rpc('guarni_delete',[actor,'client',clientId,false]);
  assert.equal(clientPreview.orders,1);assert.equal(clientPreview.conversations,1);assert.ok(clientPreview.messages>0);
  await db.query("update guarni_conversations set processing_until=now()+interval '1 minute' where id=$1",[first.conversation_id]);
  await assert.rejects(()=>rpc('guarni_delete',[actor,'client',clientId,true]),/processing_wait/);
  assert.equal((await db.query('select count(*)::integer as n from guarni_orders')).rows[0].n,1);
  await db.query('update guarni_conversations set processing_until=null where id=$1',[first.conversation_id]);
  await rpc('guarni_delete',[actor,'client',clientId,true]);
  for(const table of ['guarni_conversations','guarni_messages','guarni_jobs','guarni_orders']){
   const column=table==='guarni_conversations'?'id':'conversation_id';
   assert.equal((await db.query(`select count(*)::integer as n from ${table} where ${column}=$1`,[first.conversation_id])).rows[0].n,0);
  }
  assert.equal((await db.query('select count(*)::integer as n from crm_clients where id=$1',[clientId])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::integer as n from guarni_conversations where id=$1',[keep.conversation_id])).rows[0].n,1);
  assert.equal((await db.query("select count(*)::integer as n from guarni_audit where action in ('delete_client','delete_order')")).rows[0].n,2);
  const returning=await rpc('guarni_ingest',['wamid.returning','595000000101','Ana','hola de nuevo']);
  assert.notEqual(returning.conversation_id,first.conversation_id);
  assert.notEqual((await db.query('select client_id from guarni_conversations where id=$1',[returning.conversation_id])).rows[0].client_id,clientId);
  await db.exec('reset role');
 }finally{await db.close();}
});
