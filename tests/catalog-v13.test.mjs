import {deterministicOrder} from '../shared/catalog-matching.js';
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID as uid} from 'node:crypto';
import {databaseV11,mockEnvironment,restBridge} from './v11-helpers.mjs';import {validateProduct,sellable,categoryKey,commercialText,productTerms,withCategories} from '../shared/catalog.js';import {quote} from '../shared/viejo-engine.js';import api from '../netlify/functions/api.mjs';
const migration=await readFile(new URL('../database/012_catalogo_individual.sql',import.meta.url),'utf8');
const product=(name,price=5000)=>({id:uid(),name,variant:'Base',category_id:'chiperia-6',price,active:true,available:price!==null,seasonal:false,aliases:[]});
test('V1.3 migración: conserva 31 IDs, precios editados, panes dulces, carritos y pedido histórico de Facturas; reejecutable',async()=>{
 const c=await databaseV11({individual:false});try{
 await c.db.exec("update guarni_catalog set price=7300 where id='empanada-carne';update guarni_catalog set name='Producto propio editado' where id='pasta-frola-base'");
 const ing=await c.rpc('guarni_ingest',['fixture.catalog.'+uid(),'59500000123','Prueba','hola']);
 const cart={service:'chiperia',items:[{variant_id:'facturas-base',qty:2}],quoted:false};await c.db.query('update guarni_conversations set cart=$1 where id=$2',[cart,ing.conversation_id]);
 const chat=await c.one('select * from guarni_conversations');const id=uid();await c.staff('create_order',{request_id:id,client_id:chat.client_id,service:'chiperia',items:cart.items,fulfillment:'retiro'});
 const before=(await c.one('select * from guarni_orders where id=$1',[id])),old=(await c.db.query('select * from guarni_catalog order by id')).rows;
 await c.db.exec(migration);assert.equal((await c.one('select count(*)::int n from guarni_catalog')).n,31);assert.equal((await c.one('select count(*)::int n from viejo_catalog_backup')).n,31);
 for(const p of old){const n=await c.one('select * from guarni_catalog where id=$1',[p.id]);assert.equal(n.price,p.price);if(p.id!=='facturas-base')assert.equal(n.available,p.available);if(p.seasonal)assert.equal(n.active,false);}
 assert.deepEqual(await c.one('select * from guarni_orders where id=$1',[id]),before);assert.deepEqual((await c.one('select cart from guarni_conversations')).cart,cart);
 await assert.rejects(()=>c.rpc('viejo_quote',['chiperia',cart.items]),/price_or_availability_changed/);await assert.rejects(()=>c.staff('order_status',{id,status:'accepted',fulfillment:'retiro',schedule_reviewed:true,expected_items:before.items}),/price_or_availability_changed/);
 const pasta=await c.one("select * from guarni_catalog where id='pasta-frola-base'");assert.deepEqual(pasta.aliases,[]);await c.staff('catalog',{...pasta,price:5500,aliases:['Tarta frola']});await c.db.exec(migration);const persisted=await c.one("select * from guarni_catalog where id='pasta-frola-base'");assert.equal(persisted.price,5500);assert.deepEqual(persisted.aliases,['Tarta frola']);assert.deepEqual(await c.one('select * from guarni_orders where id=$1',[id]),before);
 }finally{await c.db.close();}
});
test('V1.3 SQL/API: categorías normalizadas, reasignación, precios independientes, permisos, sinónimos y bajas',async()=>{
 const c=await databaseV11(),restore=mockEnvironment(),saved=globalThis.fetch;try{
 let actor=c.employee;const bridge=restBridge(c,{actor:()=>actor});globalThis.fetch=bridge.fetch;const post=(action,data)=>api(new Request('https://crm.test/api',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({action,data})}));
 const category={id:uid(),name:'Bebidas frías',position:20,active:true};assert.equal((await post('catalog_category',category)).status,403);await assert.rejects(()=>c.staff('catalog_category',category,c.employee),/catalog_permission_required/);
 await c.db.query('update crm_members set catalog_editor=true where user_id=$1',[c.employee]);assert.equal((await post('catalog_category',category)).status,200);
 for(const name of [' BEBIDAS  FRIAS ','Bebidas Frías'])await assert.rejects(()=>c.staff('catalog_category',{...category,id:uid(),name},actor),/duplicate_category/);
 const medialuna={...product('Medialuna',null),aliases:['Medialunas','Media luna','Medias lunas']};assert.equal((await post('catalog',medialuna)).status,200);assert.equal(sellable(medialuna),false);await assert.rejects(()=>c.rpc('viejo_quote',['chiperia',[{variant_id:medialuna.id,qty:1}]]),/price_or_availability_changed/);
 const bollo=product('Bollo',null);await c.staff('catalog',bollo,actor);assert.notEqual(bollo.id,'bollito-base');
 medialuna.price=6500;medialuna.available=true;await c.staff('catalog',medialuna,actor);const sameAlias={...product('Medialuna integral',8000),aliases:['Media luna']};await c.staff('catalog',sameAlias,actor);assert.equal((await c.one('select aliases from guarni_catalog where id=$1',[sameAlias.id])).aliases[0],'Media luna');
 const carne=await c.one("select * from guarni_catalog where id='empanada-carne'");await c.staff('catalog',{...carne,price:7000},actor);assert.equal((await c.one("select price from guarni_catalog where id='empanada-pollo'")).price,6000);
 const q=await c.rpc('viejo_quote',['chiperia',[{variant_id:carne.id,qty:2},{variant_id:'empanada-pollo',qty:1}]]);assert.equal(q.subtotal,20000);
 await c.staff('catalog',{...medialuna,category_id:category.id,available:false},actor);await assert.rejects(()=>c.staff('catalog_category',{id:category.id,remove:true},actor),/category_reassignment_required/);await c.staff('catalog_category',{id:category.id,remove:true,reassign_to:'chiperia-6'},actor);assert.equal((await c.one('select category_id from guarni_catalog where id=$1',[medialuna.id])).category_id,'chiperia-6');
 await c.staff('catalog_category',{id:'chiperia-2',name:'Empanadas',position:2,active:false},actor);await assert.rejects(()=>c.rpc('viejo_quote',['chiperia',[{variant_id:carne.id,qty:1}]]),/price_or_availability_changed/);
 const bad={...medialuna,aliases:['Facturas']};assert.equal((await post('catalog',bad)).status,400);await assert.rejects(()=>c.staff('catalog',bad,actor),/invalid_aliases/);
 const generic=await c.one("select * from guarni_catalog where id='facturas-base'");await assert.rejects(()=>c.staff('catalog',{...generic,active:true,available:true},actor),/generic_product_review/);
 await c.staff('catalog_category',{id:'chiperia-0',remove:true,reassign_to:'chiperia-7'},actor);await c.db.exec(migration);assert.equal((await c.one("select count(*)::int n from viejo_catalog_categories where id='chiperia-0'")).n,0);
 await c.db.exec('set role authenticated');for(const sql of ["update guarni_catalog set price=1","delete from viejo_catalog_categories","select viejo_staff_settings_base(null,'catalog','{}')"])await assert.rejects(()=>c.db.exec(sql),/permission denied/);await c.db.exec('reset role');
 }finally{globalThis.fetch=saved;restore();await c.db.close();}
});
test('V1.3 equivalencias y precios: plurales acotados, sin precio de categoría ni bollo=bollito; estado activo independiente',()=>{
 assert.equal(commercialText(' DOS empanadas de CARNE '),'dos empanada carne');assert.notEqual(commercialText('bollo'),commercialText('bollito'));assert.equal(categoryKey('  SÁNDWICHES   '),'sandwiches');const p=product('Pasta frola');p.aliases=['Pastafrola'];assert.ok(productTerms(p).includes('pastafrola'));validateProduct(p);assert.throws(()=>validateProduct({...p,aliases:['Facturas']}));
 assert.throws(()=>quote([{variant_id:p.id,qty:1}],'chiperia',[{...p,service:'chiperia',active:false}]));const list=withCategories([{...p,service:'chiperia'}],[{id:p.category_id,name:'Facturas',active:false}]);assert.equal(sellable(list[0]),false);assert.throws(()=>quote([{variant_id:p.id,qty:1}],'chiperia',list));
});

test('V1.3 interpretación comercial: múltiples productos, sinónimos, cantidades, ambigüedad y precio pendiente',()=>{
 const bollito={...product('Bollito',10000),id:'bollito',aliases:[]},bollo={...product('Bollo',null),id:'bollo'},media={...product('Medialuna',6500),id:'media',aliases:['Media luna','Medias lunas']},carne={...product('Empanada',6000),id:'carne',variant:'Carne'},pollo={...product('Empanada',6000),id:'pollo',variant:'Pollo'};
 const list=[bollito,bollo,media,carne,pollo],text='Quiero dos bollitos, una medialuna y tres empanadas de carne.';
 const resolved=deterministicOrder(text,{items:[]},list);assert.deepEqual(resolved.command.items.map(x=>[x.variant_id,x.qty]),[['bollito',2],['media',1],['carne',3]]);
 assert.match(deterministicOrder('un bollo',{},list).command.message,/precio individual pendiente/);assert.equal(deterministicOrder('dos medias lunas',{},list).command.items[0].qty,2);
 assert.equal(deterministicOrder('dos empanadas',{},list).command.intent,'clarify');assert.equal(deterministicOrder('dos bollitos y un desconocido',{},list).command,null);assert.equal(deterministicOrder('dos bollitos tres',{},list).command,null);
 media.price=null;assert.match(deterministicOrder(text,{},list).command.message,/Medialuna.*pendiente/);media.price=6500;media.aliases.push('Bollito');assert.equal(deterministicOrder('un bollito',{},list).command.intent,'clarify');
});
