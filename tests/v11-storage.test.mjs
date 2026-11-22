import test from 'node:test';import assert from 'node:assert/strict';import {createHash,randomUUID as uid} from 'node:crypto';
import photoEndpoint from '../netlify/functions/menu-photo.mjs';import api from '../netlify/functions/api.mjs';import {mockEnvironment} from './v11-helpers.mjs';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=';
const bytes=Buffer.from(image.split(',')[1],'base64'),menuId=uid(),hash=createHash('sha256').update(bytes).digest('hex');
test('Storage privado simulado: upload autorizado idempotente, lectura autenticada, hash y conservación de legacy',async()=>{
 const restore=mockEnvironment(),saved=globalThis.fetch;let records=[],objects=new Map(),writes=0,publicBucket=false,menuPhoto=null;
 try{
  Object.assign(process.env,{MENU_PHOTO_STORAGE_ENABLED:'true',MENU_PHOTO_RETENTION_DAYS:'30'});
  globalThis.fetch=async(url,options={})=>{
   if(url.includes('/auth/v1/user'))return Response.json({id:'verified'});
   if(url.includes('crm_members?'))return Response.json([{user_id:'verified',role:'member',menu_editor:true}]);
   if(url.includes('/storage/v1/bucket/'))return Response.json({public:publicBucket});
   if(url.includes('/storage/v1/object/')){if(options.method==='POST'){writes++;assert.deepEqual(Buffer.from(options.body),bytes);assert.equal(options.headers['x-upsert'],'false');objects.set(url,Buffer.from(options.body));return Response.json({Key:'fixture'});}return new Response(objects.get(url),{headers:{'content-type':'image/png'}});}
   if(url.includes('viejo_menu_photos?')){if(options.method==='POST'){assert.equal(options.headers.prefer,'resolution=ignore-duplicates');records.push(JSON.parse(options.body));return Response.json(null);}return Response.json(records);}
   if(url.includes('viejo_menus?'))return Response.json([{photo_id:menuPhoto,image:menuPhoto?'':image}]);
   throw Error('Ruta inesperada: '+url);
  };
  const req=()=>new Request('https://crm.test/photo',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({image,created_by:'forged'})});
  let response=await photoEndpoint(req());assert.equal(response.status,200);const {photo_id}=await response.json();assert.ok(photo_id);assert.equal(records[0].created_by,'verified');assert.equal(records[0].hash,hash);assert.ok(records[0].expires_at);assert.ok(records[0].path.endsWith('.png'));
  assert.equal((await (await photoEndpoint(req())).json()).photo_id,photo_id);assert.equal(writes,1);
  const get=()=>photoEndpoint(new Request('https://crm.test/photo?menu_id='+menuId,{headers:{authorization:'Bearer fixture'}}));
  response=await get();assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes); // Legacy sin bucket, con misma foto original.
  menuPhoto=photo_id;response=await get();assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/private, no-store/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  assert.equal((await photoEndpoint(new Request('https://crm.test/photo?menu_id='+menuId))).status,401);
  publicBucket=true;assert.equal((await photoEndpoint(req())).status,409);assert.equal(writes,1);assert.equal((await get()).status,409);
  publicBucket=false;process.env.MENU_PHOTO_STORAGE_ENABLED='false';assert.equal((await photoEndpoint(req())).status,409);menuPhoto=null;assert.equal((await get()).status,200);
 }finally{globalThis.fetch=saved;restore();}
});
test('API general devuelve metadatos de menú sin Base64 ni claves/rutas privadas',async()=>{
 const restore=mockEnvironment(),saved=globalThis.fetch;let projected;
 try{
  globalThis.fetch=async(url)=>{
   if(url.includes('/auth/v1/user'))return Response.json({id:'verified'});
   if(url.includes('crm_members?'))return Response.json([{user_id:'verified',role:'member'}]);
   if(url.includes('viejo_menus?')){const fields=new URL(url).searchParams.get('select');projected=fields;const row={id:menuId,day:'2026-11-20',status:'published',items:[],image,photo_id:null,has_legacy_image:true};return Response.json([Object.fromEntries(fields.split(',').map(k=>[k,row[k]]))]);}
   if(url.includes('guarni_settings?'))return Response.json([{config:{}}]);return Response.json([]);
  };
  const response=await api(new Request('https://crm.test/api',{headers:{authorization:'Bearer fixture'}}));assert.equal(response.status,200);const body=await response.json();assert.equal(body.menus[0].has_legacy_image,true);assert.equal(body.menus[0].image,undefined);assert.doesNotMatch(projected,/(^|,)image(,|$)|path|hash/);assert.ok(!JSON.stringify(body).includes('base64'));
 }finally{globalThis.fetch=saved;restore();}
});
