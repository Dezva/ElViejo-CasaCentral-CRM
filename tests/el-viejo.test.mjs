import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCatalog, confirmation, defaults, demoCommand, emptyCart, localDate, quote, reduceOrder, sameItems } from '../shared/viejo-engine.js';

const now = new Date('2026-11-20T15:30:00Z');
const dishes = [
  { id: 'guazu', name: 'Chipa guazú', category_id: 'guarniciones', available: true },
  { id: 'asado', name: 'Asado a la olla', category_id: 'carne', available: true },
  { id: 'empanada', name: 'Empanada de prueba', category_id: 'carne', available: true },
];
const published = items => [{ day: localDate(now), status: 'published', items }];
const say = (text, cart = emptyCart(), menus = published(dishes)) => {
  const catalog = activeCatalog('buffet', [], menus, now);
  return reduceOrder({ text, cart, catalog, menus, now, command: demoCommand(text, cart, catalog) });
};

test('Buffet acepta nombres legítimos y cantidades sin habilitar otro servicio', () => {
  const ordered = say('Quiero dos chipas guazú y un asado a la olla');
  assert.deepEqual(ordered.cart.items.map(({ variant_id, qty }) => [variant_id, qty]), [['guazu', 2], ['asado', 1]]);
  const extra = say('Una empanada de prueba', ordered.cart);
  assert.equal(extra.cart.items[2].variant_id, 'empanada');
  const unavailable = published(dishes.map(dish => dish.id === 'empanada' ? { ...dish, available: false } : dish));
  assert.doesNotMatch(say('menú', extra.cart, unavailable).reply, /Empanada/);
  assert.match(say('Una empanada de prueba', ordered.cart, unavailable).reply, /agotado/);
  const other = say('Quiero cambiar a Chipería El Viejo', ordered.cart);
  assert.match(other.reply, /exclusivamente/);
  assert.deepEqual(other.cart.items, ordered.cart.items);
  const invalid = say('Quiero un plato desconocido', ordered.cart);
  assert.match(invalid.reply, /No encontré.*plato.*desconocido/);
  assert.deepEqual(invalid.cart.items, []);
  assert.equal(invalid.cart.service, 'buffet');
});

test('El buffet utiliza solo el menú publicado de hoy y descarta precios y cantidades incorrectas', () => {
  assert.equal(activeCatalog('buffet', [], [{ ...published(dishes)[0], day: '2026-11-19' }], now).length, 0);
  const list = activeCatalog('buffet', [], published(dishes), now);
  for (const qty of [0, 31, 1.5, '2']) assert.throws(() => quote([{ variant_id: 'asado', qty }], 'buffet', list));
  const q = quote([{ variant_id: 'asado', qty: 2, unit_price: 1 }], 'buffet', list);
  assert.equal(q.items[0].unit_price, null);
  assert.equal(q.subtotal, null);
  assert.equal(sameItems(q.items, [Object.fromEntries(Object.entries(q.items[0]).reverse())]), true);
});

test('Delivery conserva platos, exige punto y referencia y limpia la ubicación al cambiar a retiro', () => {
  const ordered = say('Dos chipas guazú').cart;
  const delivery = say('delivery', ordered);
  assert.deepEqual(delivery.cart.items, ordered.items);
  assert.match(delivery.reply, /ubicación puntual/);
  assert.notEqual(say('CONFIRMAR PEDIDO', delivery.cart).kind, 'submit');
  const located = { ...delivery.cart, delivery_location_id: 'fixture', address: 'Referencia de prueba' };
  assert.equal(say('CONFIRMAR PEDIDO', located).kind, 'submit');
  const pickup = say('retiro', located).cart;
  assert.deepEqual(pickup.items, ordered.items);
  assert.equal(pickup.delivery_location_id, null);
  assert.equal(pickup.address, '');
  assert.equal(say('CONFIRMAR PEDIDO', pickup).kind, 'submit');
});

test('Confirmación exige intervención, importe acordado y costo explícito de envío', () => {
  const order = { ...say('Dos chipas guazú').cart, fulfillment: 'delivery', delivery_location_id: 'fixture' };
  const input = { fulfillment: 'delivery', address: 'Referencia ficticia', shipping_fee: 8000, buffet_amount: 20000, price_agreed: true, schedule_reviewed: true };
  const context = { mode: 'human', owner_id: 'actor', actor: 'actor', menus: published(dishes), now, settings: defaults };
  assert.throws(() => confirmation(order, input, [], { ...context, mode: 'bot' }), /Tomá la conversación/);
  assert.throws(() => confirmation(order, { ...input, price_agreed: false }, [], context), /importe acordado/);
  assert.throws(() => confirmation(order, { ...input, shipping_fee: undefined }, [], context), /costo del delivery/);
  assert.throws(() => confirmation(order, { ...input, schedule_reviewed: false }, [], context), /pendiente/);
  assert.equal(confirmation(order, input, [], context).total, 28000);
  assert.equal(confirmation({ ...order, fulfillment: 'retiro' }, { ...input, fulfillment: 'retiro' }, [], context).shipping_fee, 0);
});
