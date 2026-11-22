-- Ubicaciones puntuales de WhatsApp. Aplicar después de 005, en una instalación existente.
-- Esta migración es incremental y no borra registros ni reinterpreta mensajes antiguos.
begin;

alter table public.guarni_messages add column if not exists content_type text not null default 'text';
create table if not exists public.guarni_locations (
 id uuid primary key default gen_random_uuid(),
 message_id uuid not null unique references public.guarni_messages(id) on delete cascade,
 conversation_id uuid not null references public.guarni_conversations(id) on delete cascade,
 kind text not null default 'point' check(kind='point'),
 latitude double precision not null check(latitude between -90 and 90),
 longitude double precision not null check(longitude between -180 and 180),
 name text not null default '' check(length(name)<=200),
 address text not null default '' check(length(address)<=500),
 received_at timestamptz not null default now(),
 whatsapp_sent_at timestamptz,
 review_reason text check(review_reason in ('multiple_orders','accepted_order','stale_location'))
);
create index if not exists guarni_locations_chat on public.guarni_locations(conversation_id,received_at);
alter table public.guarni_conversations add column if not exists draft_location_id uuid references public.guarni_locations(id) on delete set null;
alter table public.guarni_orders add column if not exists delivery_location_id uuid references public.guarni_locations(id) on delete set null;
create table if not exists public.guarni_order_locations (
 id bigint generated always as identity primary key,
 order_id uuid not null references public.guarni_orders(id) on delete cascade,
 location_id uuid not null references public.guarni_locations(id) on delete cascade,
 actor_id uuid, assigned_at timestamptz not null default now()
);
create index if not exists guarni_order_locations_order on public.guarni_order_locations(order_id,assigned_at);
alter table public.guarni_locations enable row level security;
alter table public.guarni_order_locations enable row level security;
revoke all on public.guarni_locations,public.guarni_order_locations from public,anon,authenticated;
grant all on public.guarni_locations,public.guarni_order_locations to service_role;
grant usage,select on sequence public.guarni_order_locations_id_seq to service_role;
grant select on public.guarni_locations,public.guarni_order_locations to authenticated;
drop policy if exists member_read on public.guarni_locations;
create policy member_read on public.guarni_locations for select to authenticated using ((select private.crm_is_member()));
drop policy if exists member_read on public.guarni_order_locations;
create policy member_read on public.guarni_order_locations for select to authenticated using ((select private.crm_is_member()));

create or replace function public.guarni_ingest_location(p_external text,p_wa text,p_name text,p_location jsonb,p_content_type text default 'location',p_timestamp text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare saved jsonb; message_id uuid; latitude double precision; longitude double precision; sent_at timestamptz;
begin
 if p_timestamp is not null then
  if p_timestamp !~ '^[0-9]{1,11}$' then raise exception 'invalid_location_timestamp'; end if;
  sent_at=to_timestamp(p_timestamp::double precision);
 end if;
 if p_content_type is null or p_content_type not in ('location','invalid_location','live_location') then raise exception 'invalid_location_type'; end if;
 if p_content_type='location' then
  if p_location is null or jsonb_typeof(p_location->'latitude') not in ('number','string')
   or jsonb_typeof(p_location->'longitude') not in ('number','string')
   or p_location->>'latitude' is null or p_location->>'longitude' is null then raise exception 'invalid_location'; end if;
  begin
   latitude=(p_location->>'latitude')::double precision;
   longitude=(p_location->>'longitude')::double precision;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'invalid_location'; end;
  if latitude is null or longitude is null or not (latitude between -90 and 90 and longitude between -180 and 180) then raise exception 'invalid_location'; end if;
 end if;
 saved=public.guarni_ingest(p_external,p_wa,p_name,case p_content_type
  when 'location' then 'Ubicación puntual recibida.'
  when 'live_location' then 'Ubicación en tiempo real no compatible.' else 'Ubicación inválida recibida.' end);
 if (saved->>'duplicate')::boolean then return saved; end if;
 update public.guarni_messages set content_type=p_content_type where external_id=p_external returning id into message_id;
 if p_content_type='location' then
  insert into public.guarni_locations(message_id,conversation_id,latitude,longitude,name,address,whatsapp_sent_at)
  values(message_id,(saved->>'conversation_id')::uuid,latitude,longitude,left(coalesce(p_location->>'name',''),200),left(coalesce(p_location->>'address',''),500),sent_at);
 end if;
 return saved;
end $$;

-- Solo este procesador asocia automáticamente ubicaciones, bajo la reserva de la conversación.
create or replace function public.guarni_process_location(p_token uuid,p_job uuid,p_reply_enabled boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.guarni_jobs; c public.guarni_conversations; m public.guarni_messages;
 point public.guarni_locations; candidate public.guarni_orders; candidates integer; reply text; association text;
begin
 select * into j from public.guarni_jobs where id=p_job for update;
 if j.id is null then raise exception 'not_found'; end if;
 if j.status='done' then return jsonb_build_object('duplicate',true); end if;
 select * into c from public.guarni_conversations where id=j.conversation_id for update;
 if c.processing_token is distinct from p_token or c.processing_until<now() then raise exception 'lease_expired'; end if;
 select * into m from public.guarni_messages where id=j.message_id;
 if m.content_type='location' then
  select * into point from public.guarni_locations where message_id=m.id and conversation_id=c.id;
  if point.id is null then raise exception 'invalid_location'; end if;
  select count(*) into candidates from public.guarni_orders where conversation_id=c.id
   and (status='pending' or (status in ('accepted','preparing','ready') and fulfillment='delivery'));
  -- Una entrega demorada no puede reemplazar una ubicación más nueva ni reaparecer en otro pedido.
  if point.whatsapp_sent_at is not null and (
   exists(select 1 from public.guarni_locations previous where previous.conversation_id=c.id
    and previous.id<>point.id and previous.whatsapp_sent_at>point.whatsapp_sent_at)
   or exists(select 1 from public.guarni_orders previous where previous.conversation_id=c.id
    and date_trunc('second',previous.created_at)>point.whatsapp_sent_at)
  ) then
   update public.guarni_locations set review_reason='stale_location' where id=point.id;
   association='review';
   reply='Recibí una ubicación enviada anteriormente 📍. El equipo revisará si corresponde a tu pedido actual.';
  elsif jsonb_array_length(coalesce(c.cart->'items','[]'::jsonb))>0 or c.cart->>'fulfillment' in ('delivery','retiro','local') or candidates=0 then
   update public.guarni_conversations set draft_location_id=point.id where id=c.id;
   association='draft';
   reply='¡Listo, recibí tu ubicación! 📍 Voy a adjuntarla a tu pedido.';
   if jsonb_array_length(coalesce(c.cart->'items','[]'::jsonb))>0 then
    reply=reply||' Para enviar tu solicitud al local, escribí CONFIRMAR PEDIDO.';
   end if;
  elsif candidates=1 then
   select * into candidate from public.guarni_orders where conversation_id=c.id
    and (status='pending' or (status in ('accepted','preparing','ready') and fulfillment='delivery')) for update;
   if candidate.status='pending' and candidate.fulfillment='delivery' then
    update public.guarni_orders set delivery_location_id=point.id,updated_at=now() where id=candidate.id;
    insert into public.guarni_order_locations(order_id,location_id) values(candidate.id,point.id) on conflict do nothing;
    association='pending_order';
    reply='¡Listo, recibí tu ubicación! 📍 La adjunté a tu solicitud #'||candidate.number||', que sigue pendiente de aceptación del local.';
   else
    update public.guarni_locations set review_reason='accepted_order' where id=point.id;
    association='review';
    reply='Recibí tu nueva ubicación 📍. El equipo revisará a qué pedido corresponde y confirmará cualquier cambio.';
   end if;
  else
   update public.guarni_locations set review_reason='multiple_orders' where id=point.id;
   association='review';
   reply='Recibí tu ubicación 📍. Hay varios pedidos en curso y el equipo elegirá a cuál adjuntarla.';
  end if;
 elsif m.content_type='live_location' then
  reply='Para el delivery, enviame tu ubicación actual puntual desde WhatsApp 📍. No hace falta compartirla en tiempo real.';
 elsif m.content_type='invalid_location' then
  reply='No pude leer una ubicación válida. Enviame tu ubicación actual puntual desde WhatsApp 📍.';
 else raise exception 'invalid_location_type'; end if;
 if p_reply_enabled is true and c.mode='bot' then
  insert into public.guarni_messages(conversation_id,direction,actor,body,status,revision)
  values(c.id,'outbound','bot',reply,'queued',c.revision);
 end if;
 update public.guarni_jobs set status='done',error=null where id=j.id;
 update public.guarni_conversations set processing_token=null,processing_until=null,updated_at=now() where id=c.id;
 return jsonb_build_object('association',association);
end $$;

create or replace function public.guarni_assign_location(p_actor uuid,p_order uuid,p_location uuid,p_expected uuid default null,p_approve boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.guarni_orders; c public.guarni_conversations; point public.guarni_locations;
begin
 if not exists(select 1 from public.crm_members where user_id=p_actor) then raise exception 'not_member'; end if;
 select * into o from public.guarni_orders where id=p_order;
 if o.id is null then raise exception 'not_found'; end if;
 select * into c from public.guarni_conversations where id=o.conversation_id for update;
 select * into o from public.guarni_orders where id=p_order for update;
 if o.id is null then raise exception 'not_found'; end if;
 if o.status<>'pending' and (o.status not in ('accepted','preparing','ready') or o.fulfillment<>'delivery') then raise exception 'location_order_closed'; end if;
 if c.processing_until>now() then raise exception 'processing_wait'; end if;
 if o.delivery_location_id is distinct from p_expected then raise exception 'location_changed'; end if;
 if o.status<>'pending' and p_approve is not true then raise exception 'location_approval_required'; end if;
 select * into point from public.guarni_locations where id=p_location and conversation_id=o.conversation_id;
 if point.id is null then raise exception 'invalid_location'; end if;
 if o.delivery_location_id=point.id then return jsonb_build_object('ok',true,'unchanged',true); end if;
 update public.guarni_orders set delivery_location_id=point.id,updated_at=now() where id=o.id;
 insert into public.guarni_order_locations(order_id,location_id,actor_id) values(o.id,point.id,p_actor) on conflict do nothing;
 update public.guarni_locations set review_reason=null where id=point.id;
 update public.guarni_conversations set draft_location_id=null where id=c.id and draft_location_id=point.id;
 insert into public.guarni_audit(actor_id,action,target_id) values(p_actor,'assign_location',o.id::text);
 return jsonb_build_object('ok',true);
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
  if p_cart->>'fulfillment'='delivery' and not exists(
   select 1 from public.guarni_locations where id=c.draft_location_id and conversation_id=c.id
  ) then raise exception 'delivery_location_required'; end if;
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
  if p_cart->>'fulfillment'='delivery' then
   update public.guarni_orders set delivery_location_id=c.draft_location_id where id=o.id returning * into o;
   insert into public.guarni_order_locations(order_id,location_id) values(o.id,c.draft_location_id);
  end if;
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
  processing_token=null,processing_until=null,updated_at=now(),
  draft_location_id=case when p_kind='submit' or exists(
   select 1 from public.guarni_messages where id=j.message_id and lower(btrim(body)) in ('/cancelar','/reiniciar','cancelar pedido')
  ) then null else draft_location_id end where id=c.id;
 update public.guarni_jobs set status='done',error=null where id=p_job;
 return jsonb_build_object('order',to_jsonb(o));
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
   update public.guarni_conversations set mode='bot',owner_id=null,revision=revision+1,cart='{"items":[]}',draft_location_id=null where id=c.id;
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
  select * into o from public.guarni_orders where id=target::uuid;
  if o.id is null then raise exception 'not_found'; end if;
  perform 1 from public.guarni_conversations where id=o.conversation_id for update;
  select * into o from public.guarni_orders where id=target::uuid for update;
  next_status=p_data->>'status';
  if not ((o.status='pending' and next_status in ('accepted','rejected','cancelled')) or
   (o.status='accepted' and next_status in ('preparing','cancelled')) or
   (o.status='preparing' and next_status in ('ready','cancelled')) or
   (o.status='ready' and next_status in ('delivered','cancelled'))) then raise exception 'invalid_transition'; end if;
  if next_status='accepted' then
   if p_data->>'fulfillment' not in ('retiro','delivery','local') or coalesce((p_data->>'shipping_fee')::integer,-1)<0 then raise exception 'confirm_fulfillment_and_fee'; end if;
   if p_data->>'fulfillment'='delivery' and length(btrim(coalesce(p_data->>'address','')))<3 then raise exception 'address_required'; end if;
   if p_data->>'fulfillment'='delivery' and not exists(
    select 1 from public.guarni_locations where id=o.delivery_location_id and conversation_id=o.conversation_id
   ) then raise exception 'delivery_location_required'; end if;
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


-- Mantener las mismas RPC de servidor, sin habilitar escrituras desde el navegador.
revoke all on function public.guarni_ingest_location(text,text,text,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.guarni_process_location(uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.guarni_assign_location(uuid,uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.guarni_ingest_location(text,text,text,jsonb,text,text) to service_role;
grant execute on function public.guarni_process_location(uuid,uuid,boolean) to service_role;
grant execute on function public.guarni_assign_location(uuid,uuid,uuid,uuid,boolean) to service_role;
revoke all on function public.guarni_finish(uuid,uuid,integer,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.guarni_staff(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.guarni_finish(uuid,uuid,integer,jsonb,text,text) to service_role;
grant execute on function public.guarni_staff(uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
