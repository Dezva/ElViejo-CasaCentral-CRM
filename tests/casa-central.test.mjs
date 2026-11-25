import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import api from '../netlify/functions/api.mjs';
import { runWorker } from '../netlify/lib/worker.mjs';
import { branchName, businessName, branchReference } from '../shared/branch-identity.js';
import { localDate, reduceOrder, demoCommand, activeCatalog } from '../shared/viejo-engine.js';
import { databaseV11, mockEnvironment, restBridge } from './v11-helpers.mjs';

const dish = { id: 'prueba-local', name: 'Plato de prueba', category_id: 'carne', available: true };
const catalog = [];

test('El chatbot empieza en buffet y usa el menú publicado en cada mensaje', () => {
  const day = localDate();
  const menus = [{ day, status: 'published', items: [dish] }];
  const hello = reduceOrder({ text: 'hola', catalog, menus });
  assert.equal(hello.cart.service, 'buffet');
  assert.ok(hello.reply.includes(businessName));
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
    assert.equal(config.business_name, businessName);
    assert.equal(config.branch, branchName);
    assert.equal(config.business_address, branchReference);
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

test('La instalación existente muestra y envía la nueva identidad con la configuración anterior', async t => {
  const ctx = await databaseV11({ casa: true });
  t.after(() => ctx.db.close());
  t.after(mockEnvironment());
  Object.assign(process.env, {
    WHATSAPP_SEND_ENABLED: 'true', WHATSAPP_PHONE_NUMBER_ID: '123456',
    WHATSAPP_GRAPH_VERSION: 'v24.0', WHATSAPP_TOKEN: 'fixture',
  });
  const { config } = await ctx.one('select config from guarni_settings');
  const legacy = { ...config, bot_enabled: true, business_name: 'Buffet El Viejo — Casa Central',
    branch: 'Casa Central', business_address: 'Ruta Guarambaré–Villeta, esquina Villetana, frente a IMPACO, Paraguay' };
  await ctx.db.query('update guarni_settings set config=$1 where id=true', [legacy]);
  const sent = [], bridge = restBridge(ctx);
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'graph.facebook.com') {
      sent.push(JSON.parse(options.body).text.body);
      return Response.json({ messages: [{ id: randomUUID() }] });
    }
    if (url.pathname.endsWith('/guarni_locations') && url.searchParams.has('message_id')) return Response.json([]);
    if (url.pathname.endsWith('/guarni_orders') && url.searchParams.get('select')?.includes('delivery_location:')) return Response.json([]);
    return bridge.fetch(input, options);
  });

  const req = query => new Request('https://crm.test/api'+query, { headers: { authorization: 'Bearer fixture' } });
  const response = await api(req(''));
  assert.equal(response.status, 200);
  const { settings } = await response.json();
  assert.deepEqual(settings, { ...legacy, business_name: businessName, branch: branchName, business_address: branchReference });

  const phone = '595000000145';
  const inbound = await ctx.rpc('guarni_ingest', [randomUUID(), phone, 'Prueba', 'Dónde están ubicados?']);
  await runWorker();
  assert.match(sent[0], /Dirección de referencia: Ruta Villeta–Alberdi, Paraguay/);
  const legacyNotice = '*🍽️ BUFFET EL VIEJO — CASA CENTRAL*\n\n*Pedido #1 confirmado*\n\n*Importe acordado:* Gs. 22.000';
  const expectedNotice = '*🍽️ BUFFET EL VIEJO — RUTA VILLETA–ALBERDI*\n\n*Pedido #1 confirmado*\n\n*Importe acordado:* Gs. 22.000';
  const queued = await ctx.one("insert into guarni_messages(conversation_id,direction,actor,body,status) values($1,'outbound','system',$2,'queued') returning id", [inbound.conversation_id, legacyNotice]);
  await runWorker();
  assert.equal(sent[1], expectedNotice);
  const chat = await api(req('?conversation_id='+inbound.conversation_id));
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).messages.find(message => message.id === queued.id).body, expectedNotice);
  assert.equal((await ctx.one('select body from guarni_messages where id=$1', [queued.id])).body, legacyNotice);
  assert.deepEqual((await ctx.one('select config from guarni_settings')).config, legacy);
});
