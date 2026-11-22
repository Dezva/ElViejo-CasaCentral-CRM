import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import api from '../netlify/functions/api.mjs';
import { localDate, reduceOrder, demoCommand, activeCatalog } from '../shared/viejo-engine.js';
import { databaseV11, mockEnvironment, restBridge } from './v11-helpers.mjs';

const dish = { id: 'prueba-local', name: 'Plato de prueba', category_id: 'carne', available: true };
const catalog = [];

test('El chatbot empieza en buffet y usa el menú publicado en cada mensaje', () => {
  const day = localDate();
  const menus = [{ day, status: 'published', items: [dish] }];
  const hello = reduceOrder({ text: 'hola', catalog, menus });
  assert.equal(hello.cart.service, 'buffet');
  assert.match(hello.reply, /Casa Central/);
  const rejected = reduceOrder({ text: 'Quiero cambiar al servicio de chipería', cart: hello.cart, catalog, menus });
  assert.match(rejected.reply, /exclusivamente/);
  const command = demoCommand('2 Plato de prueba', hello.cart, activeCatalog('buffet', catalog, menus));
  const ordered = reduceOrder({ text: '2 Plato de prueba', cart: hello.cart, command, catalog, menus });
  assert.equal(ordered.cart.items[0].qty, 2);
  assert.equal(ordered.cart.subtotal, null);
  const updated = [{ ...menus[0], items: [{ ...dish, available: false }] }];
  const confirmation = reduceOrder({ text: 'CONFIRMAR PEDIDO', cart: ordered.cart, catalog, menus: updated });
  assert.equal(confirmation.kind, 'reply');
  assert.match(confirmation.reply, /disponibilidad/);
});

test('Instalación limpia, configuración inicial y pedido de buffet sin precio', async () => {
  const ctx = await databaseV11();
  const restore = mockEnvironment();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = restBridge(ctx).fetch;
    const { config } = await ctx.one('select config from guarni_settings');
    assert.deepEqual(Object.keys(config.schedules), ['buffet']);
    assert.deepEqual(config.payment_methods, []);
    assert.equal(config.reference_prices.carne, null);
    assert.equal((await ctx.one('select count(*)::int n from guarni_catalog')).n, 0);
    await ctx.staff('settings', { config });
    const menu = { id: randomUUID(), day: localDate(), status: 'published', items: [dish] };
    await assert.rejects(ctx.staff('menu', menu), /review/);
    await ctx.staff('menu', { ...menu, reviewed: true });
    const items = [{ variant_id: dish.id, qty: 1 }];
    await assert.rejects(ctx.rpc('viejo_quote', ['chiperia', items]), /invalid_items/);
    const response = await api(new Request('https://crm.test/api', {
      method: 'POST',
      headers: { authorization: 'Bearer fixture' },
      body: JSON.stringify({ action: 'create_order', data: { service: 'chiperia', items } })
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Solo se admiten pedidos de buffet/);
    const quote = await ctx.rpc('viejo_quote', ['buffet', items]);
    assert.equal(quote.subtotal, null);
    assert.equal(quote.items[0].unit_price, null);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    await ctx.db.close();
  }
});
