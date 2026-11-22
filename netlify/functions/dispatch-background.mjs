import {runWorker} from '../lib/worker.mjs';
import {env,safeSecretEqual} from '../lib/platform.mjs';
export default async request=>{
 if(request.method!=='POST'||!safeSecretEqual(request.headers.get('x-worker-secret'),env('WORKER_SECRET')))return new Response('Forbidden',{status:403});
 await runWorker({budgetMs:50000});return new Response('OK');
};
export const config={background:true};
