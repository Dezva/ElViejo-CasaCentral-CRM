-- Proyecto Supabase NUEVO y separado de Velturio. Ejecutar después de 001.
alter table public.crm_clients add column if not exists whatsapp_id text unique;
create table if not exists public.guarni_catalog (
 id text primary key, product_id text not null, name text not null,
 variant text not null, category text not null, price integer not null check(price>0),
 available boolean not null default true, updated_at timestamptz not null default now()
);
create table if not exists public.guarni_settings (
 id boolean primary key default true check(id),
 fulfillment_modes jsonb not null default '[]', payment_methods jsonb not null default '[]',
 hours text not null default '', delivery_notes text not null default '', updated_at timestamptz not null default now()
);
insert into public.guarni_settings(id) values(true) on conflict do nothing;
create table if not exists public.guarni_conversations (
 id uuid primary key default gen_random_uuid(), client_id uuid not null references public.crm_clients(id),
 wa_id text not null unique, mode text not null default 'bot' check(mode in ('bot','human')),
 owner_id uuid references public.crm_members(user_id), revision integer not null default 0,
 cart jsonb not null default '{"items":[]}', unread integer not null default 0,
 last_inbound_at timestamptz, updated_at timestamptz not null default now(),
 processing_token uuid, processing_until timestamptz
);
create table if not exists public.guarni_messages (
 id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.guarni_conversations(id),
 external_id text unique, direction text not null check(direction in ('inbound','outbound')),
 actor text not null check(actor in ('customer','bot','staff','system')), actor_id uuid,
 body text not null check(length(body) between 1 and 4096),
 status text not null check(status in ('received','queued','sending','sent','failed','uncertain','cancelled')),
 revision integer, error text, created_at timestamptz not null default now(), sent_at timestamptz, sending_started_at timestamptz
);
create index if not exists guarni_messages_chat on public.guarni_messages(conversation_id,created_at);
create table if not exists public.guarni_jobs (
 id uuid primary key default gen_random_uuid(), message_id uuid not null unique references public.guarni_messages(id),
 conversation_id uuid not null references public.guarni_conversations(id),
 status text not null default 'pending' check(status in ('pending','processing','done','failed')),
 attempts integer not null default 0, available_at timestamptz not null default now(),
 created_at timestamptz not null default now(), error text
);
create table if not exists public.guarni_orders (
 id uuid primary key default gen_random_uuid(), number bigint generated always as identity unique,
 client_id uuid not null references public.crm_clients(id), conversation_id uuid references public.guarni_conversations(id),
 source_message_id uuid unique references public.guarni_messages(id),
 status text not null default 'pending' check(status in ('pending','accepted','preparing','ready','delivered','rejected','cancelled')),
 items jsonb not null, subtotal integer not null check(subtotal>0), shipping_fee integer check(shipping_fee>=0),
 total integer, customer_name text not null, fulfillment text not null default 'a_coordinar',
 address text not null default '', payment text not null default 'a_coordinar', note text not null default '',
 decided_by uuid, decided_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.guarni_audit (
 id bigint generated always as identity primary key, actor_id uuid, action text not null,
 target_id text, created_at timestamptz not null default now()
);
-- Los usuarios no escriben pedidos, mensajes ni asignaciones directamente.
-- Las acciones pasan por Functions y RPCs transaccionales restringidas a service_role.
do $$ declare t text; begin
 foreach t in array array['guarni_catalog','guarni_settings','guarni_conversations','guarni_messages','guarni_orders','guarni_jobs','guarni_audit'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public, anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  if t not in ('guarni_jobs','guarni_audit') then
   execute format('grant select on public.%I to authenticated',t);
   execute format('drop policy if exists member_read on public.%I',t);
   execute format('create policy member_read on public.%I for select to authenticated using ((select private.crm_is_member()))',t);
  end if;
 end loop;
end $$;
grant all on public.crm_members,public.crm_clients to service_role;
grant usage,select on all sequences in schema public to service_role;

create or replace function public.guarni_ingest(p_external text,p_wa text,p_name text,p_body text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.guarni_conversations; client uuid; msg uuid;
begin
 if p_wa !~ '^[0-9]{7,18}$' or length(p_external)>200 or length(p_body) not between 1 and 4096 then raise exception 'invalid_message'; end if;
 -- Un mismo webhook reintentado no incrementa no leídos ni crea otro trabajo.
 perform pg_advisory_xact_lock(hashtextextended(p_wa,0));
 if exists(select 1 from public.guarni_messages where external_id=p_external) then return jsonb_build_object('duplicate',true); end if;
 insert into public.crm_clients(name,phone,service,status,whatsapp_id)
 values(coalesce(nullif(left(p_name,120),''),'Cliente WhatsApp'),'+'||p_wa,'WhatsApp','nuevo',p_wa)
 on conflict(whatsapp_id) do update set phone=excluded.phone
 returning id into client;
 insert into public.guarni_conversations(client_id,wa_id) values(client,p_wa)
 on conflict(wa_id) do nothing;
 update public.guarni_conversations set unread=unread+1,last_inbound_at=now(),updated_at=now()
 where wa_id=p_wa returning * into c;
 insert into public.guarni_messages(conversation_id,external_id,direction,actor,body,status)
 values(c.id,p_external,'inbound','customer',p_body,'received') returning id into msg;
 insert into public.guarni_jobs(message_id,conversation_id) values(msg,c.id);
 return jsonb_build_object('duplicate',false,'conversation_id',c.id);
end $$;

create or replace function public.guarni_claim(p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.guarni_conversations; j public.guarni_jobs; m public.guarni_messages;
begin
 -- Recuperación de procesos interrumpidos. El envío ambiguo nunca se reintenta a ciegas.
 update public.guarni_messages set status='uncertain',error='Envío interrumpido; verificar en WhatsApp antes de reenviar.'
 where status='sending' and sending_started_at<now()-interval '3 minutes';
 update public.guarni_jobs set status='failed',error='Se agotaron los reintentos. Requiere revisión del equipo.'
 where status in ('pending','processing') and attempts>=5 and available_at<now();
 select v.* into c from public.guarni_conversations v
 where (v.processing_until is null or v.processing_until<now()) and (
  exists(select 1 from public.guarni_messages x where x.conversation_id=v.id and x.status='queued') or
  exists(select 1 from public.guarni_jobs x where x.conversation_id=v.id and x.status in ('pending','processing') and x.available_at<=now() and x.attempts<5)
 ) order by v.updated_at for update of v skip locked limit 1;
 if c.id is null then return null; end if;
 update public.guarni_conversations set processing_token=p_token,processing_until=now()+interval '120 seconds' where id=c.id;
 -- Primero emitir respuestas ya preparadas, preservando el orden por conversación.
 update public.guarni_messages set status='cancelled' where conversation_id=c.id and status='queued' and actor='bot' and (c.mode='human' or revision<>c.revision);
 select * into m from public.guarni_messages where conversation_id=c.id and status='queued' order by created_at,id for update skip locked limit 1;
 if m.id is not null then
  if c.last_inbound_at is null or c.last_inbound_at<now()-interval '24 hours' then
   update public.guarni_messages set status='failed',error='Fuera de la ventana de atención. Esperar un mensaje nuevo del cliente.' where id=m.id;
   update public.guarni_conversations set processing_token=null,processing_until=null where id=c.id;
   return jsonb_build_object('kind','skip');
  end if;
  update public.guarni_messages set status='sending',sending_started_at=now() where id=m.id;
  return jsonb_build_object('kind','send','conversation',to_jsonb(c),'message',to_jsonb(m));
 end if;
 select * into j from public.guarni_jobs where conversation_id=c.id and status in ('pending','processing') and attempts<5 and available_at<=now()
 order by created_at,id for update skip locked limit 1;
 if j.id is null then
  update public.guarni_conversations set processing_token=null,processing_until=null where id=c.id; return jsonb_build_object('kind','skip');
 end if;
 update public.guarni_jobs set status='processing',attempts=attempts+1,available_at=now()+interval '125 seconds' where id=j.id;
 select * into m from public.guarni_messages where id=j.message_id;
 return jsonb_build_object('kind','inbound','conversation',to_jsonb(c),'job',to_jsonb(j),'message',to_jsonb(m));
end $$;

create or replace function public.guarni_finish(p_token uuid,p_job uuid,p_revision integer,p_cart jsonb,p_body text,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.guarni_conversations; j public.guarni_jobs; it jsonb; v public.guarni_catalog; itemlist jsonb='[]'; amount integer=0; o public.guarni_orders;
begin
 select * into j from public.guarni_jobs where id=p_job for update;
 if j.status='done' then return jsonb_build_object('duplicate',true); end if;
 select * into c from public.guarni_conversations where id=j.conversation_id for update;
 if c.processing_token is distinct from p_token or c.processing_until<now() then raise exception 'lease_expired'; end if;
 if c.mode='human' or c.revision<>p_revision or p_kind='ignore' then
  update public.guarni_jobs set status='done' where id=p_job;
  update public.guarni_conversations set processing_token=null,processing_until=null where id=c.id;
  return jsonb_build_object('discarded',true);
 end if;
 if p_kind not in ('reply','submit','human') then raise exception 'invalid_action'; end if;
 if p_kind='submit' then
  if coalesce((c.cart->>'quoted')::boolean,false) is not true or jsonb_array_length(p_cart->'items') not between 1 and 30 then raise exception 'not_quoted'; end if;
  if c.cart->'items' is distinct from p_cart->'items' then raise exception 'cart_changed'; end if;
  for it in select * from jsonb_array_elements(p_cart->'items') loop
   select * into v from public.guarni_catalog where id=it->>'variant_id' for share;
   if v.id is null or not v.available or v.price<>(it->>'unit_price')::integer or (it->>'qty')::integer not between 1 and 30 then raise exception 'price_or_availability_changed'; end if;
   amount=amount+v.price*(it->>'qty')::integer;
   itemlist=itemlist||jsonb_build_array(jsonb_build_object('variant_id',v.id,'name',v.name,'variant',v.variant,'unit_price',v.price,'qty',(it->>'qty')::integer,'notes',left(coalesce(it->>'notes',''),300)));
  end loop;
  insert into public.guarni_orders(client_id,conversation_id,source_message_id,items,subtotal,customer_name,fulfillment,address,payment)
  values(c.client_id,c.id,j.message_id,itemlist,amount,coalesce(nullif(p_cart->>'customer_name',''),'Cliente WhatsApp'),coalesce(p_cart->>'fulfillment','a_coordinar'),coalesce(p_cart->>'address',''),coalesce(p_cart->>'payment','a_coordinar'))
  returning * into o;
  p_body='Solicitud #'||o.number||' registrada. Está PENDIENTE DE ACEPTACIÓN DEL LOCAL. El equipo confirmará disponibilidad, modalidad, costo de envío y tiempo de preparación.';
  p_cart='{"items":[]}';
 end if;
 if length(p_body)>0 then
  insert into public.guarni_messages(conversation_id,direction,actor,body,status,revision)
  values(c.id,'outbound',case when p_kind='human' then 'system' else 'bot' end,left(p_body,4096),'queued',c.revision);
 end if;
 update public.guarni_conversations set cart=p_cart,
  mode=case when p_kind='human' then 'human' else mode end,
  revision=revision+case when p_kind='human' then 1 else 0 end,
  processing_token=null,processing_until=null,updated_at=now() where id=c.id;
 update public.guarni_jobs set status='done',error=null where id=p_job;
 return jsonb_build_object('order',to_jsonb(o));
end $$;

create or replace function public.guarni_sent(p_token uuid,p_message uuid,p_status text,p_external text default null,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare c public.guarni_conversations; m public.guarni_messages;
begin
 select * into m from public.guarni_messages where id=p_message;
 select * into c from public.guarni_conversations where id=m.conversation_id for update;
 if c.processing_token is distinct from p_token then raise exception 'lease_expired'; end if;
 if p_status not in ('sent','failed','uncertain','cancelled') then raise exception 'invalid_status'; end if;
 update public.guarni_messages set status=p_status,external_id=coalesce(p_external,external_id),error=left(p_error,300),sent_at=case when p_status='sent' then now() else null end where id=p_message;
 update public.guarni_conversations set processing_token=null,processing_until=null where id=c.id;
end $$;

create or replace function public.guarni_retry(p_token uuid,p_job uuid,p_error text)
returns void language plpgsql security definer set search_path='' as $$
declare j public.guarni_jobs;
begin
 select * into j from public.guarni_jobs where id=p_job;
 if exists(select 1 from public.guarni_conversations where id=j.conversation_id and processing_token=p_token) then
  update public.guarni_jobs set status=case when attempts>=5 then 'failed' else 'pending' end,available_at=now()+interval '20 seconds',error=left(p_error,200) where id=p_job;
  update public.guarni_conversations set processing_token=null,processing_until=null where id=j.conversation_id;
 end if;
end $$;

create or replace function public.guarni_staff(p_actor uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name text; c public.guarni_conversations; o public.guarni_orders; next_status text; target text; mid uuid; it jsonb; v public.guarni_catalog; itemlist jsonb='[]'; amount integer=0;
begin
 select role into role_name from public.crm_members where user_id=p_actor;
 if role_name is null then raise exception 'not_member'; end if;
 target=p_data->>'id';
 if p_action in ('take','release','read','send') then
  select * into c from public.guarni_conversations where id=target::uuid for update;
  if c.id is null then raise exception 'not_found'; end if;
  if p_action='take' then
   if c.owner_id is not null and c.owner_id<>p_actor and role_name<>'admin' then raise exception 'owned_by_another_member'; end if;
   update public.guarni_conversations set mode='human',owner_id=p_actor,revision=revision+1,unread=0 where id=c.id;
   update public.guarni_messages set status='cancelled' where conversation_id=c.id and actor='bot' and status='queued';
  elsif p_action='release' then
   if c.owner_id is distinct from p_actor and role_name<>'admin' then raise exception 'not_owner'; end if;
   if c.processing_until>now() then raise exception 'processing_wait'; end if;
   update public.guarni_conversations set mode='bot',owner_id=null,revision=revision+1,cart='{"items":[]}' where id=c.id;
   -- No responder retroactivamente a mensajes recibidos durante atención humana.
   update public.guarni_jobs set status='done' where conversation_id=c.id and status in ('pending','processing');
  elsif p_action='read' then
   update public.guarni_conversations set unread=0 where id=c.id;
  else
   if c.mode<>'human' or c.owner_id is distinct from p_actor then raise exception 'take_conversation_first'; end if;
   if c.last_inbound_at is null or c.last_inbound_at<now()-interval '24 hours' then raise exception 'outside_customer_window'; end if;
   if length(btrim(p_data->>'body')) not between 1 and 4096 then raise exception 'invalid_body'; end if;
   mid=(p_data->>'request_id')::uuid;
   insert into public.guarni_messages(id,conversation_id,direction,actor,actor_id,body,status)
   values(mid,c.id,'outbound','staff',p_actor,btrim(p_data->>'body'),'queued') on conflict(id) do nothing;
  end if;
 elsif p_action='create_order' then
  if jsonb_array_length(p_data->'items') not between 1 and 30 then raise exception 'invalid_items'; end if;
  select * into c from public.guarni_conversations where client_id=(p_data->>'client_id')::uuid;
  if c.id is null then raise exception 'client_without_conversation'; end if;
  for it in select * from jsonb_array_elements(p_data->'items') loop
   select * into v from public.guarni_catalog where id=it->>'variant_id' for share;
   if v.id is null or not v.available or (it->>'qty')::integer not between 1 and 30 then raise exception 'invalid_items'; end if;
   amount=amount+v.price*(it->>'qty')::integer;
   itemlist=itemlist||jsonb_build_array(jsonb_build_object('variant_id',v.id,'name',v.name,'variant',v.variant,'unit_price',v.price,'qty',(it->>'qty')::integer,'notes',left(coalesce(it->>'notes',''),300)));
  end loop;
  insert into public.guarni_orders(id,client_id,conversation_id,items,subtotal,customer_name,note)
  select (p_data->>'request_id')::uuid,c.client_id,c.id,itemlist,amount,cl.name,left(coalesce(p_data->>'note',''),500)
  from public.crm_clients cl where cl.id=c.client_id on conflict(id) do nothing;
 elsif p_action='order_status' then
  select * into o from public.guarni_orders where id=target::uuid for update;
  next_status=p_data->>'status';
  if not ((o.status='pending' and next_status in ('accepted','rejected','cancelled')) or
   (o.status='accepted' and next_status in ('preparing','cancelled')) or
   (o.status='preparing' and next_status in ('ready','cancelled')) or
   (o.status='ready' and next_status in ('delivered','cancelled'))) then raise exception 'invalid_transition'; end if;
  if next_status='accepted' then
   if p_data->>'fulfillment' not in ('retiro','delivery','local') or coalesce((p_data->>'shipping_fee')::integer,-1)<0 then raise exception 'confirm_fulfillment_and_fee'; end if;
   if p_data->>'fulfillment'='delivery' and length(btrim(coalesce(p_data->>'address','')))<3 then raise exception 'address_required'; end if;
  end if;
  update public.guarni_orders set status=next_status,note=left(coalesce(p_data->>'note',note),500),updated_at=now(),
   shipping_fee=case when next_status='accepted' then (p_data->>'shipping_fee')::integer else shipping_fee end,
   total=case when next_status='accepted' then subtotal+(p_data->>'shipping_fee')::integer else total end,
   fulfillment=case when next_status='accepted' then p_data->>'fulfillment' else fulfillment end,
   address=coalesce(p_data->>'address',address),decided_by=p_actor,decided_at=now() where id=o.id returning * into o;
  insert into public.guarni_messages(conversation_id,direction,actor,actor_id,body,status)
  values(o.conversation_id,'outbound','system',p_actor,
   case when next_status='accepted' then 'El local ACEPTÓ tu pedido #'||o.number||'. Total confirmado: '||o.total||' Gs. Modalidad: '||o.fulfillment||'.'
   when next_status='rejected' then 'El local no pudo aceptar tu pedido #'||o.number||'. '||coalesce(p_data->>'note','Podés consultar otra opción por este chat.')
   else 'Pedido #'||o.number||': '||case next_status when 'preparing' then 'en preparación' when 'ready' then 'listo' when 'delivered' then 'entregado' else 'cancelado' end||'.' end,'queued');
 elsif p_action='catalog' then
  if role_name<>'admin' then raise exception 'admin_required'; end if;
  update public.guarni_catalog set price=(p_data->>'price')::integer,available=(p_data->>'available')::boolean,updated_at=now() where id=target;
 elsif p_action='settings' then
  if role_name<>'admin' then raise exception 'admin_required'; end if;
  update public.guarni_settings set fulfillment_modes=p_data->'fulfillment_modes',payment_methods=p_data->'payment_methods',hours=left(p_data->>'hours',500),delivery_notes=left(p_data->>'delivery_notes',1000),updated_at=now() where id=true;
 elsif p_action='client' then
  update public.crm_clients set name=left(p_data->>'name',120),notes=left(coalesce(p_data->>'notes',''),3000),updated_at=now() where id=target::uuid;
 else raise exception 'unknown_action'; end if;
 insert into public.guarni_audit(actor_id,action,target_id) values(p_actor,p_action,target);
 return jsonb_build_object('ok',true);
end $$;

-- Aplicar a todas las RPCs actuales de esta migración, sin conceder funciones ajenas.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('guarni_ingest','guarni_claim','guarni_finish','guarni_sent','guarni_retry','guarni_staff') loop
  execute 'revoke all on function '||f.signature||' from public, anon, authenticated';
  execute 'grant execute on function '||f.signature||' to service_role';
 end loop;
end $$;
