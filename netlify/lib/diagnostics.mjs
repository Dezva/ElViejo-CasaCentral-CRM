import {env,db} from './platform.mjs';

export function safeDiagnosticError(message){
 let text=String(message||'Error sin detalle');
 for(const name of ['WHATSAPP_TOKEN','META_APP_SECRET','WHATSAPP_VERIFY_TOKEN','SUPABASE_SECRET_KEY','OPENAI_API_KEY','WORKER_SECRET']){
  const secret=env(name);if(secret)text=text.replaceAll(secret,'[secreto oculto]');
 }
 return text.slice(0,450);
}

// Solo lecturas: no envía mensajes ni cambia suscripciones en Meta.
export async function whatsappDiagnostics(){
 const phone=env('WHATSAPP_PHONE_NUMBER_ID').trim(),version=env('WHATSAPP_GRAPH_VERSION').trim(),token=env('WHATSAPP_TOKEN').trim();
 const result={checked_at:new Date().toISOString(),bot_enabled:env('BOT_ENABLED')==='true',phone_number_id:phone,graph_version:version,meta:{ok:false},inbound:{ok:false},queue:{ok:false},outbound:{ok:false}};
 const checks=[
  (async()=>{try{
   if(!/^\d+$/.test(phone)||!/^v\d+\.\d+$/.test(version)||!token){result.meta={ok:false,message:'Revisá Phone Number ID, versión con prefijo v y token.'};return;}
   const response=await fetch(`https://graph.facebook.com/${version}/${phone}?fields=id,display_phone_number,verified_name`,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
   const data=await response.json().catch(()=>({}));
   result.meta=response.ok&&data.id?{ok:true,display_phone_number:data.display_phone_number||'',verified_name:data.verified_name||'',message:'Meta permite consultar este número con el token configurado.'}:{ok:false,http_status:response.status,code:data.error?.code||null,subcode:data.error?.error_subcode||null,message:safeDiagnosticError(data.error?.message||'Meta no confirmó acceso al número.')};
  }catch(error){result.meta={ok:false,message:safeDiagnosticError(error.message)};}})(),
  (async()=>{try{const rows=await db('/rest/v1/guarni_messages?direction=eq.inbound&select=created_at&order=created_at.desc&limit=1');result.inbound={ok:true,last_received_at:rows[0]?.created_at||null,message:rows.length?'Hay mensajes entrantes guardados.':'Todavía no hay mensajes entrantes guardados. El estado GET del webhook no prueba recepción.'};}catch(error){result.inbound={ok:false,code:error.code||null,message:safeDiagnosticError(error.message)};}})(),
  (async()=>{try{const rows=await db('/rest/v1/guarni_jobs?select=status,attempts&order=created_at.desc&limit=100');result.queue={ok:true,sample_size:rows.length,pending:rows.filter(x=>x.status==='pending').length,processing:rows.filter(x=>x.status==='processing').length,failed:rows.filter(x=>x.status==='failed').length,done:rows.filter(x=>x.status==='done').length};}catch(error){result.queue={ok:false,code:error.code||null,message:safeDiagnosticError(error.message)};}})(),
  (async()=>{try{const rows=await db('/rest/v1/guarni_messages?direction=eq.outbound&select=created_at,status,error&order=created_at.desc&limit=1');result.outbound={ok:true,last_status:rows[0]?.status||null,last_at:rows[0]?.created_at||null,last_error:rows[0]?.error?safeDiagnosticError(rows[0].error):null};}catch(error){result.outbound={ok:false,code:error.code||null,message:safeDiagnosticError(error.message)};}})()
 ];
 await Promise.all(checks);return result;
}
