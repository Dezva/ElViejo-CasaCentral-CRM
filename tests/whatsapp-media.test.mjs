import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import webhook from '../netlify/functions/whatsapp.mjs';
import dispatch from '../netlify/functions/dispatch-background.mjs';
import { runWorker } from '../netlify/lib/worker.mjs';
import { localDate } from '../shared/viejo-engine.js';
import { databaseV11, mockEnvironment, restBridge } from './v11-helpers.mjs';

async function fixture(t) {
  const c = await databaseV11({ casa: true });
  t.after(() => c.db.close());
  t.after(mockEnvironment());
  Object.assign(process.env, { WHATSAPP_PHONE_NUMBER_ID: '123456', META_APP_SECRET: 'fixture-signature', WORKER_SECRET: 'worker-fixture' });
  const bridge = restBridge(c);
  const wakeups = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    if (String(input) === 'https://fixture.test/.netlify/functions/dispatch-background') {
      const response = await dispatch(new Request(input, options));
      wakeups.push(response.status);
      return response;
    }
    return bridge.fetch(input, options);
  });
  await c.db.exec("update guarni_settings set config=jsonb_set(config,'{bot_enabled}','true')");
  await c.staff('menu', { id: randomUUID(), day: localDate(), status: 'published', reviewed: true,
    items: [{ id: 'milanesa', name: 'Milanesa de pollo', category_id: 'pollo_chancho', available: true }] });
  const phone = '595000000321';
  const event = (type, data) => ({ id: 'fixture.'+randomUUID(), from: phone, type, [type]: data });
  async function deliver(...messages) {
    const value = { metadata: { phone_number_id: '123456' }, messages };
    const body = JSON.stringify({ entry: [{ changes: [{ value }] }] });
    const signature = 'sha256='+createHmac('sha256', 'fixture-signature').update(body).digest('hex');
    const response = await webhook(new Request('https://fixture.test/.netlify/functions/whatsapp', {
      method: 'POST', body, headers: { 'x-hub-signature-256': signature },
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(wakeups.every(status => status === 200));
    return result;
  }
  const say = body => deliver(event('text', { body }));
  const chat = () => c.one('select * from guarni_conversations where wa_id=$1', [phone]);
  const outbound = async () => (await c.db.query("select body from guarni_messages where direction='outbound' order by created_at,id")).rows.map(row => row.body);
  return { c, event, deliver, say, chat, outbound, bridge, wakeups };
}

test('WhatsApp buffet: los stickers se descartan antes de tocar el chat o despertar el worker', async t => {
  const { c, event, deliver, say, chat, outbound, bridge, wakeups } = await fixture(t);
  const order = 'Quiero dos milanesas de pollo';
  const initial = await outbound();
  const sticker = event('sticker', { id: 'private-media-id', animated: true });
  const first = await deliver(sticker);
  assert.equal(first.accepted, 0);
  assert.equal(first.ignored_stickers, 1);
  assert.equal(wakeups.length, 0);
  assert.equal(bridge.calls.length, 0);
  assert.deepEqual(await outbound(), initial);
  assert.equal(await chat(), undefined);

  await say('MENÚ');
  assert.ok((await outbound()).some(body => body.includes('Milanesa de pollo')));
  await say(order);
  const before = await chat();
  assert.equal(before.cart.service, 'buffet');
  assert.equal(before.cart.items[0].qty, 2);
  const cart = structuredClone(before.cart);
  cart.items[0].notes = 'Observación de prueba';
  await c.db.query('update guarni_conversations set cart=$1 where id=$2', [cart, before.id]);
  const point = event('location', { latitude: -25.3, longitude: -57.5 });
  await deliver(point);
  const withPoint = await chat();
  assert.ok(withPoint.draft_location_id);
  const messages = await outbound();
  const calls = bridge.calls.length;
  const activeWakeups = wakeups.length;
  const activeStickers = await deliver(sticker, event('sticker', { animated: false }));
  assert.equal(activeStickers.ignored_stickers, 2);
  assert.equal(activeStickers.accepted, 0);
  assert.equal(wakeups.length, activeWakeups);
  assert.equal(bridge.calls.length, calls);
  assert.deepEqual(await chat(), withPoint);
  assert.deepEqual(await outbound(), messages);

  const repeated = await deliver(sticker, event('sticker', {}), event('sticker', {}), event('reaction', { emoji: '👍' }), event('video', { mime_type: 'image/gif' }));
  assert.equal(repeated.accepted, 2);
  assert.equal(repeated.ignored_stickers, 3);
  assert.equal(repeated.duplicates, 0);
  assert.deepEqual(await outbound(), messages);
  const after = await chat();
  for (const key of ['cart', 'revision', 'mode', 'owner_id', 'draft_location_id']) assert.deepEqual(after[key], withPoint[key], key);
  assert.equal((await c.one('select count(*)::int n from guarni_messages where external_id=$1', [sticker.id])).n, 0);
  assert.equal((await c.one("select count(*)::int n from guarni_jobs where status<>'done'")).n, 0);
  assert.equal(bridge.calls.slice(calls).filter(call => call.path.endsWith('guarni_finish') && call.body.p_kind === 'ignore').length, 2);
  assert.ok(bridge.calls.slice(calls).every(call => !call.path.includes('guarni_settings')));

  const text = event('text', { body: order.replace('dos', 'tres') });
  const mixed = await deliver(sticker, text);
  assert.equal(mixed.accepted, 1);
  assert.equal(mixed.ignored_stickers, 1);
  assert.equal((await deliver(text)).duplicates, 1);
  const continued = await chat();
  assert.equal(continued.mode, 'bot');
  assert.equal(continued.revision, withPoint.revision);
  assert.equal(continued.draft_location_id, withPoint.draft_location_id);
  assert.equal(continued.cart.items[0].qty, 3);
  assert.equal(continued.cart.items[0].notes, 'Observación de prueba');
  assert.equal(continued.cart.service, 'buffet');

  await say('Retiro');
  await say('CONFIRMAR PEDIDO');
  const submitted = await chat();
  assert.equal(submitted.mode, 'human');
  assert.equal((await c.one('select status from guarni_orders where conversation_id=$1', [submitted.id])).status, 'pending');
  await deliver(sticker);
  assert.deepEqual(await chat(), submitted);
});

test('Multimedia no interpretada pide texto; atención humana y registros antiguos siguen funcionando', async t => {
  const { c, event, deliver, say, chat, outbound } = await fixture(t);
  await say('MENÚ');
  const before = await chat();
  const legacy = await c.rpc('guarni_ingest', [randomUUID(), before.wa_id, 'Prueba', '[Contenido sticker recibido: requiere atención humana]']);
  assert.equal(legacy.duplicate, false);
  const initial = await outbound();
  await runWorker();
  assert.deepEqual(await outbound(), initial);
  assert.equal((await chat()).mode, 'bot');

  for (const type of ['image', 'video', 'audio', 'document']) await deliver(event(type, { id: 'fixture-file' }));
  assert.equal((await outbound()).filter(body => body.includes('escribime en texto')).length, 4);
  assert.equal((await chat()).mode, 'bot');
  await c.staff('take', { id: before.id });
  const taken = await chat();
  const messages = await outbound();
  await deliver(event('sticker', {}), event('text', { body: 'MENÚ' }), event('document', {}));
  const after = await chat();
  assert.deepEqual(await outbound(), messages);
  assert.equal(after.mode, 'human');
  assert.equal(after.owner_id, c.admin);
  assert.equal(after.revision, taken.revision);

  await c.staff('release', { id: before.id });
  await say('Quiero hablar con una persona');
  assert.equal((await chat()).mode, 'human');
  assert.ok((await outbound()).some(body => /continuará la atención/.test(body)));
  assert.equal((await c.one("select count(*)::int n from guarni_jobs where status<>'done'")).n, 0);
});
