// Supabase Auth existente; la autorización del CRM sigue a cargo de la API.
const sessionKey='viejo-session';
const expired=()=>Object.assign(Error('Tu sesión venció. Volvé a ingresar.'),{status:401});
export function createSessionClient({config,storage=sessionStorage,fetchImpl=(...args)=>fetch(...args),onInvalid=()=>{}}){
 let session=null,revision=0,refreshing=null;
 try{const saved=JSON.parse(storage.getItem(sessionKey)||'null');if(saved&&typeof saved.access_token==='string'&&saved.access_token&&Number.isFinite(saved.expires_at))session=saved;else storage.removeItem(sessionKey);}catch{try{storage.removeItem(sessionKey);}catch{/* Sin sesión persistida. */}}
 const headers=()=>({apikey:config.publishableKey,'content-type':'application/json'});
 function save(value){if(!value||typeof value.access_token!=='string'||!value.access_token||!Number.isFinite(value.expires_in)||value.expires_in<=0)throw expired();session={...value,expires_at:Math.floor(Date.now()/1000)+value.expires_in};storage.setItem(sessionKey,JSON.stringify(session));}
 function invalidate(error){revision++;session=null;refreshing=null;try{storage.removeItem(sessionKey);}catch{/* La sesión en memoria también se elimina. */}onInvalid(error);}
 async function refresh(){
  if(refreshing)return refreshing;
  const version=revision,token=session?.refresh_token;
  const task=(async()=>{try{if(!token)throw expired();const r=await fetchImpl(config.supabaseUrl+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:headers(),body:JSON.stringify({refresh_token:token}),signal:AbortSignal.timeout(12000)});if(version!==revision)throw expired();if(!r.ok)throw expired();const payload=await r.json();if(version!==revision)throw expired();save(payload);return session.access_token;}catch{if(version===revision)invalidate(expired());throw expired();}})();
  refreshing=task;try{return await task;}finally{if(refreshing===task)refreshing=null;}
 }
 async function getToken(){if(!session)throw expired();if(session.expires_at*1000<Date.now()+30000)return refresh();return session.access_token;}
 return {
  hasSession:()=>!!session,version:()=>revision,invalidate,getToken,
  async signIn(email,password){const version=++revision;let r;try{r=await fetchImpl(config.supabaseUrl+'/auth/v1/token?grant_type=password',{method:'POST',headers:headers(),body:JSON.stringify({email,password}),signal:AbortSignal.timeout(15000)});}catch{throw Error('No pudimos conectar. Revisá tu conexión e intentá de nuevo.');}if(version!==revision)throw expired();if(!r.ok)throw Error(r.status===429?'Hubo demasiados intentos. Esperá unos minutos y volvé a intentar.':'No pudimos ingresar. Revisá el correo y la contraseña.');try{const payload=await r.json();if(version!==revision)throw expired();save(payload);}catch{session=null;try{storage.removeItem(sessionKey);}catch{}throw Error('No pudimos guardar la sesión. Revisá que el navegador permita los datos del sitio e intentá de nuevo.');}},
  async request(url,options={}){const version=revision;let token=await getToken();if(version!==revision)throw expired();const send=()=>fetchImpl(url,{...options,signal:options.signal||AbortSignal.timeout(20000),headers:{...options.headers,authorization:'Bearer '+token}});let response=await send();if(version!==revision)throw expired();if(response.status===401){token=await refresh();if(version!==revision)throw expired();response=await send();if(version!==revision)throw expired();if(response.status===401){invalidate(expired());throw expired();}}return response;},
  async signOut(){const token=session?.access_token;invalidate();if(token)try{await fetchImpl(config.supabaseUrl+'/auth/v1/logout?scope=local',{method:'POST',headers:{...headers(),authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});}catch{/* El cierre local es inmediato, incluso sin conexión. */}}
 };
}
