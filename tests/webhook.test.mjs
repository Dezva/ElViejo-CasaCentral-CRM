import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import webhook from '../netlify/functions/whatsapp.mjs';
import api from '../netlify/functions/api.mjs';
import {whatsappDiagnostics} from '../netlify/lib/diagnostics.mjs';
const url='https://example.test/.netlify/functions/whatsapp';
test('Webhook: persiste antes de confirmar, filtra número y permite reintento ante fallo',async()=>{
 const savedFetch=globalThis.fetch,savedEnv={...process.env};
 Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-secret',META_APP_SECRET:'meta-secret',WHATSAPP_PHONE_NUMBER_ID:'phone-1',WORKER_SECRET:''});
 const body=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:'phone-1'},messages:[{from:'595000000101',id:'wamid.test',type:'text',text:{body:'hola'}}],contacts:[{wa_id:'595000000101',profile:{name:'Ana'}}]}}]}]});
 const signature='sha256='+createHmac('sha256','meta-secret').update(body).digest('hex');
 const request=()=>new Request(url,{method:'POST',body,headers:{'x-hub-signature-256':signature}});
 let count=0;
 try{
  globalThis.fetch=async(u,options)=>{count++;assert.match(u,/guarni_ingest$/);assert.equal(JSON.parse(options.body).p_body,'hola');return new Response('{"duplicate":false}',{status:200});};
  assert.equal((await webhook(new Request(url,{method:'POST',body,headers:{'x-hub-signature-256':'invalid'}}))).status,401);
  assert.equal(count,0);assert.equal((await webhook(request())).status,200);assert.equal(count,1);
  globalThis.fetch=async()=>new Response('{"message":"test failure"}',{status:500});
  assert.equal((await webhook(request())).status,503);
  process.env.WHATSAPP_PHONE_NUMBER_ID='another-phone';globalThis.fetch=async()=>{throw Error('No debería persistir un evento ajeno.');};
  assert.equal((await webhook(request())).status,200);
 }finally{globalThis.fetch=savedFetch;for(const key of Object.keys(process.env))if(!(key in savedEnv))delete process.env[key];Object.assign(process.env,savedEnv);}
});

test('Webhook: un Phone Number ID diferente no se guarda y queda identificado sin registrar el texto',async()=>{
 const previous={...process.env},oldFetch=globalThis.fetch,oldInfo=console.info,oldWarn=console.warn;const logs=[];
 try{
  Object.assign(process.env,{WHATSAPP_PHONE_NUMBER_ID:'111111',META_APP_SECRET:'test-app-secret',WORKER_SECRET:''});
  console.info=(...args)=>logs.push(args.join(' '));console.warn=console.info;
  globalThis.fetch=async()=>{throw Error('No debe invocar Supabase para otro número.');};
  const body=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:'222222'},messages:[{from:'595000000101',id:'test',type:'text',text:{body:'TEXTO_PRIVADO_DEL_CLIENTE'}}]}}]}]});
  const signature='sha256='+createHmac('sha256','test-app-secret').update(body).digest('hex');
  const response=await webhook(new Request(url,{method:'POST',body,headers:{'x-hub-signature-256':signature}}));
  assert.equal(response.status,200);assert.equal((await response.json()).ignored_numbers,1);
  assert.match(logs.join('\n'),/whatsapp_number_mismatch/);assert.doesNotMatch(logs.join('\n'),/TEXTO_PRIVADO_DEL_CLIENTE|test-app-secret|595000000101/);
 }finally{globalThis.fetch=oldFetch;console.info=oldInfo;console.warn=oldWarn;for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}
});

test('Diagnóstico: requiere sesión y administrador antes de consultar Meta',async()=>{
 const previous={...process.env},oldFetch=globalThis.fetch;let calls=0;
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-database-secret'});
  globalThis.fetch=async endpoint=>{calls++;if(endpoint.includes('/auth/v1/user'))return new Response('{"id":"test-user"}');if(endpoint.includes('crm_members'))return new Response('[{"user_id":"test-user","role":"member"}]');throw Error('No debe consultar Meta.');};
  assert.equal((await api(new Request('https://example.test/api?diagnostics=whatsapp'))).status,401);assert.equal(calls,0);
  assert.equal((await api(new Request('https://example.test/api?diagnostics=whatsapp',{headers:{authorization:'Bearer test-user-session'}}))).status,403);assert.equal(calls,2);
 }finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}
});

test('Diagnóstico: consulta número y registros con GET, sin enviar mensajes ni exponer secretos',async()=>{
 const previous={...process.env},oldFetch=globalThis.fetch;const calls=[];
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-database-secret',WHATSAPP_TOKEN:'test-whatsapp-secret',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_VERSION:'v25.0',BOT_ENABLED:'true'});
  globalThis.fetch=async(endpoint,options={})=>{
   calls.push(endpoint);assert.ok(!options.method||options.method==='GET');assert.doesNotMatch(endpoint,/test-whatsapp-secret|test-database-secret/);
   if(endpoint.startsWith('https://graph.facebook.com/')){assert.equal(options.headers.authorization,'Bearer test-whatsapp-secret');return new Response('{"id":"123456","display_phone_number":"+595 000000101","verified_name":"Guarnipitan prueba"}');}
   if(endpoint.includes('direction=eq.inbound'))return new Response('[{"created_at":"2026-11-08T20:00:00Z"}]');
   if(endpoint.includes('guarni_jobs'))return new Response('[{"status":"pending","attempts":1}]');
   if(endpoint.includes('direction=eq.outbound'))return new Response('[{"created_at":"2026-11-08T20:01:00Z","status":"failed","error":"test-whatsapp-secret"}]');
   throw Error('Ruta inesperada');
  };
  const result=await whatsappDiagnostics();assert.equal(result.meta.ok,true);assert.equal(result.phone_number_id,'123456');assert.equal(result.queue.pending,1);assert.equal(result.inbound.last_received_at,'2026-11-08T20:00:00Z');assert.equal(calls.length,4);assert.doesNotMatch(JSON.stringify(result),/test-whatsapp-secret|test-database-secret/);
 }finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}
});

test('Diagnóstico: conserva el código de Meta y elimina credenciales del mensaje de error',async()=>{
 const previous={...process.env},oldFetch=globalThis.fetch;
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-database-secret',WHATSAPP_TOKEN:'test-whatsapp-secret',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_GRAPH_VERSION:'v25.0'});
  globalThis.fetch=async endpoint=>endpoint.startsWith('https://graph.facebook.com/')?new Response('{"error":{"code":190,"message":"Invalid token test-whatsapp-secret"}}',{status:401}):new Response('[]');
  const result=await whatsappDiagnostics();assert.equal(result.meta.ok,false);assert.equal(result.meta.code,190);assert.equal(result.meta.http_status,401);assert.doesNotMatch(JSON.stringify(result),/test-whatsapp-secret/);
 }finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}
});

test('GET público del webhook no se anuncia como prueba de entrega de mensajes',async()=>{
 const response=await webhook(new Request(url));const result=await response.json();assert.equal(result.diagnostics_version,1);assert.match(result.note,/POST desde Meta/);
});
