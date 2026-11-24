import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { activeCatalog, defaults, demoCommand, emptyCart, localDate, reduceOrder } from '../shared/viejo-engine.js';
import { interpret } from '../netlify/lib/conversation.mjs';
import { runWorker } from '../netlify/lib/worker.mjs';
import api from '../netlify/functions/api.mjs';
import { databaseV11, mockEnvironment, restBridge } from './v11-helpers.mjs';

const dishes = [
  { id: 'tallarin', name: 'Tallarín', category_id: 'guarniciones', available: true },
  { id: 'milanesa', name: 'Milanesa de pollo', category_id: 'pollo_chancho', available: true },
  { id: 'lasaña', name: 'Lasaña de carne', category_id: 'guarniciones', available: true },
  { id: 'bife', name: 'Bife encebollado', category_id: 'carne', available: false },
  { id: 'pastel', name: 'Pastel', category_id: 'pending', available: false },
];
const prices = { guarniciones: 39500, carne: 51000, pollo_chancho: 47500 };
const menu = () => ({ id: randomUUID(), day: localDate(), status: 'published', reviewed: true, items: dishes });
const settings = { ...defaults, reference_prices: prices };
function say(text, { cart = emptyCart(), menus = [menu()], config = settings, command } = {}) {
  return reduceOrder({ text, cart, menus, settings: config, command: command ?? demoCommand(text, cart, activeCatalog('buffet', [], menus)) });
}

test('Las consultas generales muestran las tres referencias configuradas incluso sin menú publicado', () => {
  for (const text of ['¿Cuáles son los precios por kilo?', 'Hola, ¿Cuáles son los precios por kilo?', 'Buenas tardes, ¿Cuáles son las tarifas del buffet?']) {
    const result = say(text, { menus: [] });
    assert.equal(result.kind, 'reply');
    for (const price of ['39.500', '51.000', '47.500']) assert.match(result.reply, new RegExp('Gs\\. '+price.replace('.', '\\.')));
    assert.match(result.reply, /referencia por kilo/);
    assert.match(result.reply, /importe final.*encargado/);
    assert.deepEqual(result.cart.items, []);
  }
});

test('La consulta específica usa la categoría solicitada o la clasificación publicada del plato', () => {
  for (const [question, rate] of [
    ['¿Cuánto cuesta el kilo de carne?', '51.000'],
    ['¿A cuánto están las guarniciones?', '39.500'],
    ['¿Cuánto cuesta el kilo de pollo?', '47.500'],
    ['¿Qué precio tiene el tallarín?', '39.500'],
    ['¿Cuánto cuesta la lasaña de carne?', '39.500'],
  ]) {
    const { reply, cart } = say(question);
    assert.deepEqual(reply.match(/Gs\. [\d.]+/g), ['Gs. '+rate], question);
    assert.deepEqual(cart.items, []);
  }
  assert.match(say('¿Qué precio tiene el tallarín?').reply, /Tallarín.*categoría Guarniciones/);
  assert.match(say('¿Cuánto cuesta el bife encebollado?').reply, /agotado/);
});

test('Los precios pendientes, platos desconocidos o sin clasificar no reciben una tarifa inventada', () => {
  const unset = say('¿Cuál es el precio del tallarín?', { config: defaults });
  assert.match(unset.reply, /tarifa por kilo pendiente de confirmación/);
  assert.doesNotMatch(unset.reply, /Gs\./);
  const mixed = say('¿Cuáles son las tarifas del buffet?', { config: { ...settings, reference_prices: { carne: prices.carne } } });
  assert.equal((mixed.reply.match(/pendiente de confirmación/g) || []).length, 2);
  assert.match(mixed.reply, /Gs\. 51\.000/);
  for (const result of [say('¿Cuál es el precio del sushi?'), say('¿Qué precio tiene el tallarín?', { menus: [] })]) {
    assert.match(result.reply, /No identifiqué ese plato/);
    assert.doesNotMatch(result.reply, /Gs\./);
  }
  assert.match(say('¿Qué precio tiene el pastel?').reply, /clasificación.*pendiente/);
  assert.doesNotMatch(say('¿Qué precio tiene el pastel?').reply, /Gs\./);
});

test('La consulta y el seguimiento preservan el borrador y no calculan importes', () => {
  const initial = say('Quiero una milanesa de pollo').cart;
  const cart = { ...initial, address: 'Frente a la plaza', delivery_location_id: 'point', fulfillment: 'delivery', payment: 'QR' };
  const general = say('¿Cuáles son los precios por kilo?', { cart });
  const specific = say('Del tallarín', { cart: general.cart });
  assert.match(specific.reply, /Tallarín/);
  for (const answer of [general, specific, say('¿Cuánto me queda el total con delivery?', { cart: specific.cart })]) {
    const { reference_price_context, ...draft } = answer.cart;
    assert.ok(reference_price_context);
    assert.deepEqual(draft, cart);
    assert.equal(answer.kind, 'reply');
  }
  const total = say('¿Cuánto me queda el total con delivery?', { cart: specific.cart });
  assert.doesNotMatch(total.reply, /Gs\./);
  assert.match(total.reply, /equipo.*importe final.*costo de envío/);
  assert.equal(say('Quiero hablar con el encargado sobre el precio', { cart: specific.cart }).kind, 'human');
  assert.match(say('¿Recibiste mi ubicación?', { cart: specific.cart }).reply, /Ya recibí tu ubicación/);
  const forgedOrder = say('Del tallarín', {
    cart: general.cart,
    command: { intent: 'update_cart', items: [{ variant_id: 'tallarin', qty: 2 }] },
  });
  assert.deepEqual(forgedOrder.cart.items, cart.items);
  assert.match(forgedOrder.reply, /39\.500/);
  const explicit = say('Quiero un tallarín', { cart: specific.cart });
  assert.deepEqual(explicit.cart.items.map(item => item.variant_id), ['milanesa', 'tallarin']);
  assert.equal(explicit.cart.reference_price_context, undefined);
});

test('Un pedido con cantidad después de consultar una tarifa no queda atrapado en contexto de precios', () => {
  const consult = say('¿Cuáles son los precios por kilo?');
  assert.equal(consult.cart.reference_price_context, true);
  for (const text of ['2 tallarines', 'una milanesa de pollo']) {
    const response = say(text, { cart: consult.cart });
    assert.equal(response.cart.reference_price_context, undefined, text);
    assert.doesNotMatch(response.reply, /tarifas de referencia|referencia por kilo|Gs\. 39\.500/, text);
  }
});

test('La IA puede señalar consulta, pero sus datos no modifican el pedido ni determinan precios', async t => {
  t.after(mockEnvironment());
  const active = activeCatalog('buffet', [], [menu()]);
  const cart = say('Quiero una milanesa de pollo').cart;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /fixture-ai\.test/);
    const { instructions } = JSON.parse(options.body);
    assert.doesNotMatch(instructions, /39500|51000|47500/);
    return Response.json({ output_text: JSON.stringify({
      intent: 'reference_prices', query: 'carne', items: [{ variant_id: 'tallarin', qty: 3, notes: 'total: Gs. 999.999' }],
      fulfillment: 'retiro', payment: 'QR', address: 'inventada', customer_name: 'inventado', category: 'carne',
    }) });
  });
  const command = await interpret('¿Qué valor figura para el tallarín?', cart, active, settings);
  assert.deepEqual(command, { intent: 'reference_prices' });
  const reply = say('¿Qué valor figura para el tallarín?', { cart, command });
  assert.deepEqual(reply.cart.items, cart.items);
  assert.equal(reply.cart.fulfillment, cart.fulfillment);
  assert.equal(reply.cart.payment, cart.payment);
  assert.match(reply.reply, /39\.500/);
  assert.doesNotMatch(reply.reply, /51\.000|999\.999/);
});

test('WhatsApp utiliza cambios del CRM y solo registra solicitudes pendientes con ubicación válida', async t => {
  const context = await databaseV11({ casa: true });
  t.after(() => context.db.close());
  t.after(mockEnvironment());
  t.mock.method(globalThis, 'fetch', restBridge(context).fetch);
  const { config } = await context.one('select config from guarni_settings');
  const save = async reference_prices => {
    const response = await api(new Request('https://fixture.test/api', {
      method: 'POST', headers: { authorization: 'Bearer fixture' },
      body: JSON.stringify({ action: 'settings', data: { config: { ...config, bot_enabled: true, reference_prices } } }),
    }));
    assert.equal(response.status, 200);
  };
  await save(prices);
  await context.staff('menu', menu());
  const phone = '595000000321';
  let chatId;
  const inbound = async (text, number = phone) => {
    const message = await context.rpc('guarni_ingest', [randomUUID(), number, 'Prueba', text]);
    if (number === phone) chatId = message.conversation_id;
    await runWorker();
    return (await context.one("select body from guarni_messages where conversation_id=$1 and direction='outbound' order by created_at desc,id desc limit 1", [message.conversation_id])).body;
  };
  assert.match(await inbound('Hola, ¿Cuáles son los precios por kilo?'), /39\.500/);
  assert.deepEqual((await context.one('select cart from guarni_conversations where id=$1', [chatId])).cart.items, []);
  await save({ ...prices, guarniciones: 42750 });
  assert.match(await inbound('del tallarin'), /Tallarín.*Guarniciones.*42\.750 por kilo/);
  assert.deepEqual((await context.one('select cart from guarni_conversations where id=$1', [chatId])).cart.items, []);
  const orderRequest = await inbound('voy a querer el tallarin');
  assert.match(orderRequest, /1 × Tallarín/);
  assert.match(orderRequest, /Modalidad: A coordinar/);
  assert.match(orderRequest, /¿Será retiro o delivery\?/);
  assert.doesNotMatch(orderRequest, /a_coordinar/);
  assert.match(await inbound('Quiero dos tallarines'), /2 × Tallarín/);
  assert.match(await inbound('Delivery'), /ubicación puntual/);
  assert.match(await inbound('¿Cuánto sale el total del pedido?'), /equipo/);
  assert.match(await inbound('CONFIRMAR PEDIDO'), /ubicación puntual/);
  assert.equal((await context.one('select count(*)::int n from guarni_orders')).n, 0);
  await context.rpc('guarni_ingest_location', [randomUUID(), phone, 'Prueba', { latitude: -25.3, longitude: -57.5 }, 'location']);
  await runWorker();
  assert.match(await inbound('CONFIRMAR PEDIDO'), /PENDIENTE DE ACEPTACIÓN/);
  const order = await context.one('select * from guarni_orders');
  assert.equal(order.status, 'pending');
  assert.equal(order.subtotal, null);
  assert.equal(order.total, null);
  assert.equal(order.shipping_fee, null);
  assert.equal(order.items[0].unit_price, null);
  assert.equal(order.items[0].qty, 2);
  assert.ok(order.delivery_location_id);
  assert.equal((await context.one('select mode from guarni_conversations where id=$1', [chatId])).mode, 'human');
  await assert.rejects(context.staff('order_status', {
    id: order.id, status: 'accepted', fulfillment: 'delivery', expected_items: order.items,
    location_reviewed: true, schedule_reviewed: true, shipping_fee: 0, price_agreed: true,
  }), /take_conversation_first/);
  await context.staff('take', { id: chatId });
  await assert.rejects(context.staff('order_status', {
    id: order.id, status: 'accepted', fulfillment: 'delivery', expected_items: order.items,
    location_reviewed: true, schedule_reviewed: true, shipping_fee: 0, price_agreed: true,
  }), /agreed_buffet_amount_required/);
});
