-- V1.1: aplicar UNA VEZ después de 008, también sobre instalaciones existentes.
-- Transaccional y reejecutable. No elimina fotos, pedidos, mensajes ni ubicaciones.
begin;
alter table public.crm_members add column if not exists menu_editor boolean not null default false;
create table if not exists public.viejo_menu_photos (
 id uuid primary key default gen_random_uuid(), hash text not null unique check(hash ~ '^[0-9a-f]{64}$'),
 path text not null unique, content_type text not null check(content_type in ('image/png','image/jpeg','image/webp')),
 byte_size integer not null check(byte_size between 1 and 3145728),created_by uuid references public.crm_members(user_id),
 created_at timestamptz not null default now(), expires_at timestamptz
);
alter table public.viejo_menu_photos enable row level security;
revoke all on public.viejo_menu_photos from public,anon,authenticated;
grant all on public.viejo_menu_photos to service_role;
alter table public.viejo_menus add column if not exists photo_id uuid references public.viejo_menu_photos(id);
alter table public.viejo_menus add column if not exists has_legacy_image boolean generated always as (length(image)>0) stored;
-- Nuevas claves de caché distinguen imagen/modelo/proveedor/versión del esquema.
alter table public.viejo_image_cache add column if not exists usage jsonb;

create or replace function public.viejo_clean_saved_carts(p_saved jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce(jsonb_object_agg(key,jsonb_set(value,'{delivery_location_id}','null')),'{}'::jsonb)
 from jsonb_each(case when jsonb_typeof(p_saved)='object' then p_saved else '{}'::jsonb end)
 where jsonb_typeof(value)='object';
$$;
create or replace function public.viejo_staff(p_actor uuid,p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name text;o public.guarni_orders;c public.guarni_conversations;q jsonb;next_status text;fee integer;amount integer;result jsonb;it jsonb;target uuid;cfg jsonb; schedule jsonb; clock text; dow integer;warning boolean; old_price jsonb;
begin
 select role into role_name from public.crm_members where user_id=p_actor;
 if role_name is null then raise exception 'not_member';end if;
 if p_action in ('settings','member') and role_name<>'admin' then raise exception 'admin_required';end if;
 if p_action='menu' and role_name<>'admin' and not exists(select 1 from public.crm_members where user_id=p_actor and menu_editor) then raise exception 'menu_permission_required';end if;
 if p_action='catalog' and role_name<>'admin' and not exists(select 1 from public.crm_members where user_id=p_actor and catalog_editor) then raise exception 'admin_required';end if;
 if p_action in ('create_order','order_details') then
  if coalesce(p_data->>'fulfillment','a_coordinar') not in ('retiro','delivery','a_coordinar') then raise exception 'invalid_fulfillment';end if;
  if coalesce(p_data->>'payment','a_coordinar')<>'a_coordinar' and not exists(select 1 from public.guarni_settings where payment_methods @> to_jsonb(p_data->>'payment')) then raise exception 'invalid_payment';end if;
 end if;
 if p_action='catalog' then
  if length(btrim(coalesce(p_data->>'name','')))<1 or length(btrim(coalesce(p_data->>'category','')))<1 then raise exception 'invalid_product';end if;
  if (p_data->>'available')::boolean and coalesce((p_data->>'price')::integer,0)<=0 then raise exception 'price_required';end if;
  insert into public.guarni_catalog(id,product_id,name,variant,category,price,available,seasonal)
  values(p_data->>'id',p_data->>'id',left(p_data->>'name',120),left(coalesce(p_data->>'variant','Base'),80),left(p_data->>'category',80),(p_data->>'price')::integer,coalesce((p_data->>'available')::boolean,false),coalesce((p_data->>'seasonal')::boolean,false))
  on conflict(id) do update set name=excluded.name,variant=excluded.variant,category=excluded.category,price=excluded.price,available=excluded.available,seasonal=excluded.seasonal,updated_at=now();
 elsif p_action='settings' then
  cfg=p_data->'config';
  if jsonb_typeof(cfg)<>'object' or cfg->>'timezone'<>'America/Asuncion' or jsonb_typeof(cfg->'payment_methods')<>'array' then raise exception 'invalid_settings';end if;
  foreach next_status in array array['buffet'] loop
   schedule=cfg->'schedules'->next_status;
   if schedule is null or coalesce(schedule->>'open','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(schedule->>'close','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or schedule->>'open'>=schedule->>'close' or jsonb_typeof(schedule->'days')<>'array' then raise exception 'invalid_schedule';end if;
   for it in select * from jsonb_array_elements(schedule->'days') loop
    if it::text !~ '^[0-6]$' then raise exception 'invalid_schedule';end if;
   end loop;
   if (schedule->>'delivery_open' is null)<>(schedule->>'delivery_close' is null) then raise exception 'invalid_schedule';end if;
   if schedule->>'delivery_open' is not null and (schedule->>'delivery_open' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or schedule->>'delivery_close' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or schedule->>'delivery_open'>=schedule->>'delivery_close') then raise exception 'invalid_schedule';end if;
  end loop;
  update public.guarni_settings set config=cfg,payment_methods=cfg->'payment_methods',fulfillment_modes=cfg->'fulfillment_modes',updated_at=now() where id=true;
 elsif p_action='menu' then
  if p_data->>'status' not in ('draft','published') or jsonb_typeof(p_data->'items')<>'array' or jsonb_array_length(p_data->'items')>100 then raise exception 'invalid_menu';end if;
  if p_data->>'status'='published' and (p_data->>'reviewed')::boolean is not true then raise exception 'human_review_required';end if;
  if p_data->>'status'='published' and jsonb_array_length(p_data->'items')<1 then raise exception 'empty_menu';end if;
  for it in select * from jsonb_array_elements(p_data->'items') loop
   if coalesce(length(btrim(it->>'name')),0)<1 or coalesce(length(btrim(it->>'category')),0)<1 or coalesce(length(it->>'id'),0)<1 then raise exception 'invalid_menu_item';end if;
  end loop;
  if (select count(distinct x->>'id') from jsonb_array_elements(p_data->'items') x)<>jsonb_array_length(p_data->'items') then raise exception 'duplicate_item';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_data->>'day',3));
  if exists(select 1 from public.viejo_menus where id=(p_data->>'id')::uuid) then return jsonb_build_object('duplicate',true);end if;
  if p_data->>'status'='published' then update public.viejo_menus set status='archived' where day=(p_data->>'day')::date and status='published';end if;
  if p_data->>'photo_id' is not null and coalesce(p_data->>'image','')<>'' then raise exception 'ambiguous_photo';end if;
  if p_data->>'photo_id' is not null and not exists(select 1 from public.viejo_menu_photos where id=(p_data->>'photo_id')::uuid) then raise exception 'photo_not_found';end if;
  if p_data->>'source_menu_id' is not null and not exists(select 1 from public.viejo_menus where id=(p_data->>'source_menu_id')::uuid) then raise exception 'not_found';end if;
  insert into public.viejo_menus(id,day,status,image,photo_id,items,created_by)
  values((p_data->>'id')::uuid,(p_data->>'day')::date,p_data->>'status',
   case when p_data->>'photo_id' is not null then '' else coalesce(nullif(p_data->>'image',''),(select image from public.viejo_menus where id=(p_data->>'source_menu_id')::uuid),'') end,
   case when nullif(p_data->>'image','') is not null then null else coalesce((p_data->>'photo_id')::uuid,(select photo_id from public.viejo_menus where id=(p_data->>'source_menu_id')::uuid)) end,p_data->'items',p_actor);
 elsif p_action='member' then
  target=(p_data->>'id')::uuid;
  if p_data->>'role' not in ('admin','member') then raise exception 'invalid_role';end if;
  perform pg_advisory_xact_lock(712340);
  if exists(select 1 from public.crm_members where user_id=target and role='admin') and p_data->>'role'<>'admin' and (select count(*) from public.crm_members where role='admin')<=1 then raise exception 'last_admin';end if;
  insert into public.crm_members(user_id,display_name,role,catalog_editor,menu_editor) values(target,left(p_data->>'display_name',120),p_data->>'role',coalesce((p_data->>'catalog_editor')::boolean,false),coalesce((p_data->>'menu_editor')::boolean,false)) on conflict(user_id) do update set display_name=excluded.display_name,role=excluded.role,catalog_editor=excluded.catalog_editor,menu_editor=excluded.menu_editor;
 elsif p_action='create_order' then
  select * into c from public.guarni_conversations where client_id=(p_data->>'client_id')::uuid for update;
  if c.id is null then raise exception 'client_without_conversation';end if;
  q=public.viejo_quote(p_data->>'service',p_data->'items');
  insert into public.guarni_orders(id,client_id,conversation_id,service,items,subtotal,customer_name,note,fulfillment,address,payment,group_id)
  select (p_data->>'request_id')::uuid,c.client_id,c.id,p_data->>'service',q->'items',(q->>'subtotal')::integer,cl.name,left(coalesce(p_data->>'note',''),500),coalesce(p_data->>'fulfillment','a_coordinar'),left(coalesce(p_data->>'address',''),500),coalesce(p_data->>'payment','a_coordinar'),(p_data->>'group_id')::uuid from public.crm_clients cl where cl.id=c.client_id on conflict(id) do nothing;
 elsif p_action in ('order_status','payment_status','order_details') then
  select * into o from public.guarni_orders where id=(p_data->>'id')::uuid;
  if o.id is null then raise exception 'not_found';end if;
  select * into c from public.guarni_conversations where id=o.conversation_id for update;
  select * into o from public.guarni_orders where id=o.id for update;
  if p_action='payment_status' then
   update public.guarni_orders set payment_status=p_data->>'payment_status' where id=o.id;
  elsif p_action='order_details' then
   if o.status not in ('draft','needs_info','pending') then raise exception 'invalid_transition';end if;
   if p_data->>'fulfillment' not in ('retiro','delivery') then raise exception 'invalid_fulfillment';end if;
   update public.guarni_orders set fulfillment=p_data->>'fulfillment',address=left(coalesce(p_data->>'address',''),500),payment=left(coalesce(p_data->>'payment','a_coordinar'),120) where id=o.id;
  else
   next_status=p_data->>'status';
   if not ((o.status in ('draft','needs_info') and next_status in ('pending','cancelled')) or (o.status='pending' and next_status in ('accepted','rejected','cancelled')) or (o.status='accepted' and next_status in ('preparing','cancelled')) or (o.status='preparing' and next_status in ('ready','cancelled')) or (o.status='ready' and next_status in ('out_for_delivery','delivered','cancelled')) or (o.status='out_for_delivery' and next_status in ('delivered','cancelled'))) then raise exception 'invalid_transition';end if;
   if next_status='out_for_delivery' and o.fulfillment<>'delivery' then raise exception 'invalid_transition';end if;
   if next_status='accepted' then
    if p_data->'expected_items' is distinct from o.items then return jsonb_build_object('requote',true,'subtotal',o.subtotal);end if;
    if p_data->>'fulfillment' not in ('retiro','delivery') or p_data->>'fulfillment' is distinct from o.fulfillment then raise exception 'review_fulfillment';end if;
    if o.fulfillment='delivery' and (o.delivery_location_id is null or length(btrim(coalesce(p_data->>'address','')))<3) then raise exception 'delivery_location_required';end if;
    if o.fulfillment='delivery' and not exists(select 1 from public.guarni_locations where id=o.delivery_location_id and conversation_id=o.conversation_id) then raise exception 'invalid_location';end if;
    if o.fulfillment='delivery' and ((p_data->>'shipping_fee') is null or (p_data->>'shipping_fee') !~ '^[0-9]+$') then raise exception 'explicit_delivery_fee_required';end if;
    fee=case when o.fulfillment='delivery' then (p_data->>'shipping_fee')::integer else 0 end;
    if o.group_id is not null and coalesce((p_data->>'group_reviewed')::boolean,false) is not true then raise exception 'group_review_required';end if;
    select s.config->'schedules'->o.service into schedule from public.guarni_settings s where id=true;
    clock=to_char(now() at time zone 'America/Asuncion','HH24:MI');dow=extract(dow from now() at time zone 'America/Asuncion');
    warning=not (coalesce(schedule->'days','[]') @> to_jsonb(dow)) or clock<schedule->>'open' or clock>=schedule->>'close' or (o.fulfillment='delivery' and (schedule->>'delivery_open' is null or clock<schedule->>'delivery_open' or clock>=schedule->>'delivery_close'));
    if coalesce(warning,true) and coalesce((p_data->>'schedule_reviewed')::boolean,false) is not true then raise exception 'schedule_review_required';end if;
    q=public.viejo_quote(o.service,o.items);
    if o.service='chiperia' then
     select jsonb_agg(x->'unit_price') into old_price from jsonb_array_elements(o.items) x;
     if old_price is distinct from (select jsonb_agg(x->'unit_price') from jsonb_array_elements(q->'items') x) then
      update public.guarni_orders set items=q->'items',subtotal=(q->>'subtotal')::integer,total=null,updated_at=now() where id=o.id;
      insert into public.viejo_history(order_id,actor_id,action,before_data,after_data) values(o.id,p_actor,'requote',to_jsonb(o),q);
      insert into public.guarni_messages(conversation_id,direction,actor,body,status) values(c.id,'outbound','system','La cotización de tu solicitud #'||o.number||' cambió. Subtotal actualizado: '||(q->>'subtotal')||' Gs. El equipo revisará la diferencia antes de confirmar.','queued');
      return jsonb_build_object('requote',true,'subtotal',q->'subtotal');
     end if;
     amount=(q->>'subtotal')::integer;
    else
     if c.mode<>'human' or c.owner_id is distinct from p_actor then raise exception 'take_conversation_first';end if;
     if coalesce((p_data->>'price_agreed')::boolean,false) is not true or (p_data->>'buffet_amount') is null or (p_data->>'buffet_amount') !~ '^[0-9]+$' or (p_data->>'buffet_amount')::integer<=0 then raise exception 'agreed_buffet_amount_required';end if;
     amount=(p_data->>'buffet_amount')::integer;
    end if;
    update public.guarni_orders set items=q->'items',subtotal=amount,shipping_fee=fee,total=amount+fee,address=left(coalesce(p_data->>'address',address),500) where id=o.id;
   end if;
   update public.guarni_orders set status=next_status,decided_by=p_actor,decided_at=now(),updated_at=now(),note=left(coalesce(p_data->>'note',note),500) where id=o.id;
   -- Buffet: el importe se comunica personalmente; no lo anuncia el chatbot.
   if o.service='chiperia' or next_status<>'accepted' then
    insert into public.guarni_messages(conversation_id,direction,actor,actor_id,body,status)
    select o.conversation_id,'outbound','system',p_actor,
    case when next_status='accepted' then 'El local confirmó tu pedido de chipería #'||o.number||E'.\n'||(select string_agg((x->>'qty')||' × '||(x->>'name')||': '||(((x->>'qty')::integer*(x->>'unit_price')::integer)::text)||' Gs.',E'\n') from jsonb_array_elements(q->'items') x)||E'\nSubtotal: '||amount||' Gs. Delivery: '||fee||' Gs. Total confirmado: '||(amount+fee)||' Gs. Modalidad: '||o.fulfillment||'. Pago: '||o.payment||case when o.payment_status='paid' then ' (pago recibido registrado).' else ' (recepción pendiente).' end
    else 'Pedido #'||o.number||': '||case next_status when 'preparing' then 'en preparación' when 'ready' then 'listo' when 'out_for_delivery' then 'en reparto' when 'delivered' then 'entregado o retirado' when 'rejected' then 'rechazado' else 'cancelado' end||'.' end,'queued';
   end if;
  end if;
  insert into public.viejo_history(order_id,actor_id,action,before_data,after_data) select o.id,p_actor,p_action,to_jsonb(o),to_jsonb(n) from public.guarni_orders n where id=o.id;
 else
  return public.guarni_staff(p_actor,p_action,p_data);
 end if;
 insert into public.guarni_audit(actor_id,action,target_id) values(p_actor,p_action,p_data->>'id');
 return jsonb_build_object('ok',true);
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



-- Permisos explícitos también al reejecutar.
do $$ declare f record; begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('viejo_staff','guarni_finish','viejo_clean_saved_carts') loop
 execute 'revoke all on function '||f.sig||' from public,anon,authenticated';
 execute 'grant execute on function '||f.sig||' to service_role';end loop;
end $$;
commit;
