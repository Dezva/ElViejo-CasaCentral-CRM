import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {mapsUrl,copyLocationLink,validPoint,parseLocationMessage,locationRequest} from '../shared/locations.js';
import {emptyCart,reduceOrder,demoCommand,money,subtotal} from '../shared/order-engine.js';
import webhook from '../netlify/functions/whatsapp.mjs';
import api from '../netlify/functions/api.mjs';
import {runWorker} from '../netlify/lib/worker.mjs';
const point={id:randomUUID(),latitude:-25.509215,longitude:-57.5601,name:'Mi casa',address:'Calle de prueba',received_at:'2026-11-15T14:00:00Z'};
const catalog=[{id:'kikito',name:'Kikito',variant:'Base',category:'Sándwiches',price:39500,available:true}];
function quote(fulfillment='delivery',extra={}){
 return reduceOrder({text:'un Kikito',cart:{...emptyCart('Ana'),...extra},catalog,command:{intent:'update_cart',items:[{variant_id:'kikito',qty:2,notes:'Sin tomate'}],fulfillment,address:'Calle de prueba',payment:'a_coordinar'}});
}
function restore(previous){for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}

test('Ubicaciones: extrae el punto con nombres opcionales y admite los límites geográficos',()=>{
 const parsed=parseLocationMessage({type:'location',location:point});
 assert.equal(parsed.content_type,'location');assert.equal(parsed.location.latitude,point.latitude);assert.equal(parsed.location.longitude,point.longitude);assert.equal(parsed.location.name,'Mi casa');
 assert.equal(validPoint({latitude:0,longitude:0}),true);assert.equal(validPoint({latitude:-90,longitude:180}),true);
 assert.equal(parseLocationMessage({type:'location',location:{latitude:'-25.5',longitude:'-57.5'}}).location.latitude,-25.5);
});
test('Ubicaciones: rechaza coordenadas vacías, fuera de rango, infinitas y tipos inválidos',()=>{
 for(const latitude of [undefined,null,'',true,{},NaN,Infinity,-Infinity,90.01,-90.01,'0x10'])assert.equal(validPoint({...point,latitude}),false);
 for(const longitude of [null,'',true,180.01,-180.01,Infinity])assert.equal(validPoint({...point,longitude}),false);
 assert.equal(parseLocationMessage({type:'location',location:{latitude:91,longitude:0}}).content_type,'invalid_location');
 assert.equal(mapsUrl({latitude:91,longitude:0}),null);
});
test('Ubicaciones: distingue las señales explícitas de tiempo real sin iniciar seguimiento',()=>{
 for(const message of [{type:'live_location',location:point},{type:'location',location:{...point,is_live:true}},{type:'location',location:{...point,live_period:900}}]){
  const result=parseLocationMessage(message);assert.equal(result.content_type,'live_location');assert.equal(result.location,null);
 }
});
test('Maps: enlace completo con coordenadas reales y copia confirmada por el portapapeles',async()=>{
 const expected='https://www.google.com/maps/search/?api=1&query=-25.509215%2C-57.5601';
 assert.equal(mapsUrl(point),expected);let copied;
 assert.equal(await copyLocationLink(point,{writeText:async text=>{copied=text;}}),expected);assert.equal(copied,expected);
 await assert.rejects(()=>copyLocationLink(point,{writeText:async()=>{throw Error('denied');}}),/no permitió copiar/);
 await assert.rejects(()=>copyLocationLink({latitude:NaN,longitude:0},{writeText:async()=>assert.fail()}),/válidas/);
});
test('Delivery: pide modalidad una vez y no exige ubicación para retiro',()=>{
 const unknown=quote('a_coordinar');assert.match(unknown.reply,/retirar en el local o para delivery/);
 const repeated=reduceOrder({text:'resumen',cart:unknown.cart,catalog,command:{intent:'summary'}});assert.doesNotMatch(repeated.reply,/retirar en el local o para delivery/);
 const pickup=quote('retiro');assert.doesNotMatch(pickup.reply,/enviame tu ubicación/);
 assert.equal(reduceOrder({text:'CONFIRMAR PEDIDO',cart:pickup.cart,catalog}).kind,'submit');
 assert.equal(reduceOrder({text:'CONFIRMAR PEDIDO',cart:unknown.cart,catalog}).kind,'reply');
});
test('Delivery: confirmación sin punto conserva carrito, notas y datos y solicita ubicación',()=>{
 const quoted=quote(),before=structuredClone(quoted.cart);assert.match(quoted.reply,/ubicación actual/);
 const result=reduceOrder({text:'CONFIRMAR PEDIDO',cart:quoted.cart,catalog});
 assert.equal(result.kind,'reply');assert.equal(result.reply,locationRequest);assert.deepEqual(result.cart.items,before.items);assert.equal(result.cart.address,before.address);assert.equal(result.cart.customer_name,'Ana');assert.doesNotMatch(result.reply,/registrad/);
 const valid=reduceOrder({text:'CONFIRMAR PEDIDO',cart:{...result.cart,delivery_location_id:point.id},catalog});assert.equal(valid.kind,'submit');
});
test('Delivery: cambios de modalidad y ubicación anticipada respetan el borrador activo',()=>{
 const pickup=quote('retiro');
 const delivery=reduceOrder({text:'delivery',cart:pickup.cart,catalog,command:{intent:'summary',fulfillment:'delivery'}});assert.match(delivery.reply,/ubicación actual/);
 const repeat=reduceOrder({text:'resumen',cart:delivery.cart,catalog,command:{intent:'summary'}});assert.doesNotMatch(repeat.reply,/enviame tu ubicación/);
 const back=reduceOrder({text:'retiro',cart:delivery.cart,catalog,command:{intent:'summary',fulfillment:'retiro'}});assert.doesNotMatch(back.reply,/enviame tu ubicación/);assert.equal(reduceOrder({text:'CONFIRMAR PEDIDO',cart:back.cart,catalog}).kind,'submit');
 assert.doesNotMatch(quote('delivery',{delivery_location_id:point.id}).reply,/enviame tu ubicación/);
 assert.equal(emptyCart().delivery_location_id,null);
 const preserved=reduceOrder({text:'otra consulta',cart:pickup.cart,catalog,command:{intent:'help',fulfillment:'a_coordinar'}});assert.equal(preserved.cart.fulfillment,'retiro');
});
test('Webhook: punto firmado se guarda por RPC estructurada, sin texto de archivo ni coordenadas en logs',async()=>{
 const previous={...process.env},savedFetch=globalThis.fetch,oldInfo=console.info,oldWarn=console.warn;const logs=[],saved=[];
 try{
  Object.assign(process.env,{META_APP_SECRET:'app-secret',WHATSAPP_PHONE_NUMBER_ID:'123',WORKER_SECRET:'',SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-secret'});
  console.info=(...args)=>logs.push(args.join(' '));console.warn=console.info;
  globalThis.fetch=async(endpoint,options)=>{
    if(endpoint.includes('guarni_settings?'))return Response.json([{config:{bot_enabled:true}}]);assert.match(endpoint,/guarni_ingest_location$/);saved.push(JSON.parse(options.body));return Response.json({duplicate:saved.length>1});};
  const payload=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:'123'},messages:[{type:'location',from:'595000000101',id:'wamid.location',timestamp:'1794747600',location:point}]}}]}]});
  const signed=()=>new Request('https://example.test/whatsapp',{method:'POST',body:payload,headers:{'x-hub-signature-256':'sha256='+createHmac('sha256','app-secret').update(payload).digest('hex')}});
  assert.equal((await (await webhook(signed())).json()).accepted,1);assert.equal((await (await webhook(signed())).json()).duplicates,1);
  assert.equal(saved[0].p_external,'wamid.location');assert.equal(saved[0].p_location.latitude,point.latitude);assert.equal(saved[0].p_location.longitude,point.longitude);assert.equal(saved[0].p_content_type,'location');assert.equal(saved[0].p_timestamp,'1794747600');assert.equal(saved[0].p_body,undefined);
  assert.doesNotMatch(logs.join(' '),/-25\.509215|-57\.5601|Mi casa|app-secret/);
  globalThis.fetch=async()=>Response.json({message:'temporary database failure'},{status:503});
  assert.equal((await webhook(signed())).status,503);
 }finally{globalThis.fetch=savedFetch;console.info=oldInfo;console.warn=oldWarn;restore(previous);}
});
test('Worker: ubicaciones válidas, inválidas y de tiempo real evitan IA y conservan atención humana',async()=>{
 const previous={...process.env},savedFetch=globalThis.fetch;
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-secret',BOT_ENABLED:'true'});
  for(const type of ['location','invalid_location','live_location'])for(const mode of ['bot','human']){
   let claimed=false,processed=false;
   globalThis.fetch=async(endpoint,options)=>{
    if(endpoint.includes('guarni_settings?'))return Response.json([{config:{bot_enabled:true}}]);
    if(endpoint.endsWith('guarni_claim')){if(claimed)return Response.json(null);claimed=true;return Response.json({kind:'inbound',job:{id:'job-id'},conversation:{id:'chat-id',mode,cart:emptyCart()},message:{content_type:type,body:'Ubicación puntual recibida.'}});}
    assert.match(endpoint,/guarni_process_location$/);assert.equal(JSON.parse(options.body).p_job,'job-id');processed=true;return Response.json({association:'draft'});
   };
   assert.equal(await runWorker(),1);assert.equal(processed,true);
  }
 }finally{globalThis.fetch=savedFetch;restore(previous);}
});
test('API: las ubicaciones requieren sesión y se unen a mensajes antiguos en su página correcta',async()=>{
 const previous={...process.env},savedFetch=globalThis.fetch;const chat=randomUUID(),messageId=randomUUID();let reads=0;
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-secret'});
  globalThis.fetch=async endpoint=>{
   reads++;
   if(endpoint.includes('/auth/v1/user'))return Response.json({id:'member'});
   if(endpoint.includes('crm_members?'))return Response.json([{user_id:'member',role:'member'}]);
   if(endpoint.includes('guarni_messages?')){assert.match(endpoint,/before|created_at.lt/);return Response.json([{id:messageId,conversation_id:chat,body:'Ubicación puntual recibida.',created_at:'2026-11-01T12:00:00Z'}]);}
   assert.match(endpoint,/guarni_locations\?message_id=in/);return Response.json([{...point,message_id:messageId}]);
  };
  assert.equal((await api(new Request('https://example.test/api?location_orders='+point.id))).status,401);assert.equal(reads,0);
  const response=await api(new Request('https://example.test/api?conversation_id='+chat+'&before=2026-11-02T12:00:00Z&before_id='+randomUUID(),{headers:{authorization:'Bearer session'}}));
  assert.equal(response.status,200);const data=await response.json();assert.equal(data.messages[0].location.latitude,point.latitude);
 }finally{globalThis.fetch=savedFetch;restore(previous);}
});
test.skip('No aplicable: contrato de la UI anterior sustituida — Interfaz: tarjeta, apertura de Maps, botón de copia y ubicación en detalle y aceptación',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',className:'',showModal(){},close(){},classList:{toggle(){},remove(){}},scrollHeight:0,scrollTop:0,clientHeight:0});return elements.get(id);};
 const context={window:{},document:{getElementById:element,querySelectorAll:()=>[]},localStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID},setTimeout:()=>1,clearTimeout(){},structuredClone,Intl,Date,e,initials,searchText,mapsUrl,copyLocationLink,money,reduceOrder,demoCommand,emptyCart,subtotal};
 runInNewContext(source.slice(0,source.indexOf("document.addEventListener('click'")).replace(/^import .*;\r?\n/gm,'')+`
 catalog=[{id:'kikito',name:'Kikito',variant:'Base',price:39500,available:true}];state.data=seed();state.demo=true;
 globalThis.ui={state,locationCard,orderLocation,showOrder,transition,chats};`,context);
 const ui=context.ui,order=ui.state.data.orders[0];order.fulfillment='delivery';order.delivery_location=point;
 const card=ui.locationCard(point,true);assert.match(card,/Ubicación recibida/);assert.match(card,/target="_blank"/);assert.match(card,/data-copylocation/);assert.match(card,/query=-25\.509215%2C-57\.5601/);assert.doesNotMatch(card,/verificad/i);
 const bad=ui.locationCard({...point,latitude:100});assert.doesNotMatch(bad,/google.com\/maps/);
 ui.showOrder(order.id);assert.match(element('dialogBody').innerHTML,/Ubicación de entrega · Recibida/);
 ui.transition(order.id,'accepted');assert.match(element('dialogBody').innerHTML,/Ubicación recibida/);assert.match(element('dialogBody').innerHTML,/value="delivery" selected/);
 order.delivery_location=null;assert.match(ui.orderLocation(order),/todavía no tiene una ubicación/);
 const chat=ui.state.data.conversations[0];ui.state.selectedChat=chat.id;ui.state.messages=[{id:'point-message',location:point,direction:'inbound',actor:'customer',body:'Ubicación puntual recibida.',created_at:point.received_at,status:'received'}];assert.match(ui.chats(),/data-copylocation/);
 assert.match(source,/copyLocationLink\(findLocation\(b.dataset.copylocation\)\);toast\('Enlace de ubicación copiado'\)/);
});


test('API: asignar ubicaciones utiliza el integrante validado y conserva la aprobación y versión esperada',async()=>{
 const previous={...process.env},savedFetch=globalThis.fetch;const order=randomUUID(),location=randomUUID(),expected=randomUUID();let saved;
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-secret'});
  globalThis.fetch=async(endpoint,options={})=>{
   if(endpoint.includes('guarni_settings?'))return Response.json([{config:{bot_enabled:true}}]);
   if(endpoint.includes('/auth/v1/user'))return Response.json({id:'verified-member'});
   if(endpoint.includes('crm_members?'))return Response.json([{user_id:'verified-member',role:'member'}]);
   assert.match(endpoint,/guarni_assign_location$/);saved=JSON.parse(options.body);return Response.json({ok:true});
  };
  const response=await api(new Request('https://example.test/api',{method:'POST',headers:{authorization:'Bearer session'},body:JSON.stringify({action:'assign_location',data:{order_id:order,location_id:location,expected_location_id:expected,approve:false,p_actor:'forged-admin'}})}));
  assert.equal(response.status,200);assert.deepEqual(saved,{p_actor:'verified-member',p_order:order,p_location:location,p_expected:expected,p_approve:false});
 }finally{globalThis.fetch=savedFetch;restore(previous);}
});

test('Worker: las respuestas de modalidad conservan productos sin IA y los fallos de ubicación se reintentan',async()=>{
 const previous={...process.env},savedFetch=globalThis.fetch;
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-secret',BOT_ENABLED:'true'});
  let claimed=false,finished;
  globalThis.fetch=async(endpoint,options={})=>{
   if(endpoint.includes('guarni_settings?'))return Response.json([{config:{bot_enabled:true}}]);
   if(endpoint.endsWith('guarni_claim')){if(claimed)return Response.json(null);claimed=true;return Response.json({kind:'inbound',job:{id:'job'},conversation:{id:'chat',mode:'bot',revision:0,client_id:'client',cart:{...quote('retiro').cart,service:'chiperia'}},message:{content_type:'text',body:'delivery'}});}
   if(endpoint.includes('guarni_catalog?'))return Response.json(catalog.map(p=>({...p,service:'chiperia'})));
   if(endpoint.includes('viejo_menus?')||endpoint.includes('viejo_catalog_categories?'))return Response.json([]);
   if(endpoint.includes('guarni_settings?'))return Response.json([{config:{bot_enabled:true}}]);
   if(endpoint.includes('crm_clients?'))return Response.json([{name:'Ana'}]);
   assert.match(endpoint,/guarni_finish$/);finished=JSON.parse(options.body);return Response.json({ok:true});
  };
  await runWorker();assert.equal(finished.p_cart.items.length,1);assert.equal(finished.p_cart.items[0].qty,2);assert.equal(finished.p_cart.fulfillment,'delivery');assert.match(finished.p_body,/ubicación puntual/);
  claimed=false;let retried=false;
  globalThis.fetch=async(endpoint,options={})=>{
   if(endpoint.includes('guarni_settings?'))return Response.json([{config:{bot_enabled:true}}]);
   if(endpoint.endsWith('guarni_claim')){if(claimed)return Response.json(null);claimed=true;return Response.json({kind:'inbound',job:{id:'recoverable-job'},conversation:{id:'chat',mode:'bot'},message:{content_type:'location',body:'Ubicación puntual recibida.'}});}
   if(endpoint.endsWith('guarni_process_location'))return Response.json({message:'temporary_failure'},{status:503});
   assert.match(endpoint,/guarni_retry$/);assert.equal(JSON.parse(options.body).p_job,'recoverable-job');retried=true;return Response.json(null);
  };
  await runWorker();assert.equal(retried,true);
 }finally{globalThis.fetch=savedFetch;restore(previous);}
});
