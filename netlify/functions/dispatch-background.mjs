import {runWorker} from '../lib/worker.mjs';
import {env} from '../lib/platform.mjs';
import {workerAuthorized} from '../lib/worker-auth.mjs';
export default async request=>{
 if(request.method!=='POST'||!workerAuthorized(request.headers.get('x-worker-secret'),env('WORKER_SECRET')))return new Response('Forbidden',{status:403});
 await runWorker({budgetMs:50000});return new Response('OK');
};
export const config={background:true};
