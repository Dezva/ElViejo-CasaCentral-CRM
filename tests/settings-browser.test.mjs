import test from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';import {spawn} from 'node:child_process';import {once} from 'node:events';import {join} from 'node:path';import {tmpdir} from 'node:os';
test('Configuración en navegador: días visuales, estados de delivery, pagos, guardado, salida protegida y móvil',async()=>{
 const server=spawn(process.execPath,['scripts/dev.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:'5177'},stdio:['ignore','pipe','pipe']});let browser;
 try{
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('Servidor no disponible');})]);browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox'],headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5177/#settings');await page.getByRole('heading',{name:'Tu local, a tu manera.'}).waitFor();
  const buffet=page.locator('#settings_buffet'),chipa=page.locator('#settings_chiperia'),state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('casa-central-demo-v1')).settings),save=async()=>{await page.getByRole('button',{name:'Guardar cambios',exact:true}).click();await page.getByText('Cambios guardados',{exact:true}).waitFor();};
  assert.equal(await chipa.count(),0);
  assert.equal(await buffet.locator('[name="days_buffet"]:checked').count(),0);
  assert.equal(await buffet.locator('[name="open_buffet"]').inputValue(),'');
  assert.equal(await buffet.locator('.delivery-hours').isVisible(),false);
  const sunday=buffet.getByRole('checkbox',{name:'Domingo',exact:true});
  await sunday.focus();await sunday.press('Space');assert.equal(await sunday.isChecked(),true);
  await buffet.locator('[name="open_buffet"]').fill('11:00');
  await buffet.locator('[name="close_buffet"]').fill('16:00');
  await page.getByRole('checkbox',{name:'Crédito',exact:true}).check();
  await save();
  let s=await state();assert.deepEqual(s.schedules.buffet.days,[0]);assert.equal(s.schedules.buffet.delivery_mode,'pending');assert.deepEqual(s.payment_methods,['Tarjeta de crédito']);
  await page.reload();await page.getByRole('heading',{name:'Tu local, a tu manera.'}).waitFor();assert.equal(await buffet.locator('[name="close_buffet"]').inputValue(),'16:00');
  await buffet.getByRole('radio',{name:'Delivery deshabilitado',exact:false}).check();await save();assert.equal((await state()).schedules.buffet.delivery_mode,'disabled');
  await buffet.getByRole('radio',{name:'Delivery con horario definido',exact:false}).check();
  assert.equal(await buffet.locator('.delivery-hours').isVisible(),true);
  await page.getByRole('button',{name:'Guardar cambios'}).click();assert.match(await page.locator('#settingsError').innerText(),/Buffet.*inicio/);
  await buffet.locator('[name="delivery_open_buffet"]').fill('12:00');
  await buffet.locator('[name="delivery_close_buffet"]').fill('14:00');
  await save();assert.equal((await state()).schedules.buffet.delivery_mode,'scheduled');
  await buffet.locator('[name="close_buffet"]').fill('10:00');await page.getByRole('button',{name:'Guardar cambios'}).click();assert.match(await page.locator('#settingsError').innerText(),/cierre.*posterior/);await buffet.locator('[name="close_buffet"]').fill('16:00');
  // Navegar exige decidir sobre cambios locales; cancelar conserva todos los campos.
  await page.locator('[name="business_name"]').fill('Cambio sin guardar');page.once('dialog',dialog=>dialog.dismiss());await page.locator('[data-view="orders"]').click();assert.equal(await page.locator('[name="business_name"]').inputValue(),'Cambio sin guardar');page.once('dialog',dialog=>dialog.accept());await page.locator('[data-view="orders"]').click();await page.getByRole('heading',{name:'Cada pedido, a su tiempo.'}).waitFor();assert.notEqual((await state()).business_name,'Cambio sin guardar');
  // Cuenta sin privilegios consulta, pero no puede editar ni guardar.
  await page.evaluate(()=>{const d=JSON.parse(localStorage.getItem('casa-central-demo-v1'));d.member.role='member';localStorage.setItem('casa-central-demo-v1',JSON.stringify(d));});await page.reload();await page.locator('[data-view="settings"]').click();assert.equal(await page.getByRole('button',{name:'Guardar cambios'}).isDisabled(),true);assert.equal(await page.locator('[name="business_name"]').isDisabled(),true);
  // Capturas de configuración inicial, sin credenciales ni datos reales.
  const clean=await browser.newPage({viewport:{width:1440,height:1100}});await clean.goto('http://127.0.0.1:5177/#settings');await clean.getByRole('heading',{name:'Tu local, a tu manera.'}).waitFor();await clean.evaluate(()=>scrollTo(0,0));await clean.screenshot({path:join(tmpdir(),'el-viejo-settings-desktop.png'),fullPage:true});await clean.setViewportSize({width:390,height:844});await clean.waitForFunction(()=>document.getElementById('sidebar').getBoundingClientRect().right<=0);assert.equal(await clean.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await clean.screenshot({path:join(tmpdir(),'el-viejo-settings-mobile.png'),fullPage:true});await clean.close();assert.deepEqual(errors,[]);
 }finally{await browser?.close();server.kill();}
});
