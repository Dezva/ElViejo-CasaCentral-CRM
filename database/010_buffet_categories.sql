-- V1.2: aplicar después de 009. Conserva snapshot de categorías originales.
begin;
create table if not exists public.viejo_menu_category_history (
 menu_id uuid primary key references public.viejo_menus(id) on delete cascade,
 original_items jsonb not null,migrated_at timestamptz not null default now()
);
alter table public.viejo_menu_category_history enable row level security;
revoke all on public.viejo_menu_category_history from public,anon,authenticated;
grant all on public.viejo_menu_category_history to service_role;
insert into public.viejo_menu_category_history(menu_id,original_items)
select id,items from public.viejo_menus on conflict(menu_id) do nothing;

create or replace function public.viejo_buffet_category_id(p_value text) returns text
language sql immutable set search_path='' as $$
 select case lower(btrim(coalesce(p_value,'')))
 when 'guarniciones' then 'guarniciones' when 'carne' then 'carne'
 when 'pollo_chancho' then 'pollo_chancho' when 'pollo y chancho' then 'pollo_chancho'
 else 'pending' end;
$$;
update public.viejo_menus m set items=(
 select coalesce(jsonb_agg((x.item-'category')||jsonb_build_object(
 'category_id',public.viejo_buffet_category_id(coalesce(x.item->>'category_id',x.item->>'category')),
 'available',case when public.viejo_buffet_category_id(coalesce(x.item->>'category_id',x.item->>'category'))='pending' then false else case when jsonb_typeof(x.item->'available')='boolean' then (x.item->>'available')::boolean else false end end) order by x.n),'[]'::jsonb)
 from jsonb_array_elements(m.items) with ordinality x(item,n)
);
update public.guarni_settings set config=jsonb_set(config,'{reference_prices}',
 (coalesce(config->'reference_prices','{}')-'pollo_cerdo')||jsonb_build_object('pollo_chancho',
 coalesce(config->'reference_prices'->'pollo_chancho',config->'reference_prices'->'pollo_cerdo','null'::jsonb))) where config ? 'reference_prices';
-- Cambia solo el marcador provisional anterior, nunca un recurso personalizado.
update public.guarni_settings set config=jsonb_set(config,'{logo_url}','"assets/abuelito-provisional.png"')
 where config->>'logo_url'='assets/mark.svg';

create or replace function public.viejo_validate_buffet_menu(p_items jsonb,p_status text,p_day text)
returns void language plpgsql set search_path='' as $$
declare it jsonb;names text[]='{}';ids text[]='{}';key text;
begin
 if p_day is null or p_day !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'invalid_menu_date';end if;
 if to_char(p_day::date,'YYYY-MM-DD')<>p_day then raise exception 'invalid_menu_date';end if;
 if p_status is null or p_status not in ('draft','published') or jsonb_typeof(p_items) is distinct from 'array' then raise exception 'invalid_menu';end if;
 if jsonb_array_length(p_items)>100 or (p_status='published' and jsonb_array_length(p_items)=0) then raise exception 'invalid_menu';end if;
 for it in select * from jsonb_array_elements(p_items) loop
  if jsonb_typeof(it) is distinct from 'object' or jsonb_typeof(it->'id') is distinct from 'string'
   or length(btrim(it->>'id')) not between 1 and 120 or jsonb_typeof(it->'name') is distinct from 'string'
   or length(btrim(it->>'name')) not between 1 and 120 or it->>'name' ~ '[<>[:cntrl:]]' then raise exception 'invalid_menu_item';end if;
  if it ? 'category' or jsonb_typeof(it->'category_id') is distinct from 'string'
   or it->>'category_id' not in ('guarniciones','carne','pollo_chancho','pending') then raise exception 'invalid_buffet_category';end if;
  if jsonb_typeof(it->'available') is distinct from 'boolean' then raise exception 'invalid_availability';end if;
  if p_status='published' and it->>'category_id'='pending' and (it->>'available')::boolean then raise exception 'pending_category_available';end if;
  key=lower(pg_catalog.normalize(btrim(it->>'name'),'NFC'));
  if (it->>'id')=any(ids) or key=any(names) then raise exception 'duplicate_item';end if;
  ids=array_append(ids,it->>'id');names=array_append(names,key);
 end loop;
end $$;
create or replace function public.viejo_quote(p_service text,p_items jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare it jsonb;v jsonb;result jsonb='[]';amount integer=0;qty integer; seen text[]='{}'; menu jsonb;
begin
 if p_service is null or p_service<>'buffet' or jsonb_typeof(p_items)<>'array' or coalesce(jsonb_array_length(p_items),0) not between 1 and 30 then raise exception 'invalid_items';end if;
 if p_service='buffet' then
  select items into menu from public.viejo_menus where day=(now() at time zone 'America/Asuncion')::date and status='published' for share;
  if menu is null then raise exception 'daily_menu_required';end if;
 end if;
 for it in select * from jsonb_array_elements(p_items) loop
  if coalesce(jsonb_typeof(it->'qty'),'')<>'number' or coalesce(it->>'qty','') !~ '^[0-9]+$' then raise exception 'invalid_quantity';end if;
  qty=(it->>'qty')::integer;
  if qty not between 1 and 30 or (it->>'variant_id')=any(seen) then raise exception 'invalid_quantity';end if;
  seen=array_append(seen,it->>'variant_id');v=null;
  if p_service='chiperia' then
   select to_jsonb(c) into v from public.guarni_catalog c where id=it->>'variant_id' and available and price>0 for share;
  else
   select x into v from jsonb_array_elements(menu) x where x->>'id'=it->>'variant_id' and x->'available'='true'::jsonb and x->>'category_id' in ('guarniciones','carne','pollo_chancho');
  end if;
  if v is null then raise exception 'price_or_availability_changed';end if;
  if p_service='chiperia' then amount=amount+(v->>'price')::integer*qty;end if;
  result=result||jsonb_build_array(jsonb_build_object('variant_id',v->>'id','name',v->>'name','variant',coalesce(v->>'variant','Base'),'qty',qty,'unit_price',case when p_service='chiperia' then (v->>'price')::integer else null end,'notes',left(coalesce(it->>'notes',''),300)));
 end loop;
 return jsonb_build_object('items',result,'subtotal',case when p_service='buffet' then null else amount end);
end $$;

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
  perform public.viejo_validate_buffet_menu(p_data->'items',p_data->>'status',p_data->>'day');
  if p_data->>'status'='published' and (p_data->>'reviewed')::boolean is not true then raise exception 'human_review_required';end if;
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


do $$ declare f record;begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('viejo_buffet_category_id','viejo_validate_buffet_menu','viejo_staff','viejo_quote') loop
 execute 'revoke all on function '||f.sig||' from public,anon,authenticated';
 execute 'grant execute on function '||f.sig||' to service_role';end loop;
end $$;
commit;
