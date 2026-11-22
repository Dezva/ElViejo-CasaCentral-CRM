import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import health from '../netlify/functions/health.mjs';
import sweep, { config as sweepConfig } from '../netlify/functions/sweep.mjs';
import dispatch from '../netlify/functions/dispatch-background.mjs';
import webhook from '../netlify/functions/whatsapp.mjs';
import { aiProviderFailure } from '../netlify/lib/ai-errors.mjs';
import { databaseV11, mockEnvironment, restBridge } from './v11-helpers.mjs';

const healthUrl = 'https://fixture.test/.netlify/functions/health';

test('Diagnóstico separa configuración, activación y conexión sin divulgar datos', async t => {
  t.after(mockEnvironment());
  for (const name of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_SEND_ENABLED', 'META_APP_SECRET']) {
    delete process.env[name];
  }
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  Object.assign(process.env, { OPENAI_API_KEY: 'legacy-fixture-key', OPENAI_MODEL: 'legacy-fixture-model', AI_VISION_MODEL: 'vision-fixture-model', AI_IMAGE_ENABLED: 'true', PUBLIC_SUPABASE_KEY: 'sb_publishable_fixture', SUPABASE_SECRET_KEY: 'sb_secret_fixture' });
  let role = 'member';
  let failRpc = false;
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/auth/v1/user')) {
      assert.equal(options.headers.apikey, 'sb_publishable_fixture');
      assert.equal(options.headers.authorization, 'Bearer fixture-session');
      return Response.json({ id: 'private-user' });
    }
    assert.equal(options.headers.apikey, 'sb_secret_fixture');
    assert.equal(options.headers.authorization, undefined);
    if (url.includes('crm_members')) return Response.json([{ role }]);
    if (url.includes('guarni_settings')) return Response.json([{ id: true }]);
    assert.match(url, /viejo_pending_orders$/);
    assert.equal(options.method, 'POST');
    return failRpc ? Response.json({ message: 'private-upstream' }, { status: 503 }) : Response.json([{ id: 'private-order' }]);
  });
  const get = await health(new Request(healthUrl));
  const { services } = await get.json();
  assert.equal(services.openAiConversation.status, 'configured');
  assert.equal(services.openAiVision.connectivity, 'not_checked');
  assert.equal(services.whatsappSend.status, 'disabled');
  assert.equal(services.whatsappWebhook.status, 'not_configured');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal((await health(new Request(healthUrl, { method: 'POST' }))).status, 401);
  assert.equal(fetch.mock.callCount(), 0);
  const probe = () => health(new Request(healthUrl, { method: 'POST', headers: { authorization: 'Bearer fixture-session' } }));
  assert.equal((await probe()).status, 403);
  role = 'admin';
  const verified = await probe();
  const body = await verified.json();
  assert.equal(body.services.supabaseBackend.connectivity, 'verified');
  assert.doesNotMatch(JSON.stringify(body), /private-|fixture|https:/);
  failRpc = true;
  const failure = await probe();
  assert.equal(failure.status, 503);
  assert.equal((await failure.json()).services.supabaseBackend.connectivity, 'connection_error');
  process.env.AI_BASE_URL = 'http://invalid.test';
  const invalid = await health(new Request(healthUrl));
  assert.equal((await invalid.json()).services.openAiVision.status, 'invalid_configuration');
});

test('Cron dispara el worker protegido y recupera un trabajo con reserva vencida en PGlite', async t => {
  const context = await databaseV11();
  t.after(() => context.db.close());
  t.after(mockEnvironment());
  Object.assign(process.env, { URL: 'https://fixture.test', WORKER_SECRET: 'fixture-worker', BOT_ENABLED: 'false' });
  const incoming = await context.rpc('guarni_ingest', ['fixture-recovery', '595000000000', 'Prueba', 'hola']);
  const claimed = await context.rpc('guarni_claim', [randomUUID()]);
  assert.equal(claimed.conversation.id, incoming.conversation_id);
  await context.db.query("update guarni_conversations set processing_until=now()-interval '1 second' where id=$1", [incoming.conversation_id]);
  assert.equal(await context.rpc('guarni_claim', [randomUUID()]), null);
  await context.db.query("update guarni_jobs set available_at=now()-interval '1 second' where id=$1", [claimed.job.id]);
  const bridge = restBridge(context);
  const dispatchUrl = 'https://fixture.test/.netlify/functions/dispatch-background';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === dispatchUrl) {
      assert.equal(options.redirect, 'error');
      const response = await dispatch(new Request(url, options));
      return response.ok ? new Response(null, { status: 202 }) : response;
    }
    return bridge.fetch(url, options);
  });
  assert.equal((await dispatch(new Request(dispatchUrl, { method: 'POST' }))).status, 403);
  assert.equal(sweepConfig.schedule, '* * * * *');
  assert.equal((await sweep()).status, 200);
  assert.equal((await context.one('select status from guarni_jobs where id=$1', [claimed.job.id])).status, 'done');
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'private' }, { status: 403 }));
  assert.equal((await sweep()).status, 502);
});

test('Proveedor de IA clasifica fallos sin transmitir detalles y el webhook distingue verificación de presencia', async t => {
  for (const [status, upstream, code] of [[401, '', 'ai_authentication'], [404, '', 'ai_model_or_format'], [429, 'insufficient_quota', 'ai_quota'], [429, '', 'ai_rate_limit'], [503, '', 'ai_unavailable']]) {
    const failure = await aiProviderFailure(Response.json({ error: { code: upstream, message: 'private-upstream' } }, { status }));
    assert.equal(failure.code, code);
    assert.doesNotMatch(JSON.stringify(failure), /private-upstream/);
  }
  const restore = mockEnvironment();
  t.after(restore);
  process.env.WHATSAPP_VERIFY_TOKEN = 'fixture-verify';
  const target = 'https://fixture.test/.netlify/functions/whatsapp';
  assert.equal((await webhook(new Request(target))).status, 200);
  assert.equal((await webhook(new Request(target+'?hub.mode=subscribe&hub.challenge=123&hub.verify_token=wrong'))).status, 403);
  assert.equal(await (await webhook(new Request(target+'?hub.mode=subscribe&hub.challenge=123&hub.verify_token=fixture-verify'))).text(), '123');
});
