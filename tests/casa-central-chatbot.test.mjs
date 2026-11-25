import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {activeCatalog,defaults,emptyCart,localDate} from '../shared/viejo-engine.js';
import {interpret} from '../netlify/lib/conversation.mjs';
import {runWorker} from '../netlify/lib/worker.mjs';
import {databaseV11,mockEnvironment,restBridge} from './v11-helpers.mjs';

const dishes=[
 {id:'tallarin',name:'Tallarín',category_id:'guarniciones',available:true},
 {id:'milanesa',name:'Milanesa de pollo',category_id:'pollo_chancho',available:true},
 {id:'sopa',name:'Sopa paraguaya',category_id:'guarniciones',available:true},
 {id:'sopa-maiz',name:'Sopa de maíz',category_id:'guarniciones',available:true},
 {id:'bife',name:'Bife encebollado',category_id:'carne',available:false},
];
const menu=(items=dishes,day=localDate(),status='published')=>({id:randomUUID(),day,status,reviewed:status==='published',items});
const lines=cart=>cart.items.map(({variant_id,qty,notes})=>[variant_id,qty,notes]);
const answer=payload=>Response.json({status:'completed',output_text:JSON.stringify(payload)});

test('Casa Central registra un buffet conversacional en PostgreSQL sin importes automáticos',async t=>{
 const c=await databaseV11({casa:true});
 t.after(()=>c.db.close());
 t.after(mockEnvironment());
 const bridge=restBridge(c);
 let aiCalls=0,ai;
 t.mock.method(globalThis,'fetch',async (url,options)=>{
  if(new URL(url).hostname!=='fixture-ai.test')return bridge.fetch(url,options);
  aiCalls++;
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.redirect,'error');
  return ai(aiCalls);
 });
 const {config}=await c.one('select config from guarni_settings');
 await c.staff('settings',{config:{...config,bot_enabled:true,payment_methods:['Transferencia'],business_address:'Dirección de prueba 123',reference_prices:{guarniciones:43210}}});
 await c.staff('menu',menu([{...dishes[0],id:'ayer',name:'Cazuela histórica'}],'2020-12-01'));
 await c.staff('menu',menu([{...dishes[0],id:'draft',name:'Cazuela en borrador'}],localDate(),'draft'));
 await c.staff('menu',menu());
 let chat,phone='595000000143';
 const current=()=>c.one('select cart,mode,draft_location_id from guarni_conversations where id=$1',[chat]);
 const say=async(text,waId=randomUUID())=>{
  const inbound=await c.rpc('guarni_ingest',[waId,phone,'Prueba',text]);
  if(inbound.conversation_id)chat=inbound.conversation_id;
  await runWorker();
  const {n}=await c.one("select count(*)::int n from guarni_messages where conversation_id=$1 and direction='outbound'",[chat]);
  const {body}=await c.one("select body from guarni_messages where conversation_id=$1 and direction='outbound' order by created_at desc,id desc limit 1",[chat]);
  return {...await current(),body,n,duplicate:inbound.duplicate};
 };

 assert.doesNotMatch((await say('¿Qué tienen hoy?')).body,/histórica|en borrador|Bife/);
 let ordered=await say('Quiero dos tallarines.\nMilanesa 2, Sopa paraguaya 1');
 assert.deepEqual(lines(ordered.cart),[['tallarin',2,''],['milanesa',2,''],['sopa',1,'']]);
 const old=ordered.cart.items;
 const mixed=await say('Quiero dos milanesas de carne y una sopa paraguaya.');
 assert.match(mixed.body,/no encontré.*milanesa.*carne/i);
 assert.match(mixed.body,/pedido completo/);
 assert.deepEqual(mixed.cart.items,[]);
 assert.equal(mixed.mode,'bot');

 const ambiguousMenu=[...dishes,{...dishes[1],id:'otra-milanesa',name:'Milanesa pollo'}];
 await c.staff('menu',menu(ambiguousMenu));
 await say('Quiero dos tallarines');
 const ambiguous=await say('Quiero milanesa de pollo y sopa paraguaya');
 assert.match(ambiguous.body,/nombres que no puedo distinguir/);
 assert.match(ambiguous.body,/pedido completo/);
 assert.deepEqual(ambiguous.cart.items,[]);
 await c.staff('menu',menu());


 ordered=await say('Quiero una sopa sin cebolla y dos milanesas con poca sal.');
 assert.match(ordered.body,/¿Cuál preferís: .*Sopa paraguaya.*Sopa de maíz/);
 assert.deepEqual(ordered.cart.items,[]);
 ordered=await say('Sopa paraguaya');
 assert.deepEqual(lines(ordered.cart),[['milanesa',2,'con poca sal'],['sopa',1,'sin cebolla']]);
 assert.match(ordered.body,/2 × Milanesa de pollo · con poca sal/);
 assert.match(ordered.body,/1 × Sopa paraguaya · sin cebolla/);
 assert.doesNotMatch(ordered.body,/Gs\.|subtotal|milanesa.*id/i);
 assert.notDeepEqual(ordered.cart.items,old);
 for(const invalid of ['Quiero bife encebollado y tallarín','31 tallarines','Quiero 1,5 tallarines','Quiero -2 tallarines','Quiero 0 tallarines']){
  const failed=await say(invalid);
  assert.match(failed.body,/agotad|entre 1 y 30/);
  assert.match(failed.body,/pedido completo/);
  assert.deepEqual(failed.cart.items,[]);
 }

 await say('Talarin 2 y un tallarín');
 assert.deepEqual(lines((await current()).cart),[['tallarin',3,'']]);
 const increment='Agregame dos más';
 const incremented=await say(increment);
 assert.deepEqual(lines(incremented.cart),[['tallarin',5,'']]);
 assert.deepEqual((await say(increment)).cart,incremented.cart);
 await say('Al final quiero tres');
 await say('Bien caliente.');
 await say('Agregame dos milanesas con poca sal');
 const corrected=await say('Sacame las milanesas.');
 assert.deepEqual(lines(corrected.cart),[['tallarin',3,'Bien caliente']]);
 assert.deepEqual((await say('Sacame las milanesas.')).cart,corrected.cart);

 const selected=await say('Mandame a domicilio.');
 assert.equal(selected.cart.fulfillment,'delivery');
 assert.match(selected.body,/ubicación puntual/);
 assert.match((await say('CONFIRMAR PEDIDO')).body,/ubicación puntual/);
 const location={latitude:-25.3,longitude:-57.5};
 await c.rpc('guarni_ingest_location',[randomUUID(),phone,'Prueba',location,'location']);
 await runWorker();
 const before=(await current()).cart;
 assert.ok(before.delivery_location_id);
 let replies=(await c.one("select count(*)::int n from guarni_messages where conversation_id=$1 and direction='outbound'",[chat])).n;
 for(const [query,expected] of [
  ['Gracias.',/Gracias a vos/],['Muchas gracias.',/Gracias a vos/],['Perfecto.',/seguimos/],
  ['Hola quiero que me digas el menu del buffet',/Sopa paraguaya/],
  ['quiero el menu del día',/Sopa paraguaya/],
  ['??? quiero el menu de hoy',/Sopa paraguaya/],
  ['Quiero ver el menú de hoy',/Sopa paraguaya/],
  ['Hola, ¿me mostrás el menú de hoy, por favor?',/Sopa paraguaya/],
  ['¿Dónde están ubicados?',/Dirección de prueba 123/],
  ['¿Hasta qué hora atienden?',/Horario de atención pendiente/],['¿Tienen delivery?',/equipo.*delivery/],
  ['¿Puedo pagar por transferencia?',/Transferencia/],['¿Tienen tallarín?',/disponible/],
  ['¿Recibieron mi ubicación?',/Ya recibí tu ubicación/],['¿Cómo va mi pedido?',/borrador/],
  ['No quiero retiro',/retiro|retirar/],['Retiro no',/retiro|retirar/],['¿Es para llevar?',/retiro|retirar/],['Tienen delivery',/equipo.*delivery/],
 ]){
  const result=await say(query);
  assert.equal(result.n,++replies,query);
  assert.match(result.body,expected,query);
  assert.deepEqual(result.cart,before,query);
  assert.equal(result.mode,'bot',query);
 }
 const general=await say('Hola, ¿Cuáles son los precios por kilo?');
 assert.match(general.body,/43\.210 por kilo/);
 assert.match(general.body,/pendiente de confirmación/);
 const price=await say('del tallarin');
 assert.match(price.body,/Tallarín.*Guarniciones.*43\.210 por kilo/);
 const {reference_price_context:reference,...draft}=price.cart;
 assert.equal(reference,true);
 assert.deepEqual(draft,before);
 assert.equal(aiCalls,0);

 for(const provider of [
  () => Response.json({private:'secreto'}, {status:503}),
  () => {throw new DOMException('detalle-privado','TimeoutError');},
  () => Response.json({output_text:'inválido'}),
  () => answer({intent:'update_cart',items:[{variant_id:'inventado',qty:30}],fulfillment:'retiro',total:999999}),
 ]){
  ai=provider;
  const calls=aiCalls;
  const result=await say('Acerca de nuestra charla anterior');
  assert.equal(aiCalls-calls,2);
  assert.equal(result.mode,'bot');
  assert.deepEqual(result.cart,price.cart);
  assert.match(result.body,/borrador sigue guardado/);
  assert.doesNotMatch(result.body,/secreto|privado|999999|503|inventado/);
 }

 const beforeSticker=await say('Gracias');
 const sticker=await say('[Contenido sticker recibido]');
 assert.equal(sticker.n,beforeSticker.n);
 assert.deepEqual(sticker.cart,beforeSticker.cart);

 const pickup=await say('Es para llevar');
 assert.equal(pickup.cart.fulfillment,'retiro');
 assert.equal(pickup.draft_location_id,null);
 const uid=randomUUID(),sent=await say('CONFIRMAR PEDIDO',uid);
 assert.match(sent.body,/PENDIENTE DE ACEPTACIÓN/);
 assert.equal(sent.mode,'human');
 assert.equal((await say('CONFIRMAR PEDIDO',uid)).duplicate,true);
 const order=await c.one('select * from guarni_orders');
 assert.equal(order.fulfillment,'retiro');
 assert.equal(order.delivery_location_id,null);
 assert.equal(order.total,null);
 assert.equal(order.items[0].unit_price,null);
 assert.deepEqual(lines(order),[['tallarin',3,'Bien caliente']]);
 const paused=await say('Quiero dos tallarines');
 assert.equal(paused.n,sent.n);
 assert.equal((await c.one('select count(*)::int n from guarni_orders')).n,1);
 phone='595000000144';
 await say('Quiero dos tallarines');
 const handoff=await say('Quiero hablar con el encargado');
 assert.equal(handoff.mode,'human');
 assert.deepEqual(lines(handoff.cart),[['tallarin',2,'']]);
 assert.equal((await say('Agregame un tallarín')).n,handoff.n);
});

test('La validación de IA descarta equivalencias, datos de entrega, precios y observaciones inventadas',async t=>{
 t.after(mockEnvironment());
 const catalog=activeCatalog('buffet',[],[menu()]);
 const cart=emptyCart('Prueba');
 const input='Quiero 2 tallarines sin picante';
 const forged={intent:'update_cart',items:[{variant_id:'tallarin',qty:2,notes:'Total Gs. 999.999'}],address:'inventada',payment:'QR',fulfillment:'delivery',subtotal:999999};
 let model=forged,calls=0;
 t.mock.method(globalThis,'fetch',async(url)=>{
  if(new URL(url).hostname!=='fixture-ai.test')return Response.json(null);
  calls++;
  return answer(model);
 });
 const command=await interpret(input,cart,catalog,defaults);
 assert.deepEqual(command.items,[{variant_id:'tallarin',qty:2,notes:'sin picante'}]);
 for(const field of ['address','payment','fulfillment','subtotal'])assert.equal(command[field],undefined);
 for(const [variant_id,qty] of [['tallarin',3],['milanesa',2],['inexistente',2]]){
  model={...forged,items:[{variant_id,qty}]};
  const before=calls;
  await assert.rejects(interpret(input,cart,catalog,defaults),/commercial_equivalence_unconfirmed/);
  assert.equal(calls-before,2);
 }
});
