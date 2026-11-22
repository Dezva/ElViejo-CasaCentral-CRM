import {env,json,verifySignature,rpc,kick} from '../lib/platform.mjs';
import {safeDiagnosticError} from '../lib/diagnostics.mjs';
import {parseLocationMessage} from '../../shared/locations.js';
export default async request=>{
 const url=new URL(request.url);
 if(request.method==='GET'){
  if(url.searchParams.get('hub.mode')==='subscribe'&&env('WHATSAPP_VERIFY_TOKEN')&&url.searchParams.get('hub.verify_token')===env('WHATSAPP_VERIFY_TOKEN'))return new Response(url.searchParams.get('hub.challenge')||'');
  return json({service:'Guarnipitan WhatsApp',ok:true,diagnostics_version:1,note:'Esta consulta GET solo comprueba que la función existe. Los mensajes reales llegan mediante POST desde Meta.'});
 }
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 const raw=await request.text();if(raw.length>1000000)return json({error:'payload_too_large'},413);
 console.info('whatsapp_webhook_received',JSON.stringify({bytes:raw.length,signature_present:!!request.headers.get('x-hub-signature-256')}));
 if(!verifySignature(raw,request.headers.get('x-hub-signature-256'))){console.warn('whatsapp_signature_rejected',JSON.stringify({app_secret_configured:!!env('META_APP_SECRET')}));return json({error:'invalid_signature'},401);}
 let payload;try{payload=JSON.parse(raw);}catch{return json({error:'invalid_json'},400);}
 const counts={accepted:0,duplicates:0,ignored_numbers:0,status_events:0};
 try{
  for(const entry of payload.entry||[])for(const change of entry.changes||[]){
   const v=change.value;
   if(v?.metadata?.phone_number_id!==env('WHATSAPP_PHONE_NUMBER_ID').trim()){
    counts.ignored_numbers++;
    const actual=v?.metadata?.phone_number_id;
    console.warn('whatsapp_number_mismatch',JSON.stringify({expected_phone_number_id:env('WHATSAPP_PHONE_NUMBER_ID').trim(),received_phone_number_id:typeof actual==='string'&&/^\d+$/.test(actual)?actual:null}));
    continue;
   }
   counts.status_events+=(v.statuses||[]).length;
   for(const m of v.messages||[]){
    if(!m.from||!m.id)continue;
    const profile=v.contacts?.find(c=>c.wa_id===m.from)?.profile?.name||'';
    if(m.type==='location'||m.type==='live_location'){
     const point=parseLocationMessage(m);
     const saved=await rpc('guarni_ingest_location',{p_external:m.id,p_wa:m.from,p_name:profile,p_location:point.location,p_content_type:point.content_type,...(m.timestamp?{p_timestamp:String(m.timestamp)}:{})});
     if(saved?.duplicate)counts.duplicates++;else counts.accepted++;
     continue;
    }
    const body=m.type==='text'?m.text?.body:m.type==='interactive'?(m.interactive?.button_reply?.title||m.interactive?.list_reply?.title):`[Contenido ${m.type||'multimedia'} recibido: requiere atención humana]`;
    if(!body)continue;
    const saved=await rpc('guarni_ingest',{p_external:m.id,p_wa:m.from,p_name:profile,p_body:String(body).slice(0,4096)});
    if(saved?.duplicate)counts.duplicates++;else counts.accepted++;
   }
  }
  if(counts.accepted||counts.duplicates)await kick(request);
  console.info('whatsapp_webhook_processed',JSON.stringify(counts));
  return json({ok:true,...counts});
 }catch(error){console.error('webhook_persistence_failed',JSON.stringify({code:error.code||null,message:safeDiagnosticError(error.message)}));return json({error:'retry_later'},503);}
};
