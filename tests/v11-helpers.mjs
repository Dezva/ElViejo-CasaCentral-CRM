import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
export async function databaseV11({categories=true,settings=true,individual=true}={}){
 const db=new PGlite({initialMemory:128*1024*1024});
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;`);
 for(const name of ['001_base_crm','002_guarnipitan','005_eliminacion_admin','006_ubicaciones_delivery','007_el_viejo','009_v11_fiabilidad'])await db.exec(await readFile(new URL('../database/'+name+'.sql',import.meta.url),'utf8'));
 if(categories)await db.exec(await readFile(new URL('../database/010_buffet_categories.sql',import.meta.url),'utf8'));
 if(categories&&settings)await db.exec(await readFile(new URL('../database/011_configuracion_ux.sql',import.meta.url),'utf8'));
 if(categories&&settings&&individual)await db.exec(await readFile(new URL('../database/013_metricas_ia.sql',import.meta.url),'utf8'));
 if(categories&&settings&&individual)await db.exec(await readFile(new URL('../database/014_avisos_pedidos.sql',import.meta.url),'utf8'));
 const admin=randomUUID(),editor=randomUUID(),employee=randomUUID();
 for(const [id,role,menu] of [[admin,'admin',false],[editor,'member',true],[employee,'member',false]]){
  await db.query('insert into auth.users values($1,$2)',[id,id+'@example.test']);
  await db.query('insert into crm_members(user_id,display_name,role,menu_editor) values($1,$2,$3,$4)',[id,role,role,menu]);
 }
 const rpc=async(name,args)=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
 const staff=(action,data,actor=admin)=>rpc('viejo_staff',[actor,action,data]);
 return {db,rpc,one,staff,admin,editor,employee};
}
export function mockEnvironment(){
 const previous={...process.env};Object.assign(process.env,{SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SECRET_KEY:'fixture-only',BOT_ENABLED:'true',WHATSAPP_SEND_ENABLED:'false',AI_IMAGE_ENABLED:'false',AI_MODEL:'fixture',AI_API_KEY:'fixture',AI_BASE_URL:'https://fixture-ai.test/v1'});
 return ()=>{for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);};
}
export function restBridge(context,{actor=context.admin,onAI}={}){
 const {db}=context;const calls=[];
 const fetch=async(input,options={})=>{
  const url=new URL(input),body=options.body?JSON.parse(options.body):null;calls.push({path:url.pathname,query:url.search,body});
  if(url.hostname==='fixture-ai.test'){if(!onAI)throw Error('No debe llamar IA en este escenario');return Response.json(await onAI(body));}
  if(url.hostname!=='fixture.supabase.test')throw Error('Destino externo inesperado: '+url.hostname);
  if(url.pathname==='/auth/v1/user')return Response.json({id:typeof actor==='function'?actor():actor});
  try{
   if(url.pathname.startsWith('/rest/v1/rpc/')){
    const name=url.pathname.split('/').at(-1);if(!/^(guarni_|viejo_)[a-z_]+$/.test(name))throw Error('RPC no permitida');
    const keys=Object.keys(body);if(keys.some(k=>!/^p_[a-z_]+$/.test(k)))throw Error('Parámetro inválido');
    const result=(await db.query(`select public.${name}(${keys.map((k,i)=>k+'=> $'+(i+1)).join(',')}) as result`,Object.values(body))).rows[0].result;
    return Response.json(result);
   }
   const table=url.pathname.split('/').at(-1);
   if(!['crm_clients','crm_members','guarni_catalog','guarni_settings','guarni_conversations','guarni_orders','guarni_messages','guarni_jobs','viejo_menus','viejo_history','viejo_catalog_categories','viejo_ai_usage'].includes(table))throw Error('Tabla no permitida: '+table);
   if(table==='viejo_ai_usage'&&options.method==='POST'){await db.query('insert into viejo_ai_usage(id,model,operation,input_tokens,output_tokens,total_tokens,context_chars,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[body.id,body.model,body.operation,body.input_tokens??null,body.output_tokens??null,body.total_tokens??null,body.context_chars??null,body.created_at]);return Response.json(null);}
   let select=url.searchParams.get('select')||'*';if(!/^[a-z_,*]+$/.test(select))throw Error('SELECT no soportado en prueba');
   const args=[],where=[];
   for(const [key,value] of url.searchParams){if(['select','order','limit'].includes(key))continue;if(!/^[a-z_]+$/.test(key)||!value.startsWith('eq.'))throw Error('Filtro no soportado: '+key);args.push(value.slice(3));where.push(key+'=$'+args.length);}
   const sql=`select ${select} from public.${table}`+(where.length?' where '+where.join(' and '):'');
   const rows=(await db.query(sql,args)).rows;
   if(table==='viejo_menus')for(const row of rows)if(row.day)row.day=(row.day instanceof Date?row.day.toISOString():String(row.day)).slice(0,10);
   return Response.json(rows);
  }catch(error){return Response.json({message:error.message,code:error.code},{status:400});}
 };
 return {fetch,calls};
}
