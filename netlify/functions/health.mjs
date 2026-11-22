import {env,json} from '../lib/platform.mjs';
export default async()=>{
 const names=['SUPABASE_URL','SUPABASE_SECRET_KEY','WHATSAPP_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_VERIFY_TOKEN','META_APP_SECRET','WHATSAPP_GRAPH_VERSION','OPENAI_API_KEY','OPENAI_MODEL','WORKER_SECRET'];
 const missing=names.filter(n=>!env(n));
 return json({service:'El Viejo CRM',configured:missing.length===0,missing,botEnabled:env('BOT_ENABLED')==='true',outboundEnabled:env('WHATSAPP_SEND_ENABLED')==='true',imageEnabled:env('AI_IMAGE_ENABLED')==='true',note:'Comprueba presencia de configuración, no validez de credenciales ni conectividad.'});
};
