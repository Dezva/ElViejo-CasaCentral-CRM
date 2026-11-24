import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uid } from 'node:crypto';
import { recoverCandidates, compactContext, deterministicConversation, validateInterpretation } from '../shared/conversation-context.js';
import { activeCatalog, defaults, emptyCart, localDate, quote } from '../shared/viejo-engine.js';
import { interpret } from '../netlify/lib/conversation.mjs';
import { metricRecord } from '../netlify/lib/ai-metrics.mjs';
import { runWorker } from '../netlify/lib/worker.mjs';
import { databaseV11, mockEnvironment, restBridge } from './v11-helpers.mjs';

const dishes = [
  { id: 'guazu', name: 'Chipa guazú', category_id: 'guarniciones', available: true },
  { id: 'asado', name: 'Asado a la olla', category_id: 'carne', available: true },
  { id: 'sopa', name: 'Sopa paraguaya', category_id: 'guarniciones', available: true },
];
const menu = items => ({ id: uid(), day: localDate(), status: 'published', reviewed: true, items });
const catalog = activeCatalog('buffet', [], [menu(dishes)]);
const cart = emptyCart('Cliente privado');
const output = (intent = 'help', items = []) => ({ intent, items, customer_name: '', fulfillment: 'a_coordinar', address: '', payment: '', category: '', query: '' });
const guazu = { variant_id: 'guazu', qty: 2, notes: 'bien caliente' };

test('Contexto compacto del buffet conserva candidatos y cantidades sin exponer datos privados', () => {
  const text = 'dos chipas guazú y tres asados a la olla';
  const candidates = recoverCandidates(text, cart, catalog);
  assert.deepEqual(candidates.map(p => p.id), ['guazu', 'asado']);
  assert.equal(recoverCandidates(text, cart, catalog, { expanded: true }).length, 3);
  const json = JSON.stringify(compactContext({ ...cart, address: 'PRIVADO' }, candidates.map(p => ({ ...p, price: 12345, photo: 'PRIVADO' })), defaults));
  assert.doesNotMatch(json, /Cliente privado|PRIVADO|12345/);
  const command = deterministicConversation(text, cart, catalog);
  assert.equal(command.items.length, 2);
  assert.equal(command.items[1].qty, 3);
  assert.equal(quote(command.items, 'buffet', catalog).subtotal, null);
  assert.equal(deterministicConversation('cuánto cuesta la chipa guazú', cart, catalog).intent, 'reference_prices');
});

test('Proveedor simulado amplía candidatos, informa métricas y valida cantidades y disponibilidad', async () => {
  const restore = mockEnvironment();
  const savedFetch = globalThis.fetch;
  const calls = [], metrics = [];
  try {
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.includes('viejo_ai_usage')) { metrics.push(body); return Response.json(null); }
      calls.push(body);
      return Response.json({ model: 'fixture-reportado', status: 'completed', output_text: JSON.stringify(calls.length === 1 ? output() : output('update_cart', [guazu])), usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } });
    };
    const text = 'pasame dos chipas guazú bien calientes';
    assert.equal((await interpret(text, cart, catalog, defaults)).intent, 'update_cart');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].instructions.length > calls[0].instructions.length);
    assert.equal(metrics[1].total_tokens, 13);
    assert.throws(() => validateInterpretation(output('update_cart', [guazu]), 'plato desconocido', cart, catalog, catalog));
    assert.throws(() => validateInterpretation(output('update_cart', [guazu]), 'tres chipas guazú', cart, catalog, catalog));
    assert.throws(() => validateInterpretation(output('update_cart', [guazu]), 'dos chipas guazú y tres asados a la olla', cart, catalog, catalog));
    globalThis.fetch = async () => Response.json({}, { status: 503 });
    await assert.rejects(interpret(text, cart, catalog, defaults));
  } finally {
    globalThis.fetch = savedFetch;
    restore();
  }
});

test('Worker registra el menú vigente y métricas privadas con el proveedor simulado', async () => {
  const context = await databaseV11();
  const restore = mockEnvironment();
  const savedFetch = globalThis.fetch;
  let providerCalls = 0;
  try {
    globalThis.fetch = restBridge(context, { onAI: () => {
      providerCalls++;
      return { output_text: JSON.stringify(output('update_cart', [guazu])), usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
    } }).fetch;
    const { config } = await context.one('select config from guarni_settings');
    await context.staff('settings', { config: { ...config, bot_enabled: true } });
    await context.staff('menu', menu(dishes));
    const say = async text => {
      const incoming = await context.rpc('guarni_ingest', ['fixture.optim.' + uid(), '595000001111', 'Prueba', text]);
      await runWorker();
      return (await context.one('select cart from guarni_conversations where id=$1', [incoming.conversation_id])).cart;
    };
    const ordered = await say('pasame dos chipas guazú bien calientes');
    assert.equal(ordered.items[0].qty, 2);
    assert.equal(ordered.items[0].notes, guazu.notes);
    assert.equal(ordered.subtotal, null);
    assert.equal(providerCalls, 1);
    await context.staff('menu', menu(dishes.map(d => ({ ...d, available: d.id !== 'guazu' }))));
    assert.deepEqual((await say('dos chipas guazú')).items, ordered.items);
    assert.equal(providerCalls, 1);
    await assert.rejects(context.rpc('viejo_quote', ['buffet', ordered.items]), /price_or_availability_changed/);
    assert.equal((await context.one('select count(*)::int n from viejo_ai_usage')).n, 1);
    await context.db.exec('set role authenticated');
    await assert.rejects(context.db.exec('select * from viejo_ai_usage'), /permission denied/);
    await assert.rejects(context.db.exec("insert into viejo_ai_usage(model,operation) values('x','conversation')"), /permission denied/);
  } finally {
    globalThis.fetch = savedFetch;
    restore();
    await context.db.close();
  }
});
test('V1.4 métricas: no inventa tokens ni costos; operaciones separadas y campos permitidos',()=>{
 const row=metricRecord({model:'fixture',operation:'vision',usage:{input_tokens:0,output_tokens:2,total_tokens:2,text:'PRIVADO',secret:'NO',cost:8}});assert.equal(row.input_tokens,0);assert.equal(row.operation,'vision');assert.doesNotMatch(JSON.stringify(row),/PRIVADO|NO|cost/);const unknown=metricRecord({model:'fixture',operation:'conversation',usage:{input_tokens:-1,output_tokens:1.5,total_tokens:'2'}});assert.ok(!('input_tokens'in unknown));assert.ok(!('total_tokens'in unknown));assert.equal(metricRecord({model:'fixture',operation:'other'}),null);
});
