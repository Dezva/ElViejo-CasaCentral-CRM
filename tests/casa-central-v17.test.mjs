import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databaseV11, mockEnvironment, restBridge } from './v11-helpers.mjs';
import { localDate, activeCatalog, demoCommand, reduceOrder, emptyCart } from '../shared/viejo-engine.js';
import { runWorker } from '../netlify/lib/worker.mjs';
import api from '../netlify/functions/api.mjs';

const dishes = [
  { id: 'mil', name: 'Milanesa de pollo', category_id: 'pollo_chancho', available: true },
  { id: 'arroz', name: 'Arroz', category_id: 'guarniciones', available: true },
  { id: 'ens', name: 'Ensalada de prueba', category_id: 'guarniciones', available: true },
  { id: 'agotado', name: 'Bife encebollado', category_id: 'carne', available: false },
];
const menu = () => ({ id: randomUUID(), day: localDate(), status: 'published', reviewed: true, items: dishes });

test('Conversación de buffet conserva contexto, cantidades y filtros del menú vigente', () => {
  const menus = [menu()];
  const say = (text, cart, now = new Date()) => reduceOrder({ text, cart, catalog: [], menus, now, command: demoCommand(text, cart, activeCatalog('buffet', [], menus, now)) });
  let cart = say('Quiero dos milanesas de pollo.', emptyCart()).cart;
  assert.equal(cart.items[0].qty, 2);
  cart = say('Al final quiero uno, no dos.', cart).cart;
  assert.equal(cart.items[0].qty, 1);
  cart = say('Agregame un arroz.', cart).cart;
  cart = say('Agregame dos más.', cart).cart;
  assert.deepEqual(cart.items.map(x => x.qty), [1, 3]);
  assert.match(say('¿Qué tienen hoy?', cart).reply, /Milanesa/);
  assert.doesNotMatch(say('¿Qué tienen hoy?', cart).reply, /Bife/);
  assert.match(say('¿Qué guarniciones tienen disponibles?', cart).reply, /Arroz/);
  const onlySalads = say('No quiero todo el menú, solo las ensaladas.', cart);
  assert.match(onlySalads.reply, /Ensalada/);
  assert.doesNotMatch(onlySalads.reply, /Milanesa|Arroz/);
  assert.deepEqual(onlySalads.cart.items, cart.items);
  assert.match(say('menú', cart, new Date(Date.now() + 86400000)).reply, /no hay menú/);
  assert.equal(say('Quiero hablar con una persona', cart).kind, 'human');
});

test('Entrega sin referencia, confirmación humana, cobro, reembolso y eliminación conciliable', async t => {
  const c = await databaseV11({ casa: true });
  t.after(() => c.db.close());
  t.after(mockEnvironment());
  t.mock.method(globalThis, 'fetch', restBridge(c).fetch);
  const { config } = await c.one('select config from guarni_settings');
  await c.staff('settings', { config: { ...config, bot_enabled: true, payment_methods: ['QR'] } });
  await c.staff('menu', menu());
  const number = '595000000121';
  const say = async text => {
    await c.rpc('guarni_ingest', [randomUUID(), number, 'Persona de prueba', text]);
    await runWorker();
  };
  await say('Quiero dos milanesas de pollo');
  await say('delivery');
  await say('CONFIRMAR PEDIDO');
  assert.equal((await c.one('select count(*)::int n from guarni_orders')).n, 0);
  const locationEvent = randomUUID();
  const point = { latitude: -25.3, longitude: -57.5 };
  await c.rpc('guarni_ingest_location', [locationEvent, number, 'Persona de prueba', point, 'location']);
  assert.equal((await c.rpc('guarni_ingest_location', [locationEvent, number, 'Persona de prueba', point, 'location'])).duplicate, true);
  await runWorker();
  await say('No tengo referencia');
  assert.match((await c.one("select body from guarni_messages where direction='outbound' order by created_at desc limit 1")).body, /opcional/);
  await say('CONFIRMAR PEDIDO');
  const order = await c.one('select * from guarni_orders');
  assert.equal(order.address, '');
  assert.ok(order.delivery_location_id);
  const confirm = { id: order.id, status: 'accepted', fulfillment: 'delivery', expected_items: order.items, expected_version: order.version, location_reviewed: true, schedule_reviewed: true, buffet_amount: 40000, price_agreed: true, shipping_fee: 8000 };
  await assert.rejects(c.staff('order_status', confirm), /take_conversation_first/);
  await c.staff('take', { id: order.conversation_id });
  await assert.rejects(c.staff('order_status', { ...confirm, location_reviewed: false }), /location_review_required/);
  await c.staff('order_status', confirm);
  const { body: confirmation } = await c.one("select body from guarni_messages where body like '%confirmado%' order by created_at desc limit 1");
  assert.match(confirmation, /^\*🍽️ BUFFET EL VIEJO — RUTA VILLETA–ALBERDI\*/);
  assert.match(confirmation, /Total confirmado: Gs\. 48\.000/);
  for (const status of ['preparing', 'ready', 'out_for_delivery', 'delivered']) await c.staff('order_status', { id: order.id, status });
  const finance = () => c.rpc('viejo_financial_summary', [c.admin, 'month', null, null, 'buffet']);
  assert.equal((await finance()).completed_amount, 48000);
  assert.equal((await finance()).receipts, 0);
  for (const payment_status of ['paid', 'paid', 'refunded']) await c.staff('payment_status', { id: order.id, payment_status, payment: 'QR' });
  assert.equal((await finance()).receipts, 48000);
  assert.equal((await finance()).refunds, 48000);
  await assert.rejects(c.rpc('viejo_delete_order', [c.employee, order.id]), /admin_required/);
  await c.db.exec("update guarni_messages set status='sent' where status='queued'");
  const preview = await c.rpc('viejo_delete_order', [c.admin, order.id]);
  await assert.rejects(c.rpc('viejo_delete_order', [c.admin, order.id, true, 'ELIMINAR', preview.preview_token, false]), /payment_ack_required/);
  await c.rpc('viejo_delete_order', [c.admin, order.id, true, 'ELIMINAR', preview.preview_token, true]);
  assert.equal((await finance()).retained_movements, 2);
  assert.equal((await c.one('select count(*)::int n from crm_clients')).n, 1);
  assert.equal((await c.one('select count(*)::int n from guarni_conversations')).n, 1);
  const cleared = await c.rpc('viejo_clear_history', [c.admin, order.conversation_id]);
  await c.rpc('viejo_clear_history', [c.admin, order.conversation_id, true, cleared.preview_token]);
  assert.equal((await c.rpc('guarni_ingest_location', [locationEvent, number, 'Persona de prueba', point, 'location'])).duplicate, true);
  const client = await c.rpc('viejo_delete_client', [c.admin, order.client_id]);
  await c.rpc('viejo_delete_client', [c.admin, order.client_id, true, false, client.preview_token]);
  assert.equal((await finance()).retained_movements, 2);
});

test('Agregados de PostgreSQL superan 500 pedidos y separan meses por hora paraguaya', async t => {
  const c = await databaseV11({ casa: true });
  t.after(() => c.db.close());
  t.after(mockEnvironment());
  t.mock.method(globalThis, 'fetch', restBridge(c).fetch);
  const chat = await c.rpc('guarni_ingest', [randomUUID(), '595000000122', 'Prueba', 'hola']);
  await c.db.query("insert into guarni_orders (client_id,conversation_id,customer_name,status,service,items,total,completed_at) select client_id,id,'Prueba','delivered','buffet','[]',1000,case when n=501 then '2026-12-01 03:00:00+00'::timestamptz else '2026-12-01 02:59:59+00'::timestamptz end from guarni_conversations cross join generate_series(1,501) n where id=$1", [chat.conversation_id]);
  const summary = async (from, to) => (await (await api(new Request('https://fixture.test/api?financial_summary=1&period=custom&from='+from+'&to='+to,{headers:{authorization:'Bearer fixture'}}))).json()).summary;
  assert.equal((await summary('2026-11-01','2026-11-30')).completed, 500);
  assert.equal((await summary('2026-12-01','2026-12-31')).completed, 1);
  assert.equal((await c.rpc('viejo_financial_summary', [c.admin, 'all'])).completed_amount, 501000);
  await c.db.exec('set role authenticated');
  await assert.rejects(c.rpc('viejo_financial_summary', [c.admin, 'all']), /permission denied/);
  await assert.rejects(c.db.exec('select * from viejo_payment_movements'), /permission denied/);
});

test('Actualización V1.2 conserva registros y solo recupera fechas con evidencia', async t => {
  const { readFile } = await import('node:fs/promises');
  const c = await databaseV11();
  t.after(() => c.db.close());
  const incoming = await c.rpc('guarni_ingest', [randomUUID(), '595000000123', 'Prueba', 'hola']);
  const { client_id } = await c.one('select client_id from guarni_conversations where id=$1',[incoming.conversation_id]);
  await c.staff('menu', menu());
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) await c.staff('create_order', { request_id: id, client_id, service:'buffet', items:[{variant_id:'arroz',qty:1}], fulfillment:'retiro' });
  await c.db.query("update guarni_orders set status='delivered',payment_status='paid',total=12000 where id=any($1::uuid[])",[ids]);
  await c.db.query("insert into viejo_history(order_id,actor_id,action,before_data,after_data,created_at) values($1,$2,'order_status','{\"status\":\"ready\"}','{\"status\":\"delivered\"}','2026-11-21T13:00:00Z'),($1,$2,'payment_status','{\"payment_status\":\"pending\"}','{\"payment_status\":\"paid\",\"total\":12000,\"payment\":\"QR\"}','2026-11-21T13:10:00Z')",[ids[0],c.admin]);
  for(const name of ['015_historial_casa_central','016_pedidos_finanzas_buffet'])await c.db.exec(await readFile(new URL('../database/'+name+'.sql',import.meta.url),'utf8'));
  const known=await c.one('select completed_at from guarni_orders where id=$1',[ids[0]]);
  const unknown=await c.one('select completed_at from guarni_orders where id=$1',[ids[1]]);
  assert.equal(new Date(known.completed_at).toISOString(),'2026-11-21T13:00:00.000Z');
  assert.equal(unknown.completed_at,null);
  const summary=await c.rpc('viejo_financial_summary',[c.admin,'all']);
  assert.equal(summary.completed_amount,24000);
  assert.equal(summary.receipts,12000);
  assert.equal(summary.unknown_payments,1);
  assert.equal((await c.one('select count(*)::int n from viejo_menus')).n,1);
  assert.equal((await c.one('select count(*)::int n from guarni_catalog')).n,0);
});
