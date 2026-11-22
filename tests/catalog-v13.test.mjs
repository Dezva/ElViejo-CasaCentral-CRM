import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import api from '../netlify/functions/api.mjs';
import { deterministicOrder } from '../shared/catalog-matching.js';
import { activeCatalog, localDate, quote } from '../shared/viejo-engine.js';
import { databaseV11, mockEnvironment, restBridge } from './v11-helpers.mjs';

const dish = { id: 'prueba', name: 'Empanada de prueba', category_id: 'carne', available: true };

test('Buffet conserva identificación, cantidades y disponibilidad sin un precio de catálogo', () => {
  const other = { ...dish, id: 'otra', name: 'Empanada de verduras de prueba' };
  const items = [dish, other].map(item => ({ ...item, aliases: ['Empanada'], service: 'buffet' }));
  assert.equal(deterministicOrder('dos empanadas', {}, items).command.intent, 'clarify');
  assert.deepEqual(deterministicOrder('dos empanadas de prueba y una empanada de verduras de prueba', {}, items).command.items.map(x => [x.variant_id, x.qty]), [['prueba', 2], ['otra', 1]]);
  assert.equal(deterministicOrder('una empanada de prueba y un plato inventado', {}, items).command, null);
  assert.match(deterministicOrder('una empanada de prueba', {}, [{ ...items[0], available: false }]).command.message, /agotado/);
  const menu = { day: localDate(), status: 'published', items: [dish] };
  const list = activeCatalog('buffet', [], [menu]);
  assert.throws(() => quote([{ variant_id: dish.id, qty: 1 }, { variant_id: dish.id, qty: 2 }], 'buffet', list), /Agrupá/);
  assert.equal(quote([{ variant_id: dish.id, qty: 1, unit_price: 500 }], 'buffet', list).subtotal, null);
});

test('API y SQL no exponen mutaciones de catálogo y preservan la autorización del menú', async () => {
  const context = await databaseV11();
  const restore = mockEnvironment();
  const savedFetch = globalThis.fetch;
  try {
    let actor = context.admin;
    globalThis.fetch = restBridge(context, { actor: () => actor }).fetch;
    const post = (action, data) => api(new Request('https://crm.test/api', {
      method: 'POST', headers: { authorization: 'Bearer fixture' }, body: JSON.stringify({ action, data }),
    }));
    for (const action of ['catalog', 'catalog_category']) {
      assert.equal((await post(action, {})).status, 400);
      await assert.rejects(context.staff(action, {}), /invalid_action/);
    }
    const menu = { id: randomUUID(), day: localDate(), status: 'published', reviewed: true, items: [dish] };
    actor = context.employee;
    assert.equal((await post('menu', menu)).status, 403);
    actor = context.editor;
    assert.equal((await post('menu', menu)).status, 200);
    assert.equal((await context.one('select count(*)::int n from guarni_catalog')).n, 0);
    await context.db.exec('set role authenticated');
    await assert.rejects(context.db.exec("update guarni_catalog set price=1"), /permission denied/);
    await assert.rejects(context.rpc('viejo_staff_v12_base', [context.admin, 'catalog', {}]), /permission denied/);
  } finally {
    globalThis.fetch = savedFetch;
    restore();
    await context.db.close();
  }
});
