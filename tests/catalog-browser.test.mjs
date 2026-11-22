import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('Administración del menú de buffet: categoría, borrador, publicación y disponibilidad', async () => {
  const server = spawn(process.execPath, ['scripts/dev.mjs'], { env: { ...process.env, PORT: '5178' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw Error('Servidor no disponible'); })]);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(6000);
    await page.goto('http://127.0.0.1:5178/#menus');
    await page.getByRole('button', { name: '+ Cargar menú' }).click();
    assert.equal(await page.locator('[data-view=catalog]').count(), 0);
    assert.match(await page.locator('.buffet-category-guide').innerText(), /Tarifa pendiente de confirmación/);
    await page.locator('#addDish').click();
    await page.locator('[name=dish_name]').fill('Chipa guazú de prueba');
    await page.locator('#saveMenuDraft').click();
    const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('casa-central-demo-v1')));
    assert.equal((await state()).menus[0].status, 'draft');
    await page.locator('[data-do=menu]').last().click();
    await page.locator('[name=dish_category]').selectOption('guarniciones');
    await page.locator('[name=dish_available]').check();
    await page.locator('#menuReviewed').check();
    await page.locator('#publishMenu').click();
    const published = (await state()).menus.find(menu => menu.status === 'published');
    assert.equal(published.items[0].category_id, 'guarniciones');
    assert.equal(published.items[0].available, true);
    await page.getByRole('button', { name: 'Actualizar parcialmente / agotados' }).click();
    await page.locator('[name=dish_available]').uncheck();
    await page.locator('#menuReviewed').check();
    await page.locator('#publishMenu').click();
    const { menus } = await state();
    assert.equal(menus.filter(menu => menu.status === 'published').length, 1);
    assert.equal(menus.find(menu => menu.status === 'published').items[0].available, false);
    assert.equal(menus.find(menu => menu.id === published.id).status, 'archived');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  } finally {
    await browser?.close();
    server.kill();
  }
});
