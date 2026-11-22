import test from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';import {spawn} from 'node:child_process';import {once} from 'node:events';import {tmpdir} from 'node:os';import {join} from 'node:path';
const port=5174;
test('Navegador: demo completa de chipería, buffet, fotografía, intervención y móvil',async()=>{
 const server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let browser;
 try{
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('El servidor de prueba terminó: '+code);})]);browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:950}}),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',err=>errors.push(err.message));
  await page.goto('http://127.0.0.1:'+port);await page.getByRole('heading',{name:'Buena atención, todos los días.'}).waitFor();
  const nav=async v=>page.locator('[data-view="'+v+'"]').click();
  const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('el-viejo-demo-v1')));
  const sim=async text=>{await page.locator('#simulateForm input').fill(text);await page.getByRole('button',{name:'Simular mensaje',exact:true}).click();};
  const close=()=>page.locator('#close').click();
  await nav('catalog');assert.equal(await page.locator('.catalog-card').count(),31);
  await nav('chats');await page.locator('.chat-preview').first().click();await sim('hola');await sim('chipería');await sim('3 tradicional');await sim('retiro');await sim('CONFIRMAR PEDIDO');
  let d=await state();assert.equal(d.orders.length,1);assert.equal(d.orders[0].subtotal,10500);assert.equal(d.orders[0].status,'pending');
  await nav('orders');await page.getByRole('button',{name:'Ver pedido ↗'}).first().click();await page.getByRole('button',{name:'Confirmado',exact:true}).click();await page.locator('[name="schedule_reviewed"]').check();await page.locator('#save').click();
  d=await state();assert.equal(d.orders[0].total,10500);assert.equal(d.orders[0].payment_status,'pending');assert.ok(d.messages.some(m=>m.body.includes('Total aprobado: 10.500')));
  // Photo upload and manual review require explicit publication.
  await nav('menus');await page.getByRole('button',{name:'+ Cargar menú'}).click();
  await page.locator('#menuFile').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=','base64')});
  await page.getByRole('button',{name:'Analizar menú con IA'}).click();await page.getByText('Demo: no se envía la foto a IA externa.',{exact:false}).waitFor();
  await page.getByRole('button',{name:'+ Agregar plato'}).click();await page.locator('[name="dish_name"]').fill('Plato ficticio de prueba');await page.locator('[name="dish_category"]').selectOption('guarniciones');await page.getByRole('button',{name:'Confirmar y publicar',exact:true}).click();assert.match(await page.locator('#menuEditorError').innerText(),/Revisá/);await page.locator('[name="reviewed"]').check();await page.getByRole('button',{name:'Confirmar y publicar',exact:true}).click();
  d=await state();assert.equal(d.menus[0].status,'published');assert.ok(d.menus[0].image.startsWith('data:image/png'));
  await nav('chats');await sim('buffet');await sim('1 plato ficticio de prueba');await sim('retiro');await sim('CONFIRMAR PEDIDO');d=await state();assert.equal(d.orders[0].service,'buffet');assert.equal(d.orders[0].subtotal,null);assert.equal(d.conversations[0].mode,'human');
  await page.getByRole('button',{name:'Tomar conversación'}).count().then(n=>assert.equal(n,1));
  // Unassigned human handoff must still be claimable by an employee.
  const take=page.getByRole('button',{name:'Tomar conversación'});if(await take.count())await take.click();
  await nav('orders');await page.getByRole('button',{name:'Ver pedido ↗'}).first().click();await page.getByRole('button',{name:'Ver conversación'}).click();
  // If the chat is unassigned, take it explicitly.
  if(await page.getByRole('button',{name:'Tomar conversación'}).count())await page.getByRole('button',{name:'Tomar conversación'}).click();
  await nav('orders');await page.getByRole('button',{name:'Ver pedido ↗'}).first().click();await page.getByRole('button',{name:'Confirmado',exact:true}).click();await page.locator('[name="buffet_amount"]').fill('50000');await page.locator('[name="price_agreed"]').check();await page.locator('[name="schedule_reviewed"]').check();if(await page.locator('[name="group_reviewed"]').count())await page.locator('[name="group_reviewed"]').check();await page.locator('#save').click();assert.equal((await state()).orders[0].total,50000);await nav('chats');
  // Record a delivery in the simulator after restoring the bot.
  if(await page.getByRole('button',{name:'Reactivar bot'}).count())await page.getByRole('button',{name:'Reactivar bot'}).click();
  await sim('chipería');await sim('3 tradicional');await sim('delivery');await sim('CONFIRMAR PEDIDO');assert.equal((await state()).orders.length,2);
  await page.getByRole('button',{name:'Simular ubicación puntual'}).click();await page.locator('[name="latitude"]').fill('-25.5');await page.locator('[name="longitude"]').fill('-57.5');await page.locator('[name="address"]').fill('Referencia ficticia de prueba');await page.locator('#save').click();await sim('CONFIRMAR PEDIDO');d=await state();assert.equal(d.orders.length,3);assert.ok(d.orders[0].delivery_location_id);
  await nav('orders');await page.getByRole('button',{name:'Ver pedido ↗'}).first().click();await page.getByRole('link',{name:'Google Maps ↗'}).waitFor();await page.getByRole('button',{name:'Confirmado',exact:true}).click();await page.locator('[name="shipping_fee"]').fill('8000');await page.locator('[name="schedule_reviewed"]').check();if(await page.locator('[name="group_reviewed"]').count())await page.locator('[name="group_reviewed"]').check();await page.locator('#save').click();d=await state();assert.equal(d.orders[0].total,18500);
  await page.locator('#service').selectOption('buffet');assert.equal(await page.locator('tbody tr').count(),1);
  for(const v of ['clients','users','settings','delivery'])await nav(v);
  await page.screenshot({path:join(tmpdir(),'el-viejo-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.locator('#mobileNav').click();await nav('dashboard');await page.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(tmpdir(),'el-viejo-mobile.png'),fullPage:true});
  // Permiso específico en la interfaz: encargado sin administración general.
  await page.evaluate(()=>{const d=JSON.parse(localStorage.getItem('el-viejo-demo-v1'));d.member={user_id:crypto.randomUUID(),display_name:'Encargado de prueba',role:'member',menu_editor:true,catalog_editor:false};localStorage.setItem('el-viejo-demo-v1',JSON.stringify(d));});
  await page.setViewportSize({width:1440,height:950});await page.reload();await page.getByRole('heading',{name:'Buena atención, todos los días.'}).waitFor();await nav('menus');await page.getByRole('button',{name:'+ Cargar menú'}).waitFor();await page.getByRole('button',{name:'+ Cargar menú'}).click();await page.getByRole('button',{name:'Volver a menús'}).click();await nav('users');assert.equal(await page.getByRole('button',{name:'+ Autorizar cuenta'}).count(),0);await nav('catalog');assert.equal(await page.getByRole('button',{name:'+ Producto'}).count(),0);
  await page.evaluate(()=>{const d=JSON.parse(localStorage.getItem('el-viejo-demo-v1'));d.member.menu_editor=false;localStorage.setItem('el-viejo-demo-v1',JSON.stringify(d));});await page.reload();await nav('menus');assert.equal(await page.getByRole('button',{name:'+ Cargar menú'}).count(),0);
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();server.kill();}
});
