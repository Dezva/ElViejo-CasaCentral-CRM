import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {emptyCart,reduceOrder,isConfirmation} from '../shared/order-engine.js';
import {verifySignature} from '../netlify/lib/platform.mjs';
import {createHmac} from 'node:crypto';
const catalog=[{id:'kikito',name:'Kikito',variant:'Base',category:'Sándwiches',price:39500,available:true}];
function quote(){return reduceOrder({text:'2 Kikito',cart:emptyCart('Ana'),catalog,command:{intent:'update_cart',items:[{variant_id:'kikito',qty:2,notes:'Sin tomate'}]}});}
test('Los importes salen del catálogo, no del comando de la IA',()=>{const result=quote();assert.equal(result.cart.items[0].unit_price,39500);assert.match(result.reply,/79\.000/);assert.equal(result.kind,'reply');});
test('Confirmación explícita, separada de aceptación del local',()=>{assert.equal(isConfirmation('sí'),false);assert.equal(isConfirmation('CONFIRMAR PEDIDO'),true);const result=reduceOrder({text:'CONFIRMAR PEDIDO',cart:{...quote().cart,fulfillment:'retiro'},catalog});assert.equal(result.kind,'submit');assert.equal(result.cart.fulfillment,'retiro');});
test('Cambio de precio obliga a mostrar un nuevo resumen',()=>{const result=reduceOrder({text:'CONFIRMAR PEDIDO',cart:quote().cart,catalog:[{...catalog[0],price:42000}]});assert.equal(result.kind,'reply');assert.match(result.reply,/84\.000/);});
test('Producto agotado no se registra desde un carrito anterior',()=>{const result=reduceOrder({text:'CONFIRMAR PEDIDO',cart:quote().cart,catalog:[{...catalog[0],available:false}]});assert.equal(result.kind,'reply');assert.equal(result.cart.items.length,0);});
test('Rechaza IDs y cantidades inválidos',()=>{for(const item of [{variant_id:'falso',qty:1},{variant_id:'kikito',qty:-1},{variant_id:'kikito',qty:1.5}])assert.throws(()=>reduceOrder({text:'pedido',cart:emptyCart(),catalog,command:{intent:'update_cart',items:[item]}}));});
test('La IA no puede confirmar un pedido por su cuenta',()=>{const result=reduceOrder({text:'hola',cart:quote().cart,catalog,command:{intent:'submit',reply:'pedido aceptado'}});assert.equal(result.kind,'reply');assert.doesNotMatch(result.reply,/pedido aceptado/);});
test('Solicitar una persona transfiere atención y conserva el carrito',()=>{const result=reduceOrder({text:'Quiero hablar con una persona',cart:quote().cart,catalog});assert.equal(result.kind,'human');assert.equal(result.cart.items.length,1);});
test('La firma de Meta rechaza cuerpo alterado y secreto ausente',()=>{const body='{"ok":true}',secret='test-secret',signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');assert.equal(verifySignature(body,signature,secret),true);assert.equal(verifySignature(body+' ',signature,secret),false);assert.equal(verifySignature(body,signature,''),false);});
test('Las 69 opciones de carga inicial tienen precio completo y IDs únicos',async()=>{const d=JSON.parse(await readFile(new URL('./fixtures/legacy-catalog.json',import.meta.url),'utf8'));const all=d.productos.flatMap(p=>p.variantes);assert.equal(all.length,69);assert.equal(new Set(all.map(x=>x.id)).size,69);assert.ok(all.every(x=>Number.isSafeInteger(x.precio_pyg)&&x.precio_pyg>0));});
test('Consultar el precio de un producto no arma un pedido',()=>{const r=reduceOrder({text:'Cuánto cuesta Kikito',cart:emptyCart(),catalog,command:{intent:'menu',query:'Kikito'}});assert.match(r.reply,/39\.500/);assert.equal(r.cart.items.length,0);});
test('No inventa horarios, pagos ni costos de envío',()=>{const r=reduceOrder({text:'Horarios',cart:emptyCart(),catalog,command:{intent:'info'}});assert.match(r.reply,/a confirmar con el local/);assert.doesNotMatch(r.reply,/gratis|11:00|efectivo/i);});
