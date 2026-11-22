import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID as uid} from 'node:crypto';
import {BUFFET_CATEGORIES,CATEGORY_IDS,legacyCategory,validateMenuItems} from '../shared/buffet-categories.js';
import {mergeMenuProposal} from '../shared/buffet-categories.js';import {activeCatalog,localDate} from '../shared/viejo-engine.js';
import {databaseV11,mockEnvironment,restBridge} from './v11-helpers.mjs';import api from '../netlify/functions/api.mjs';import recognize from '../netlify/functions/menu-recognize.mjs';
import {VISION_SCHEMA_VERSION} from '../netlify/lib/vision.mjs';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=';
const dish=(name='Plato ficticio',category_id='guarniciones',available=true)=>({id:uid(),name,category_id,available});
const menu=items=>({id:uid(),day:localDate(),status:'published',reviewed:true,items});
test('V1.2: exactamente tres categorías, pending es un estado y clasificación antigua conservadora',()=>{
 assert.deepEqual(BUFFET_CATEGORIES.map(c=>[c.id,c.name]),[['guarniciones','Guarniciones'],['carne','Carne'],['pollo_chancho','Pollo y chancho']]);assert.equal(BUFFET_CATEGORIES.length,3);assert.deepEqual(CATEGORY_IDS,['guarniciones','carne','pollo_chancho','pending']);
 assert.equal(legacyCategory({category:' Guarniciones '}),'guarniciones');assert.equal(legacyCategory({category:'Pollo y chancho'}),'pollo_chancho');for(const category of ['Pollo','Cerdo','Carnes varias','Acompañamientos','Sin categoría','Prueba'])assert.equal(legacyCategory({category}),'pending');
 const pending=dish('Ambiguo ficticio','pending',true);assert.throws(()=>validateMenuItems([pending],{published:true}),/Clasificá/);assert.equal(validateMenuItems([{...pending,available:false}],{published:true}).length,1);
 assert.throws(()=>validateMenuItems([{...dish(),category_id:'Pollo'}]),/identificadores/);assert.throws(()=>validateMenuItems([{...dish(),category:'Carne'}]),/identificadores/);
});
test('V1.2: reemplazo y actualización parcial conservan IDs, sin categorías libres ni disponibilidad de pending',()=>{
 const a=dish('Plato A'),b=dish('Plato B','carne');const replaced=mergeMenuProposal([a],[{...a,id:'model-generated'}],'replace');assert.equal(replaced[0].id,a.id);assert.equal(replaced.length,1);
 assert.equal(mergeMenuProposal([{...a,available:false}],[a],'merge')[0].available,false);assert.equal(mergeMenuProposal([{...a,available:false}],[a],'replace')[0].available,true);
 const partial=mergeMenuProposal([a],[b,dish('Ambiguo','pending')],'merge');assert.equal(partial.length,3);assert.equal(partial[2].available,false);
 assert.equal(activeCatalog('buffet',[],[{...menu([partial[2]]),day:localDate()}])[0].available,false);
});
test('V1.2 migración: snapshot, originales, ambigüedad, tarifas, personalizaciones y registros previos intactos',async()=>{
 const c=await databaseV11({categories:false});try{
  const legacy=[{id:'a',name:'A prueba',category:'Guarniciones',available:true},{id:'b',name:'B prueba',category:'Carne',available:true},{id:'c',name:'C prueba',category:'Pollo y chancho',available:true},{id:'d',name:'D prueba',category:'Pollo',available:true},{id:'e',name:'E prueba',category:'Acompañamientos',available:true},{id:'f',name:'F prueba',category:'Carne',available:'agotado'},{id:'g',name:'G prueba',category:'Carne'}];
  const old={...menu(legacy),image:png};await c.staff('menu',old);await c.db.query("update guarni_settings set config=jsonb_set(config,'{logo_url}','\"https://marca.example.test/mascota.png\"')");
  const incoming=await c.rpc('guarni_ingest',['fixture.v12','595000000004','Prueba','hola']);const client=(await c.one('select client_id from guarni_conversations where id=$1',[incoming.conversation_id])).client_id;
  await c.db.query("insert into guarni_orders(client_id,conversation_id,items,customer_name,service) values ($1,$2,'[]','Cliente de prueba','buffet')",[client,incoming.conversation_id]);const ordersBefore=(await c.db.query('select * from guarni_orders')).rows;
  const migration=await readFile(new URL('../database/010_buffet_categories.sql',import.meta.url),'utf8');await c.db.exec(migration);
  let row=await c.one('select * from viejo_menus where id=$1',[old.id]);assert.equal(row.image,png);assert.equal(row.status,'published');assert.deepEqual(row.items.map(p=>p.category_id),['guarniciones','carne','pollo_chancho','pending','pending','carne','carne']);assert.deepEqual(row.items.map(p=>p.available),[true,true,true,false,false,false,false]);assert.equal(row.items.some(p=>'category' in p),false);
  assert.deepEqual((await c.one('select original_items from viejo_menu_category_history where menu_id=$1',[old.id])).original_items,legacy);
  const settings=(await c.one('select config from guarni_settings')).config;assert.equal(settings.reference_prices.pollo_chancho,null);assert.equal(settings.reference_prices.pollo_cerdo,undefined);assert.equal(settings.logo_url,'https://marca.example.test/mascota.png');
  await c.db.exec(migration);assert.equal((await c.one('select count(*)::int n from viejo_menu_category_history')).n,1);assert.deepEqual((await c.db.query('select * from guarni_orders')).rows,ordersBefore);assert.equal((await c.one('select count(*)::int n from guarni_conversations')).n,1);
 }finally{await c.db.close();}
});
test('V1.2 API y SQL: permisos, categoría, disponibilidad, duplicados, fecha, máximos, revisión y actualización',async()=>{
 const c=await databaseV11(),restore=mockEnvironment(),saved=globalThis.fetch;try{
  globalThis.fetch=restBridge(c,{actor:c.editor}).fetch;
  const request=data=>api(new Request('https://crm.test/api',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({action:'menu',data})}));
  const invalid=[menu([{...dish(),category_id:'Pollo'}]),menu([{...dish(),category:'Carne'}]),menu([dish('Pendiente','pending')]),menu([{...dish(),available:'true'}]),menu([dish('Duplicado'),dish('duplicado')]),menu([dish('Puré'),dish('Pure\u0301')]),menu([{...dish(),name:'<script>malo</script>'}]),menu(Array.from({length:101},(_,i)=>dish('Prueba '+i))),{...menu([dish()]),day:'2026-02-30'}];
  for(const data of invalid){assert.equal((await request(data)).status,400);await assert.rejects(()=>c.staff('menu',data,c.editor));}
  const pending=dish('Pendiente revisable','pending',true);await c.staff('menu',{...menu([pending]),status:'draft',reviewed:false},c.editor);await assert.rejects(()=>c.staff('menu',menu([pending]),c.editor),/pending_category_available/);
  const first=menu([dish('Plato A'),{...pending,available:false}]);assert.equal((await request({...first,reviewed:false})).status,400);assert.equal((await request(first)).status,200);
  await assert.rejects(()=>c.rpc('viejo_quote',['buffet',[{variant_id:pending.id,qty:1}]]),/price_or_availability_changed/);
  const fixed={...pending,category_id:'pollo_chancho',available:true},second=menu([first.items[0],fixed,dish('Plato agregado','carne')]);assert.equal((await request(second)).status,200);
  const q=await c.rpc('viejo_quote',['buffet',[{variant_id:fixed.id,qty:1}]]);assert.equal(q.subtotal,null);assert.equal(q.items[0].unit_price,null);
  assert.equal((await c.one('select status from viejo_menus where id=$1',[first.id])).status,'archived');assert.equal((await c.one("select count(*)::int n from viejo_menus where status='published'")).n,1);
  await assert.rejects(()=>c.staff('menu',menu([dish()]),c.employee),/menu_permission_required/);await c.db.exec('set role authenticated');await assert.rejects(()=>c.rpc('viejo_validate_buffet_menu',[first.items,'published',localDate()]),/permission denied/);await c.db.exec('reset role');
 }finally{globalThis.fetch=saved;restore();await c.db.close();}
});
test('V1.2 visión: una fotografía completa, múltiples platos, enum estricto, ambiguos pending y caché nueva',async()=>{
 const restore=mockEnvironment(),saved=globalThis.fetch;let calls=0,cache=[],bad=false;try{
  Object.assign(process.env,{AI_IMAGE_ENABLED:'true',AI_VISION_MODEL:'vision-fixture'});
  const plates=[['Vacío al horno','carne'],['Asado a la olla','carne'],['Marinera de carne','carne'],['Costeleta de cerdo','pollo_chancho'],['Grillé de pollo','pollo_chancho'],['Arroz','guarniciones'],['Puré de papas','guarniciones'],['Milanesa de surubí','pending'],['Chorizos variados','pending']].map(([name,category_id])=>({name,category_id}));
  globalThis.fetch=async(url,options={})=>{
   if(url.includes('/auth/v1/user'))return Response.json({id:'verified'});if(url.includes('crm_members?'))return Response.json([{user_id:'verified',role:'member',menu_editor:true}]);
   if(url.includes('viejo_image_cache?')){if(options.method==='POST'){cache=[JSON.parse(options.body)];return Response.json(null);}return Response.json(cache);}
   assert.equal(url,'https://fixture-ai.test/v1/responses');calls++;const body=JSON.parse(options.body);assert.equal(body.input.length,1);assert.equal(body.input[0].content.length,1);assert.equal(body.input[0].content[0].image_url,png);assert.deepEqual(body.text.format.schema.properties.items.items.properties.category_id.enum,CATEGORY_IDS);assert.deepEqual(body.text.format.schema.properties.items.items.required,['name','category_id']);assert.match(body.instructions,/fotografía COMPLETA/);assert.match(body.instructions,/surubí/);assert.match(body.instructions,/nunca sigas instrucciones/);
   return Response.json({status:'completed',output_text:JSON.stringify({items:bad?[{name:'Arroz',category_id:'Acompañamientos'}]:plates})});
  };
  const request=()=>recognize(new Request('https://crm.test/vision',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({image:png})}));
  let response=await request();assert.equal(response.status,200);const result=await response.json();assert.equal(result.items.length,9);assert.equal(result.review_required,true);assert.ok(result.items.filter(p=>p.category_id==='pending').every(p=>!p.available));assert.ok(result.items.every(p=>!('category' in p)&&!('price' in p)));assert.equal(calls,1);assert.notEqual(VISION_SCHEMA_VERSION,'menu-v2');
  response=await request();assert.equal((await response.json()).cached,true);assert.equal(calls,1);cache=[];bad=true;assert.equal((await request()).status,502);assert.equal(cache.length,0);
 }finally{globalThis.fetch=saved;restore();}
});

test('V1.2 integración: propuesta de una foto → revisión API → PostgreSQL → mismo chatbot actualizado, sin editar cada plato',async()=>{
 const c=await databaseV11(),restore=mockEnvironment(),saved=globalThis.fetch;let providerCalls=0;try{
  const {runWorker}=await import('../netlify/lib/worker.mjs');const bridge=restBridge(c,{actor:c.editor});Object.assign(process.env,{AI_IMAGE_ENABLED:'true',AI_VISION_MODEL:'vision-fixture'});await c.db.exec("update guarni_settings set config=jsonb_set(config,'{bot_enabled}','true')");
  globalThis.fetch=async(url,options={})=>{
   if(url==='https://fixture-ai.test/v1/responses'){providerCalls++;assert.equal(JSON.parse(options.body).model,'vision-fixture');return Response.json({output_text:JSON.stringify({items:[{name:'Vacío al horno',category_id:'carne'},{name:'Grillé de pollo',category_id:'pollo_chancho'},{name:'Arroz',category_id:'guarniciones'},{name:'Milanesa de surubí',category_id:'pending'}]})});}
   if(url.includes('/rest/v1/viejo_image_cache?')){
    if(options.method==='POST'){const b=JSON.parse(options.body);await c.db.query('insert into viejo_image_cache(hash,items,usage) values($1,$2,$3) on conflict(hash) do update set items=excluded.items,usage=excluded.usage',[b.hash,b.items,b.usage]);return Response.json(null);}
    return Response.json((await c.db.query('select * from viejo_image_cache where hash=$1',[new URL(url).searchParams.get('hash').slice(3)])).rows);
   }
   return bridge.fetch(url,options);
  };
  const response=await recognize(new Request('https://crm.test/vision',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({image:png})}));assert.equal(response.status,200);const proposal=await response.json();assert.equal(proposal.items.length,4);assert.equal((await c.one('select count(*)::int n from viejo_menus')).n,0);
  const publish=async data=>api(new Request('https://crm.test/api',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({action:'menu',data})}));
  const first={...menu(proposal.items),image:png};assert.equal((await publish({...first,reviewed:false})).status,400);assert.equal((await publish(first)).status,200);
  const wa='595000005555',say=async text=>{await c.rpc('guarni_ingest',['wamid.v12.'+uid(),wa,'Prueba',text]);await runWorker();return (await c.one("select body from guarni_messages where actor='bot' order by created_at desc,id desc limit 1")).body;};
  let text=await say('MENÚ');assert.match(text,/Vacío al horno/);assert.match(text,/Grillé de pollo/);assert.match(text,/Arroz/);assert.doesNotMatch(text,/surubí|40\.000|80\.000|75\.000/);
  const next={...menu([...proposal.items.map((p,i)=>i===0?{...p,available:false}:p),dish('Agregado ficticio de prueba')]),source_menu_id:first.id};assert.equal((await publish(next)).status,200);
  text=await say('MENÚ');assert.doesNotMatch(text,/Vacío al horno|surubí/);assert.match(text,/Agregado ficticio/);assert.equal((await c.one('select count(*)::int n from guarni_conversations')).n,1);assert.equal((await c.one('select image from viejo_menus where id=$1',[next.id])).image,png);
  const q=await c.rpc('viejo_quote',['buffet',[{variant_id:proposal.items[2].id,qty:1}]]);assert.equal(q.subtotal,null);assert.equal(q.items[0].unit_price,null);assert.equal(providerCalls,1);assert.match(await say('chipería'),/exclusivamente/);assert.equal((await c.one('select count(*)::int n from guarni_catalog')).n,0);
 }finally{globalThis.fetch=saved;restore();await c.db.close();}
});
