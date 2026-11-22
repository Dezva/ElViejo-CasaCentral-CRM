import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID as uid} from 'node:crypto';import {databaseV11,mockEnvironment,restBridge} from './v11-helpers.mjs';
import {runWorker} from '../netlify/lib/worker.mjs';import api from '../netlify/functions/api.mjs';
import {localDate,reduceOrder,activeCatalog,emptyCart} from '../shared/viejo-engine.js';
const publish=(items,day=localDate())=>({id:uid(),day,status:'published',reviewed:true,items});
const dish={id:'buffet-fixture',name:'Plato ficticio de prueba',category_id:'guarniciones',available:true};

test('V1.1 SQL + worker: deliveries consecutivos, pausa, reactivación, A/B, cancelación y rechazo de otro servicio',async t=>{
 const ctx=await databaseV11(),restore=mockEnvironment(),original=globalThis.fetch;const {db,rpc,one,staff,admin}=ctx;
 try{
  await db.exec("update guarni_settings set config=jsonb_set(config,'{bot_enabled}','true')");
  await staff('menu',publish([dish]));
  const bridge=restBridge(ctx);globalThis.fetch=bridge.fetch;
  let seq=0;
  const inbound=async(wa,text)=>{await rpc('guarni_ingest',['wamid.v11.'+uid(),wa,'Prueba',text]);await runWorker();};
  async function prepare(chat,service){const items=service==='buffet'?[{variant_id:dish.id,qty:1}]:[{variant_id:'tradicional-base',qty:3}];const q=await rpc('viejo_quote',[service,items]);await db.query('update guarni_conversations set cart=$1 where id=$2',[{...emptyCart('Prueba',service),...q,fulfillment:'delivery',quoted:true,address:'Referencia ficticia'},chat]);}
  async function location(wa,n){await rpc('guarni_ingest_location',['wamid.point.'+uid(),wa,'Prueba',{latitude:-25-n/100,longitude:-57},'location']);await runWorker();return (await one('select draft_location_id from guarni_conversations where wa_id=$1',[wa])).draft_location_id;}
  for(const [first,second] of [['buffet','buffet']])await t.test(first+' → '+second,async()=>{
   const wa='595000010'+String(++seq).padStart(3,'0');await inbound(wa,'hola');const chat=(await one('select id from guarni_conversations where wa_id=$1',[wa])).id;
   await prepare(chat,first);const a=await location(wa,seq);assert.ok(a);
   await inbound(wa,'CONFIRMAR PEDIDO');let orders=(await db.query('select * from guarni_orders where conversation_id=$1 order by number',[chat])).rows;
   assert.equal(orders.length,1);assert.equal(orders[0].delivery_location_id,a);
   const c=await one('select * from guarni_conversations where id=$1',[chat]);assert.equal(c.draft_location_id,null);assert.deepEqual(c.cart.items,[]);assert.equal(c.cart.delivery_location_id,null);
   const saved=bridge.calls.filter(c=>c.path.endsWith('guarni_finish')&&c.body.p_kind==='submit').at(-1).body;
   assert.equal((await rpc('guarni_finish',Object.values(saved))).duplicate,true);
   await staff('take',{id:chat});await staff('release',{id:chat});
   await prepare(chat,second);await inbound(wa,'CONFIRMAR PEDIDO');assert.equal((await one('select count(*)::int n from guarni_orders where conversation_id=$1',[chat])).n,1);
   const b=await location(wa,seq+10);assert.notEqual(b,a);await inbound(wa,'CONFIRMAR PEDIDO');
   orders=(await db.query('select * from guarni_orders where conversation_id=$1 order by number',[chat])).rows;
   assert.equal(orders.length,2);assert.equal(orders[0].delivery_location_id,a);assert.equal(orders[1].delivery_location_id,b);
   assert.equal((await one('select count(*)::int n from guarni_order_locations where order_id in ($1,$2)',orders.map(o=>o.id))).n,2);
   if(first!==second)assert.equal(orders[0].group_id,orders[1].group_id);
   await staff('take',{id:chat});await staff('release',{id:chat});await prepare(chat,'buffet');await location(wa,seq+20);
   await inbound(wa,'retiro');assert.equal((await one('select draft_location_id from guarni_conversations where id=$1',[chat])).draft_location_id,null);
   await inbound(wa,'delivery');await inbound(wa,'CONFIRMAR PEDIDO');assert.equal((await one('select count(*)::int n from guarni_orders where conversation_id=$1',[chat])).n,2);
   await location(wa,seq+30);await inbound(wa,'/cancelar');const cancelled=await one('select * from guarni_conversations where id=$1',[chat]);assert.equal(cancelled.draft_location_id,null);assert.equal(cancelled.cart.items.length,0);
   await prepare(chat,'buffet');await location(wa,seq+40);await inbound(wa,'chipería');assert.ok((await one('select draft_location_id from guarni_conversations where id=$1',[chat])).draft_location_id);
  });
 }finally{globalThis.fetch=original;restore();await db.close();}
});

test('V1.1 integración CRM API → PostgreSQL → worker: menú A/B vigente en la MISMA conversación y agotados',async()=>{
 const ctx=await databaseV11(),restore=mockEnvironment(),original=globalThis.fetch;const {db,rpc,one,editor}=ctx;
 try{
  await db.exec("update guarni_settings set config=jsonb_set(config,'{bot_enabled}','true')");
  const bridge=restBridge(ctx,{actor:editor});globalThis.fetch=bridge.fetch;
  const viaCRM=async items=>{const r=await api(new Request('https://crm.test/api',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({action:'menu',data:publish(items)})}));assert.equal(r.status,200,JSON.stringify(await r.clone().json()));};
  const a={...dish,id:'a',name:'Plato A de prueba'},b={...dish,id:'b',name:'Plato B de prueba'};
  const catBefore=(await db.query('select * from guarni_catalog order by id')).rows;
  await viaCRM([a]);const wa='595000000777';
  const say=async text=>{await rpc('guarni_ingest',['wamid.sync.'+uid(),wa,'Prueba',text]);await runWorker();return (await one("select body from guarni_messages where actor='bot' order by created_at desc,id desc limit 1")).body;};
  assert.match(await say('MENÚ'),/Plato A/);const chat=(await one('select * from guarni_conversations where wa_id=$1',[wa]));
  await viaCRM([a,b]);assert.match(await say('MENÚ'),/Plato B/);
  const q=await rpc('viejo_quote',['buffet',[{variant_id:'a',qty:1}]]);await db.query('update guarni_conversations set cart=$1 where id=$2',[{...emptyCart('Prueba','buffet'),...q,fulfillment:'retiro',quoted:true},chat.id]);
  await viaCRM([{...a,available:false},b]);const response=await say('MENÚ');assert.doesNotMatch(response,/Plato A/);assert.match(response,/Plato B/);
  assert.match(await say('CONFIRMAR PEDIDO'),/disponibilidad/);
  await assert.rejects(()=>rpc('viejo_quote',['buffet',[{variant_id:'a',qty:1}]]),/price_or_availability_changed/);
  await db.query('update guarni_conversations set cart=$1 where id=$2',[{...emptyCart('Prueba','buffet'),...q,fulfillment:'retiro',quoted:true},chat.id]);
  await rpc('guarni_ingest',['wamid.stale.'+uid(),wa,'Prueba','CONFIRMAR PEDIDO']);const token=uid(),job=await rpc('guarni_claim',[token]);
  await assert.rejects(()=>rpc('guarni_finish',[token,job.job.id,job.conversation.revision,job.conversation.cart,'','submit']),/price_or_availability_changed/);
  await rpc('guarni_finish',[token,job.job.id,job.conversation.revision,job.conversation.cart,'Revisión requerida','reply']);await runWorker();
  assert.equal((await one('select count(*)::int n from guarni_orders')).n,0);
  assert.match(await say('chipería'),/exclusivamente/);assert.match(await say('MENÚ'),/Plato B/);
  assert.deepEqual((await db.query('select * from guarni_catalog order by id')).rows,catBefore);
  assert.equal((await one('select count(*)::int n from guarni_conversations')).n,1);
  await db.query("update viejo_menus set status='archived' where status='published'");
  const yesterday=new Date(Date.now()-86400000);await ctx.staff('menu',publish([a],localDate(yesterday)));
  assert.match(await say('MENÚ'),/no hay menú.*hoy/);await assert.rejects(()=>rpc('viejo_quote',['buffet',[{variant_id:'a',qty:1}]]),/daily_menu_required/);
  assert.ok(bridge.calls.filter(c=>c.path.endsWith('viejo_menus')).every(c=>c.query.includes('select=id,day,status,items')));
 }finally{globalThis.fetch=original;restore();await db.close();}
});
