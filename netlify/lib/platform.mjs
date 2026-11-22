import {createHmac,timingSafeEqual} from 'node:crypto';
export const env=(key,fallback='')=>process.env[key]??fallback;
export function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
// Adaptado del verificador de Veli, conservando comparación en tiempo constante.
export function verifySignature(raw,signature,secret=env('META_APP_SECRET')){
 if(!secret||!signature?.startsWith('sha256='))return false;
 const expected='sha256='+createHmac('sha256',secret).update(raw,'utf8').digest('hex');
 const a=Buffer.from(signature),b=Buffer.from(expected);
 return a.length===b.length&&timingSafeEqual(a,b);
}
export async function db(path,{method='GET',body,token,prefer}={}){
 const url=env('SUPABASE_URL'),key=env('SUPABASE_SECRET_KEY');
 if(!url||!key)throw Error('backend_not_configured');
 const headers={apikey:key,'content-type':'application/json'};
 if(prefer)headers.prefer=prefer;
 if(token)headers.authorization='Bearer '+token;
 const r=await fetch(url+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});
 const data=await r.json().catch(()=>null);
 if(!r.ok){const error=Error(data?.message||'database_error');error.code=data?.code;throw error;}
 return data;
}
export const rpc=(name,body)=>db('/rest/v1/rpc/'+name,{method:'POST',body});
export async function member(request){
 const token=request.headers.get('authorization')?.replace(/^Bearer /i,'');
 if(!token)throw Object.assign(Error('Iniciá sesión.'),{status:401});
 let u;try{u=await db('/auth/v1/user',{token});}catch{throw Object.assign(Error('Sesión inválida o vencida.'),{status:401});}
 const rows=await db('/rest/v1/crm_members?user_id=eq.'+encodeURIComponent(u.id)+'&select=user_id,display_name,role,catalog_editor,menu_editor');
 if(!rows?.length)throw Object.assign(Error('Tu cuenta no es integrante del CRM.'),{status:403});
 return rows[0];
}
export async function kick(request){
 const secret=env('WORKER_SECRET');if(!secret)return;
 const origin=new URL(request.url).origin;
 try{await fetch(origin+'/.netlify/functions/dispatch-background',{method:'POST',headers:{'x-worker-secret':secret},signal:AbortSignal.timeout(2500)});}catch{/* La función programada recupera la cola. */}
}
export function safeSecretEqual(a,b){if(!a||!b)return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
// Extracción de texto reutilizada del recorrido Responses de Veli.
export function extractText(data){
 if(typeof data?.output_text==='string'&&data.output_text.trim())return data.output_text.trim();
 return (data?.output||[]).flatMap(x=>(x.content||[]).filter(c=>c.type==='output_text').map(c=>c.text)).join('\n').trim();
}
