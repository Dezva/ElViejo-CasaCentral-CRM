import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {money,reduceOrder,demoCommand,emptyCart,subtotal} from '../shared/order-engine.js';
import {mapsUrl,copyLocationLink} from '../shared/locations.js';
import api from '../netlify/functions/api.mjs';
const id='11111111-1111-4111-8111-111111111111';
const request=(action,data={},logged=true)=>new Request('https://example.test/api',{method:'POST',headers:{'content-type':'application/json',...(logged?{authorization:'Bearer test-session'}:{})},body:JSON.stringify({action,data})});

test('Eliminación: sesión, rol, tipo, UUID y confirmación se verifican antes de llamar a la base',async()=>{
 const oldFetch=globalThis.fetch,previous={...process.env};let role='member',deletes=[];
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-secret'});
  globalThis.fetch=async(endpoint,options={})=>{
   if(endpoint.endsWith('/auth/v1/user'))return Response.json({id:'admin-user'});
   if(endpoint.includes('crm_members?'))return Response.json([{user_id:'admin-user',role}]);
   assert.match(endpoint,/guarni_delete$/);deletes.push(JSON.parse(options.body));return Response.json({ok:true,orders:1});
  };
  assert.equal((await api(request('delete_record',{kind:'order',id,confirmation:'ELIMINAR'},false))).status,401);
  for(const action of ['delete_preview','delete_record'])assert.equal((await api(request(action,{kind:'order',id,confirmation:'ELIMINAR'}))).status,403);
  role='admin';
  assert.equal((await api(request('delete_record',{kind:'order',id}))).status,400);
  assert.equal((await api(request('delete_record',{kind:'order',id,confirmation:'cancelar'}))).status,400);
  assert.equal((await api(request('delete_preview',{kind:'member',id}))).status,400);
  assert.equal((await api(request('delete_preview',{kind:'client',id:'bad-id'}))).status,400);
  assert.equal(deletes.length,0);
  assert.equal((await api(request('delete_preview',{kind:'order',id,p_actor:'forged-user',p_confirm:true}))).status,200);
  assert.deepEqual(deletes[0],{p_actor:'admin-user',p_kind:'order',p_id:id,p_confirm:false});
  assert.equal((await api(request('delete_record',{kind:'client',id,confirmation:'ELIMINAR'}))).status,200);
  assert.deepEqual(deletes[1],{p_actor:'admin-user',p_kind:'client',p_id:id,p_confirm:true});
 }finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}
});

test('Eliminación: explica qué migración falta sin exponer errores de la base',async()=>{
 const oldFetch=globalThis.fetch,previous={...process.env};
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'test-secret'});
  globalThis.fetch=async endpoint=>endpoint.endsWith('/auth/v1/user')?Response.json({id:'admin-user'}):endpoint.includes('crm_members?')?Response.json([{user_id:'admin-user',role:'admin'}]):Response.json({code:'PGRST202',message:'Internal schema details'},{status:404});
  const response=await api(request('delete_preview',{kind:'client',id}));assert.equal(response.status,409);
  const data=await response.json();assert.match(data.error,/005_eliminacion_admin.sql/);assert.doesNotMatch(data.error,/Internal schema/);
 }finally{globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);}
});

test.skip('No aplicable: contrato de la UI anterior sustituida — Interfaz: botones solo para admin, confirmación obligatoria y limpieza del chat seleccionado',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const elements=new Map(),storage=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',className:'',showModal(){this.open=true;},close(){this.open=false;},classList:{toggle(){},remove(){}},scrollTop:0,scrollHeight:0,clientHeight:0});return elements.get(id);};
 const context={window:{},document:{getElementById:element,querySelectorAll:()=>[]},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},crypto:{randomUUID},setTimeout:()=>1,clearTimeout(){},structuredClone,Intl,Date,e,initials,searchText,mapsUrl,copyLocationLink,money,reduceOrder,demoCommand,emptyCart,subtotal};
 runInNewContext(source.slice(0,source.indexOf("document.addEventListener('click'")).replace(/^import .*;\r?\n/gm,'')+`
 catalog=[{id:'kikito-base',name:'Kikito',variant:'Base',price:39500,available:true}];
 state.data=seed();state.demo=true;state.view='clients';state.selectedChat=state.data.conversations[0].id;
 globalThis.ui={state,clients,showOrder,deleteRecord,submit:confirmation=>submitHandler(new Map([['confirmation',confirmation]]))};`,context);
 const {ui}=context,d=ui.state.data,order=d.orders[0],clientId=order.client_id,chat=order.conversation_id,button={disabled:false};
 d.member.role='member';assert.doesNotMatch(ui.clients(),/data-deleteclient/);
 ui.showOrder(order.id);assert.doesNotMatch(element('dialogBody').innerHTML,/data-deleteorder/);
 await assert.rejects(()=>ui.deleteRecord('order',order.id,button),/administrador/);
 d.member.role='admin';assert.match(ui.clients(),/data-deleteclient/);
 ui.showOrder(order.id);assert.match(element('dialogBody').innerHTML,/data-deleteorder/);
 const messagesBefore=d.messages.length;
 await ui.deleteRecord('order',order.id,button);
 assert.equal(button.disabled,false);assert.match(element('dialogBody').innerHTML,/no cancela ni notifica/);
 await assert.rejects(()=>ui.submit(''),/ELIMINAR/);assert.equal(d.orders.length,4);
 await ui.submit('ELIMINAR');assert.equal(d.orders.length,3);assert.equal(d.messages.length,messagesBefore);assert.equal(d.clients.length,4);
 await ui.deleteRecord('client',clientId,button);
 assert.match(element('dialogBody').innerHTML,/0 pedidos/);assert.match(element('dialogBody').innerHTML,/1 conversación/);
 await ui.submit('ELIMINAR');assert.equal(d.clients.length,3);assert.equal(ui.state.selectedChat,null);assert.equal(ui.state.messages.length,0);
 assert.ok(d.messages.every(m=>m.conversation_id!==chat));assert.equal(d.conversations.length,3);
});
