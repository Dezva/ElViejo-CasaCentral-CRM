import { env, json, dispatchWorker } from '../lib/platform.mjs';

// La recuperación programada despierta el procesador asíncrono.
export default async function sweep() {
  const site = env('URL');
  const secret = env('WORKER_SECRET');
  if (!site || !secret) return json({ status: 'not_configured' }, 503);
  try {
    const response = await dispatchWorker(site,{timeoutMs:5000});
    if (response.ok) return json({ status: 'dispatch_accepted' });
  } catch { /* Los detalles privados no se exponen. */ }
  return json({ status: 'dispatch_error' }, 502);
}
export const config = { schedule: '* * * * *' };
