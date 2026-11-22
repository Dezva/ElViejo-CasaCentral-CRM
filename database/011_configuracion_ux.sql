-- Configuración amigable: aplicar después de 010. Aditiva y reejecutable.
begin;
create table if not exists public.viejo_settings_ux_backup (
 version text primary key,config jsonb not null,created_at timestamptz not null default now()
);
alter table public.viejo_settings_ux_backup enable row level security;
revoke all on public.viejo_settings_ux_backup from public,anon,authenticated;
grant all on public.viejo_settings_ux_backup to service_role;
insert into public.viejo_settings_ux_backup(version,config) select '011',config from public.guarni_settings where id=true on conflict do nothing;

create or replace function public.viejo_delivery_mode(p_config jsonb,p_service text) returns text
language sql immutable set search_path='' as $$
 select case
 when p_config->'schedules'->p_service->>'delivery_mode' in ('scheduled','pending','disabled') then p_config->'schedules'->p_service->>'delivery_mode'
 when jsonb_typeof(p_config->'fulfillment_modes')='array' and not (p_config->'fulfillment_modes' @> '"delivery"'::jsonb) then 'disabled'
 when coalesce(p_config->'schedules'->p_service->>'delivery_open','') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and coalesce(p_config->'schedules'->p_service->>'delivery_close','') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then 'scheduled'
 else 'pending' end;
$$;
-- No altera horas, días, tarifas, pedidos ni el estado global de delivery existente.
update public.guarni_settings set config=jsonb_set(config,'{schedules,buffet,delivery_mode}',to_jsonb(public.viejo_delivery_mode(config,'buffet')))
 where config ? 'schedules';
-- Métodos desconocidos quedan en el backup y en legacy_payment_methods; no se activan por equivalencia inventada.
update public.guarni_settings set config=jsonb_set(jsonb_set(config,'{legacy_payment_methods}',
 coalesce(config->'legacy_payment_methods','[]')||coalesce((select jsonb_agg(x) from jsonb_array_elements(coalesce(config->'payment_methods','[]')) x where x #>> '{}' not in ('Efectivo','Tarjeta de débito','Tarjeta de crédito','QR','Transferencia')),'[]')),
 '{payment_methods}',coalesce((select jsonb_agg(value order by n) from (select value,min(n) n from jsonb_array_elements(coalesce(config->'payment_methods','[]')) with ordinality t(value,n) where value #>> '{}' in ('Efectivo','Tarjeta de débito','Tarjeta de crédito','QR','Transferencia') group by value) v),'[]'));
update public.guarni_settings set payment_methods=config->'payment_methods' where id=true;

create or replace function public.viejo_validate_settings(p_config jsonb) returns void
language plpgsql set search_path='' as $$
declare service text;s jsonb;d jsonb;mode text;v jsonb;k text;
begin
 if jsonb_typeof(p_config) is distinct from 'object' then raise exception 'invalid_settings';end if;
 if jsonb_typeof(p_config->'business_name') is distinct from 'string' or length(btrim(p_config->>'business_name')) not between 1 and 120 then raise exception 'business_name_required';end if;
 foreach k in array array['branch','business_address','business_phone','business_email'] loop
  if p_config ? k and (jsonb_typeof(p_config->k) is distinct from 'string' or length(p_config->>k)>500) then raise exception 'invalid_business_contact';end if;
 end loop;
 if coalesce(p_config->>'business_email','')<>'' and p_config->>'business_email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'invalid_business_contact';end if;
 if coalesce(p_config->>'logo_url','')<>'' and (p_config->>'logo_url' !~ '^(assets/[A-Za-z0-9_./-]+|https://[^[:space:]]+)$' or length(p_config->>'logo_url')>1000) then raise exception 'invalid_business_logo';end if;
 if p_config->>'timezone' is distinct from 'America/Asuncion' or jsonb_typeof(p_config->'bot_enabled') is distinct from 'boolean' then raise exception 'invalid_settings';end if;
 if jsonb_typeof(p_config->'payment_methods') is distinct from 'array' then raise exception 'invalid_payment_methods';end if;
 for v in select * from jsonb_array_elements(p_config->'payment_methods') loop
  if jsonb_typeof(v)<>'string' or v #>> '{}' not in ('Efectivo','Tarjeta de débito','Tarjeta de crédito','QR','Transferencia') then raise exception 'invalid_payment_methods';end if;
 end loop;
 if (select count(distinct x) from jsonb_array_elements(p_config->'payment_methods') x)<>jsonb_array_length(p_config->'payment_methods') then raise exception 'invalid_payment_methods';end if;
 if jsonb_typeof(p_config->'fulfillment_modes') is distinct from 'array' then raise exception 'invalid_fulfillment_modes';end if;
 for v in select * from jsonb_array_elements(p_config->'fulfillment_modes') loop
  if jsonb_typeof(v)<>'string' or v #>> '{}' not in ('retiro','delivery','local') then raise exception 'invalid_fulfillment_modes';end if;
 end loop;
 if (select count(distinct x) from jsonb_array_elements(p_config->'fulfillment_modes') x)<>jsonb_array_length(p_config->'fulfillment_modes') then raise exception 'invalid_fulfillment_modes';end if;
 if ((p_config->'schedules') - 'buffet'::text) <> '{}'::jsonb then raise exception 'invalid_schedule';end if;
 foreach service in array array['buffet'] loop
  s=p_config->'schedules'->service;
  if jsonb_typeof(s) is distinct from 'object' or jsonb_typeof(s->'days') is distinct from 'array' then raise exception 'invalid_schedule';end if;

  for d in select * from jsonb_array_elements(s->'days') loop
   if jsonb_typeof(d)<>'number' or d::text !~ '^[0-6]$' then raise exception 'invalid_schedule_days';end if;
  end loop;
  if (select count(distinct x) from jsonb_array_elements(s->'days') x)<>jsonb_array_length(s->'days') then raise exception 'invalid_schedule_days';end if;
  if (jsonb_array_length(s->'days')>0 or coalesce(s->>'open','')<>'' or coalesce(s->>'close','')<>'') and (jsonb_array_length(s->'days')=0 or coalesce(s->>'open','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(s->>'close','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then raise exception 'schedule_time_required';end if;
  if jsonb_array_length(s->'days')>0 and s->>'open'>=s->>'close' then raise exception 'schedule_close_after_open';end if;
  mode=s->>'delivery_mode';if mode is null or mode not in ('scheduled','pending','disabled') then raise exception 'delivery_mode_required';end if;
  if mode='scheduled' then
   if jsonb_array_length(s->'days')=0 or coalesce(s->>'delivery_open','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(s->>'delivery_close','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'delivery_time_required';end if;
   if s->>'delivery_open'>=s->>'delivery_close' then raise exception 'delivery_close_after_open';end if;
   if s->>'delivery_open'<s->>'open' or s->>'delivery_close'>s->>'close' then raise exception 'delivery_outside_hours';end if;
  end if;
 end loop;
 if (p_config->'fulfillment_modes' @> '"delivery"'::jsonb) is distinct from (public.viejo_delivery_mode(p_config,'buffet')<>'disabled') then raise exception 'invalid_fulfillment_modes';end if;
 foreach k in array array['guarniciones','carne','pollo_chancho'] loop
  v=p_config->'reference_prices'->k;
  if v is null or v='null'::jsonb then continue;end if;
  if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^[0-9]+$' then raise exception 'invalid_reference_prices';end if;
  if v::text::numeric not between 1 and 2147483647 then raise exception 'invalid_reference_prices';end if;
 end loop;
end $$;

-- Una sola copia de la RPC anterior, sin cambiar permisos ni otorgar escritura directa.
do $$ begin
 if to_regprocedure('public.viejo_staff_v12_base(uuid,text,jsonb)') is null then
  alter function public.viejo_staff(uuid,text,jsonb) rename to viejo_staff_v12_base;
 end if;
end $$;
create or replace function public.viejo_staff(p_actor uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare cfg jsonb;role_name text;service text;fulfillment text;mode text;
begin
 select role into role_name from public.crm_members where user_id=p_actor;
 if role_name is null then raise exception 'not_member';end if;
 if p_action in ('catalog','catalog_category') or (p_action='member' and coalesce((p_data->>'catalog_editor')::boolean,false)) then raise exception 'invalid_action';end if;
 select config into cfg from public.guarni_settings where id=true;
 if p_action='settings' then
  if role_name<>'admin' then raise exception 'admin_required';end if;
  perform public.viejo_validate_settings(p_data->'config');
  update public.guarni_settings set config=p_data->'config',payment_methods=p_data->'config'->'payment_methods',fulfillment_modes=p_data->'config'->'fulfillment_modes',updated_at=now() where id=true;
  insert into public.guarni_audit(actor_id,action,target_id) values(p_actor,'settings','true');
  return jsonb_build_object('ok',true);
 end if;
 if p_action='create_order' then service=p_data->>'service';fulfillment=p_data->>'fulfillment';
 elsif p_action='order_status' and p_data->>'status'='accepted' then
  select o.service,o.fulfillment into service,fulfillment from public.guarni_orders o where id=(p_data->>'id')::uuid;
 end if;
 if fulfillment='delivery' then
  mode=public.viejo_delivery_mode(cfg,service);
  if mode='disabled' then raise exception 'delivery_disabled';end if;
  if p_action='order_status' and mode='pending' and coalesce((p_data->>'schedule_reviewed')::boolean,false) is not true then raise exception 'schedule_review_required';end if;
 end if;
 return public.viejo_staff_v12_base(p_actor,p_action,p_data);
end $$;
create or replace function public.guarni_finish(p_token uuid,p_job uuid,p_revision integer,p_cart jsonb,p_body text,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.guarni_conversations; j public.guarni_jobs; it jsonb; v public.guarni_catalog; itemlist jsonb='[]'; amount integer=0; o public.guarni_orders; q jsonb; related uuid; submitted boolean=false; service_changed boolean;
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
 service_changed=c.cart->>'service' is not null and coalesce(c.cart->>'service','')<>coalesce(p_cart->>'service','');
 if p_kind='submit' then
  submitted=true;
  if p_cart->>'fulfillment'='delivery' and public.viejo_delivery_mode((select config from public.guarni_settings where id=true),p_cart->>'service')='disabled' then raise exception 'delivery_disabled';end if;
  if p_cart->>'fulfillment'='delivery' and not exists(
   select 1 from public.guarni_locations where id=c.draft_location_id and conversation_id=c.id
  ) then raise exception 'delivery_location_required'; end if;
  if coalesce((c.cart->>'quoted')::boolean,false) is not true or jsonb_array_length(p_cart->'items') not between 1 and 30 then raise exception 'not_quoted'; end if;
  if c.cart->'items' is distinct from p_cart->'items' then raise exception 'cart_changed'; end if;
  q=public.viejo_quote(p_cart->>'service',p_cart->'items');
  if q->'items' is distinct from p_cart->'items' then raise exception 'price_or_availability_changed';end if;
  itemlist=q->'items'; amount=(q->>'subtotal')::integer;
  if p_cart->>'fulfillment' not in ('retiro','delivery') then raise exception 'fulfillment_required';end if;
  if p_cart->>'fulfillment'='delivery' and length(btrim(coalesce(p_cart->>'address','')))<3 then raise exception 'address_required';end if;
  select coalesce(group_id,gen_random_uuid()) into related from public.guarni_orders where conversation_id=c.id and service<>p_cart->>'service' and status in ('pending','accepted','preparing','ready') order by created_at desc limit 1;
  if related is not null then update public.guarni_orders set group_id=related where conversation_id=c.id and status in ('pending','accepted','preparing','ready');end if;
  insert into public.guarni_orders(client_id,conversation_id,source_message_id,service,group_id,items,subtotal,customer_name,fulfillment,address,payment)
  values(c.client_id,c.id,j.message_id,p_cart->>'service',related,itemlist,amount,coalesce(nullif(p_cart->>'customer_name',''),'Cliente WhatsApp'),coalesce(p_cart->>'fulfillment','a_coordinar'),coalesce(p_cart->>'address',''),coalesce(p_cart->>'payment','a_coordinar'))
  returning * into o;
  if p_cart->>'fulfillment'='delivery' then
   update public.guarni_orders set delivery_location_id=c.draft_location_id where id=o.id returning * into o;
   insert into public.guarni_order_locations(order_id,location_id) values(o.id,c.draft_location_id);
  end if;
  p_body='Solicitud #'||o.number||' registrada. Está PENDIENTE DE ACEPTACIÓN DEL LOCAL. El equipo confirmará disponibilidad, modalidad, costo de envío y tiempo de preparación.';
  if p_cart->>'service'='buffet' then p_kind='human';end if;
  p_cart=jsonb_build_object('items','[]'::jsonb,'service',p_cart->>'service','saved_carts',public.viejo_clean_saved_carts(p_cart->'saved_carts'));

 end if;
 if length(p_body)>0 then
  insert into public.guarni_messages(conversation_id,direction,actor,body,status,revision)
  values(c.id,'outbound',case when p_kind='human' then 'system' else 'bot' end,left(p_body,4096),'queued',c.revision);
 end if;
 update public.guarni_conversations set cart=case when submitted or service_changed or p_cart->>'fulfillment'='retiro' then jsonb_set(p_cart,'{delivery_location_id}','null') else p_cart end,
  mode=case when p_kind='human' then 'human' else mode end,
  revision=revision+case when p_kind='human' then 1 else 0 end,
  processing_token=null,processing_until=null,updated_at=now(),
  draft_location_id=case when submitted or service_changed or p_cart->>'fulfillment'='retiro' or exists(
   select 1 from public.guarni_messages where id=j.message_id and lower(btrim(body)) in ('/cancelar','/reiniciar','cancelar pedido')
  ) then null else draft_location_id end where id=c.id;
 update public.guarni_jobs set status='done',error=null where id=p_job;
 return jsonb_build_object('order',to_jsonb(o));
end $$;




do $$ declare f record;begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('viejo_staff','viejo_staff_v12_base','viejo_delivery_mode','viejo_validate_settings','guarni_finish') loop
 execute 'revoke all on function '||f.sig||' from public,anon,authenticated';
 execute 'grant execute on function '||f.sig||' to service_role';end loop;
end $$;
-- La copia anterior solo es invocada por el wrapper definer; no es una ruta alternativa de cliente.
revoke execute on function public.viejo_staff_v12_base(uuid,text,jsonb) from service_role;
commit;
