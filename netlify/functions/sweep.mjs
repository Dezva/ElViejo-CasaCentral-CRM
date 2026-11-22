import {env} from '../lib/platform.mjs';
// La recuperación programada despierta el mismo procesador; no ejecuta IA en el límite de cron.
export default async ()=>{
 if(!env('URL')||!env('WORKER_SECRET'))return;
 await fetch(env('URL')+'/.netlify/functions/dispatch-background',{method:'POST',headers:{'x-worker-secret':env('WORKER_SECRET')},signal:AbortSignal.timeout(5000)});
};
export const config={schedule:'* * * * *'};
