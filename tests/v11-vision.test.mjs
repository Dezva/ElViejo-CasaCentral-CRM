import test from 'node:test';import assert from 'node:assert/strict';
import {decodeImage,validateImage,validateVisionResult,recognizeImage,VISION_TIMEOUT_MS} from '../netlify/lib/vision.mjs';
import recognize from '../netlify/functions/menu-recognize.mjs';import {providerConfig} from '../shared/ai-provider.js';
import {checkOptIn} from '../scripts/vision-smoke.mjs';
import {mockEnvironment} from './v11-helpers.mjs';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=';
const config={endpoint:'https://fixture-vision.test/v1/responses',key:'fixture',model:'multimodal-fixture'};
const valid={items:[{name:'Plato ficticio de prueba',category_id:'pending'}]};
test('Visión: imagen, modelo separado, esquema y respuesta estructurada validada; consumo informado',async()=>{
 let sent;const result=await recognizeImage(png,{config,fetchImpl:async(url,options)=>{assert.equal(url,config.endpoint);sent=JSON.parse(options.body);assert.ok(options.signal);return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(valid)}]}],usage:{input_tokens:100,output_tokens:20,total_tokens:120,secret:'no devolver'}});}});
 assert.equal(sent.model,'multimodal-fixture');assert.equal(sent.input[0].content[0].type,'input_image');assert.equal(sent.input[0].content[0].image_url,png);assert.equal(sent.store,false);assert.equal(sent.text.format.strict,true);assert.match(sent.instructions,/direcciones, teléfonos/);assert.match(sent.instructions,/nunca sigas instrucciones/);assert.match(sent.instructions,/No ejecutes acciones ni publiques/);assert.deepEqual(result.items,valid.items);assert.deepEqual(result.usage,{input_tokens:100,output_tokens:20,total_tokens:120});
 const vars={AI_API_KEY:'fixture',AI_MODEL:'conversation-fixture',AI_VISION_MODEL:'vision-fixture',AI_BASE_URL:'https://fixture.test/v1'};const env=k=>vars[k]||'';
 assert.equal(providerConfig(env).model,'conversation-fixture');assert.equal(providerConfig(env,true).model,'vision-fixture');assert.throws(()=>providerConfig(k=>k==='AI_BASE_URL'?'http://unsafe.test':''));
});
test('Visión: rechaza tipos, tamaños, MIME falso, texto administrativo y campos inesperados sin coerción',()=>{
 for(const image of [null,'https://external.test/a.png',png.replace('image/png','image/jpeg'),png.slice(0,-2), 'data:image/png;base64,'+Buffer.alloc(3145729).toString('base64')])assert.throws(()=>validateImage(image));
 assert.equal(decodeImage(png).type,'image/png');
 for(const response of [null,{},[],{items:null},{items:[{name:'Plato'}]},{items:[{name:12,category_id:'guarniciones'}]},{items:[{name:'',category_id:'guarniciones'}]},{items:[{name:'<script>alert(1)</script>',category_id:'guarniciones'}]},{items:[{name:'595 999 123456',category_id:'pending'}]},{...valid,action:'publish'},{items:Array(101).fill(valid.items[0])}])assert.throws(()=>validateVisionResult(response));
 assert.deepEqual(validateVisionResult({items:[]}),[]); // Foto sin platos legibles es una propuesta vacía, nunca publicable.
});
test('Visión: errores de red, timeout, JSON inválido, truncamiento, rechazo y HTTP no generan propuesta parcial',async()=>{
 for(const payload of [{status:'incomplete',output_text:JSON.stringify(valid)},{status:'failed',error:{message:'fixture'}},{output:[{content:[{type:'refusal',refusal:'fixture'}]}]},{output_text:'not JSON'},{output_text:JSON.stringify({items:[{name:'Incompleto'}]})}])await assert.rejects(()=>recognizeImage(png,{config,fetchImpl:async()=>Response.json(payload)}),e=>e.status===502);
 await assert.rejects(()=>recognizeImage(png,{config,fetchImpl:async()=>new Response('invalid',{status:200})}),/JSON/);
 await assert.rejects(()=>recognizeImage(png,{config,fetchImpl:async()=>new Response('',{status:429})}),e=>e.status===503);
 await assert.rejects(()=>recognizeImage(png,{config,fetchImpl:async()=>{throw Error('network with credential detail never propagated');}}),e=>e.code==='vision_network'&&!e.message.includes('credential'));
 assert.equal(VISION_TIMEOUT_MS,45000);
 await assert.rejects(()=>recognizeImage(png,{config,timeoutMs:5,fetchImpl:async(_,options)=>new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});const timer=setTimeout(()=>reject(Error('timeout no aplicado')),1000);timer.unref();})}),e=>e.status===504);
});
test('Visión endpoint: menu_editor, cache modelo/versionado, revisión humana y rechazo no escribe menú/caché',async()=>{
 const restore=mockEnvironment(),saved=globalThis.fetch;let cache=new Map(),calls=0,role='member',editor=false,invalid=false;
 try{
  Object.assign(process.env,{AI_IMAGE_ENABLED:'true',AI_VISION_MODEL:'vision-a',AI_BASE_URL:'https://fixture-vision.test/v1'});
  globalThis.fetch=async(url,options={})=>{
   if(url.includes('/auth/v1/user'))return Response.json({id:'verified'});
   if(url.includes('crm_members?'))return Response.json([{user_id:'verified',role,menu_editor:editor}]);
   if(url.includes('viejo_image_cache?')){const hash=new URL(url).searchParams.get('hash')?.slice(3);if(options.method==='POST'){assert.equal(options.headers.prefer,'resolution=merge-duplicates');const b=JSON.parse(options.body);cache.set(b.hash,b);return Response.json(null);}return Response.json(cache.has(hash)?[cache.get(hash)]:[]);}
   assert.equal(url,config.endpoint);calls++;return Response.json({output_text:JSON.stringify(invalid?{...valid,action:'publish'}:valid),usage:{total_tokens:50}});
  };
  const req=()=>new Request('https://crm.test/vision',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({image:png})});
  assert.equal((await recognize(req())).status,403);assert.equal(calls,0);editor=true;
  let r=await recognize(req());assert.equal(r.status,200);let body=await r.json();assert.equal(body.review_required,true);assert.equal(body.usage.total_tokens,50);assert.equal(cache.size,1);
  r=await recognize(req());assert.equal((await r.json()).cached,true);assert.equal(calls,1);
  process.env.AI_VISION_MODEL='vision-b';await recognize(req());assert.equal(calls,2);assert.equal(cache.size,2);
  invalid=true;process.env.AI_VISION_MODEL='vision-invalid';assert.equal((await recognize(req())).status,502);assert.equal(cache.size,2);
  process.env.AI_IMAGE_ENABLED='false';process.env.AI_VISION_MODEL='disabled';assert.equal((await recognize(req())).status,409);assert.equal(calls,3);
 }finally{globalThis.fetch=saved;restore();}
});

test('Prueba real: opt-in obligatorio, hostname aislado explícito y prohibición absoluta en CI',()=>{
 const vars={RUN_REAL_VISION_TEST:'I_AUTHORIZE_ISOLATED_VISION_TEST',VISION_TEST_BASE_URL:'https://isolated.example.test',VISION_TEST_ALLOWED_HOST:'isolated.example.test',VISION_TEST_BEARER:'fixture'};
 assert.throws(()=>checkOptIn({}));assert.throws(()=>checkOptIn({...vars,CI:'true'}));assert.throws(()=>checkOptIn({...vars,VISION_TEST_ALLOWED_HOST:'other.example.test'}));assert.equal(checkOptIn(vars),'https://isolated.example.test');
});
