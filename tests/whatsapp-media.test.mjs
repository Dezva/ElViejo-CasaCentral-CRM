import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import webhook from '../netlify/functions/whatsapp.mjs';
import { runWorker } from '../netlify/lib/worker.mjs';
import { localDate } from '../shared/viejo-engine.js';
import { databaseV11, mockEnvironment, restBridge } from './v11-helpers.mjs';

async function fixture(t) {
  const c = await databaseV11({ casa: true });
  t.after(() => c.db.close());
  t.after(mockEnvironment());
  Object.assign(process.env, { WHATSAPP_PHONE_NUMBER_ID: '123456', META_APP_SECRET: 'fixture-signature', WORKER_SECRET: '' });
  const bridge = restBridge(c);
  t.mock.method(globalThis, 'fetch', bridge.fetch);
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
    await runWorker();
    return response.json();
  }
  const say = body => deliver(event('text', { body }));
  const chat = () => c.one('select * from guarni_conversations where wa_id=$1', [phone]);
  const outbound = async () => (await c.db.query("select body from guarni_messages where direction='outbound' order by created_at,id")).rows.map(row => row.body);
  return { c, event, deliver, say, chat, outbound, bridge };
}

test(`WhatsApp buffet: stickers, reacciones y GIF conservan el carrito, y el bot sigue respondiendo`, async t => {
  const { c, event, deliver, say, chat, outbound, bridge } = await fixture(t);
  const order = 'Quiero dos milanesas de pollo';
  const initial = await outbound();
  const sticker = event('sticker', { id: 'private-media-id', animated: true });
  assert.equal((await deliver(sticker)).accepted, 1);
  assert.deepEqual(await outbound(), initial);
  assert.equal((await chat()).mode, 'bot');

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

  const repeated = await deliver(sticker, event('sticker', {}), event('sticker', {}), event('reaction', { emoji: '👍' }), event('video', { mime_type: 'image/gif' }));
  assert.equal(repeated.accepted, 4);
  assert.equal(repeated.duplicates, 1);
  assert.deepEqual(await outbound(), messages);
  const after = await chat();
  for (const key of ['cart', 'revision', 'mode', 'owner_id', 'draft_location_id']) assert.deepEqual(after[key], withPoint[key], key);
  assert.equal((await c.one('select count(*)::int n from guarni_messages where external_id=$1', [sticker.id])).n, 1);
  assert.equal((await c.one('select body from guarni_messages where external_id=$1', [sticker.id])).body, '[Contenido sticker recibido]');
  assert.equal((await c.one("select count(*)::int n from guarni_jobs where status<>'done'")).n, 0);
  assert.equal(bridge.calls.slice(calls).filter(call => call.path.endsWith('guarni_finish') && call.body.p_kind === 'ignore').length, 4);
  assert.ok(bridge.calls.slice(calls).every(call => !call.path.includes('guarni_settings')));

  await say(order.replace('dos', 'tres'));
  const continued = await chat();
  assert.equal(continued.cart.items[0].qty, 3);
  assert.equal(continued.cart.items[0].notes, 'Observación de prueba');
  assert.equal(continued.cart.service, 'buffet');
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
