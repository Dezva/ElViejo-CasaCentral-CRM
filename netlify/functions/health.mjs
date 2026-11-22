import { env, json, member, db, rpc } from '../lib/platform.mjs';
import { providerConfig } from '../../shared/ai-provider.js';

function configuration(required, enabled = true, valid = true) {
  const missing = required.filter(names => !names.split(' o ').some(name => env(name).trim()));
  const status = !enabled ? 'disabled' : missing.length ? 'not_configured' : valid ? 'configured' : 'invalid_configuration';
  return { status, missing, connectivity: enabled ? 'not_checked' : 'disabled' };
}

export default async function health(request) {
  const method = request?.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const flags = {
    bot: env('BOT_ENABLED') === 'true',
    whatsappSend: env('WHATSAPP_SEND_ENABLED') === 'true',
    image: env('AI_IMAGE_ENABLED') === 'true',
    privatePhotos: env('MENU_PHOTO_STORAGE_ENABLED') === 'true',
  };
  let aiEndpointValid = true;
  try { providerConfig(env); } catch { aiEndpointValid = false; }
  const { AI_BASE_URL: aiBaseUrl } = process.env;
  const services = {
    supabaseBackend: configuration(['SUPABASE_URL', 'SUPABASE_SECRET_KEY']),
    supabaseFrontend: configuration(['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_KEY'], true,
      env('PUBLIC_SUPABASE_KEY').startsWith('sb_publishable_')),
    aiEndpoint: { source: aiBaseUrl ? 'custom' : 'default', valid: aiEndpointValid },
    openAiConversation: configuration(['AI_API_KEY o OPENAI_API_KEY', 'AI_MODEL o OPENAI_MODEL'], flags.bot, aiEndpointValid),
    openAiVision: configuration(['AI_API_KEY o OPENAI_API_KEY', 'AI_VISION_MODEL o OPENAI_VISION_MODEL'], flags.image, aiEndpointValid),
    whatsappWebhook: configuration(['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'META_APP_SECRET']),
    whatsappSend: configuration(['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_GRAPH_VERSION', 'WHATSAPP_TOKEN'], flags.whatsappSend),
    worker: configuration(['WORKER_SECRET']),
    privatePhotos: configuration(['SUPABASE_URL', 'SUPABASE_SECRET_KEY'], flags.privatePhotos),
  };

  if (method === 'POST') {
    if (services.supabaseBackend.status !== 'configured') return json({ error: 'supabase_not_configured' }, 503);
    let actor;
    try { actor = await member(request); }
    catch (error) {
      return json({ error: error.status === 401 ? 'invalid_session' : error.status === 403 ? 'not_member' : 'connection_error' },
        error.status || 503);
    }
    if (actor.role !== 'admin') return json({ error: 'admin_required' }, 403);
    // Verifica lectura de tablas y ejecución de una RPC de solo lectura.
    try {
      const [settings, pending] = await Promise.all([
        db('/rest/v1/guarni_settings?id=eq.true&select=id'),
        rpc('viejo_pending_orders', {}),
      ]);
      services.supabaseBackend.connectivity = settings?.[0]?.id === true && Array.isArray(pending)
        ? 'verified' : 'connection_error';
    } catch { services.supabaseBackend.connectivity = 'connection_error'; }
  }

  return json({
    service: 'Buffet El Viejo — Casa Central',
    flags,
    services,
    note: 'La presencia de variables no comprueba conectividad. POST con sesión de administrador verifica solo Supabase. Las demás integraciones requieren pruebas independientes.',
  }, services.supabaseBackend.connectivity === 'connection_error' ? 503 : 200);
}
