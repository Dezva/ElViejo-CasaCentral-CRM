-- Casa Central: ubicación opcional en texto, pedidos y conciliación. Aplicar después de 015.
begin;
create or replace function public.guarni_process_location(p_token uuid,p_job uuid,p_reply_enabled boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.guarni_jobs; c public.guarni_conversations; m public.guarni_messages;
 point public.guarni_locations; candidate public.guarni_orders; candidates integer; reply text; association text;reference text;reference_point text;
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
   and (status='pending' or (status in ('accepted','preparing','ready','out_for_delivery') and fulfillment='delivery'));
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
   reference=btrim(coalesce(c.cart->>'address',''));
   reference_point=c.cart->>'address_location_id';
   if reference_point is not null and reference_point<>point.id::text then reference='';reference_point=null;end if;
   if length(reference)<3 and length(btrim(point.address))>=3 then reference=btrim(point.address);reference_point=point.id::text;end if;
   update public.guarni_conversations set draft_location_id=point.id,
    cart=jsonb_set(jsonb_set(jsonb_set(c.cart,'{address}',to_jsonb(reference)),'{address_location_id}',coalesce(to_jsonb(reference_point),'null'::jsonb)),'{delivery_location_id}',to_jsonb(point.id)) where id=c.id;
   association='draft';
   reply='¡Listo, recibí tu ubicación! 📍';
   if jsonb_array_length(coalesce(c.cart->'items','[]'::jsonb))>0 then
    reply=reply||' Si está todo correcto, escribí CONFIRMAR PEDIDO para enviar tu solicitud al local.';
   end if;
  elsif candidates=1 then
   select * into candidate from public.guarni_orders where conversation_id=c.id
    and (status='pending' or (status in ('accepted','preparing','ready','out_for_delivery') and fulfillment='delivery')) for update;
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
   select 1 from public.guarni_locations where id=c.draft_location_id and conversation_id=c.id and review_reason is distinct from 'stale_location'
  ) then raise exception 'delivery_location_required'; end if;
  if coalesce((c.cart->>'quoted')::boolean,false) is not true or jsonb_array_length(p_cart->'items') not between 1 and 30 then raise exception 'not_quoted'; end if;
  if c.cart->'items' is distinct from p_cart->'items' then raise exception 'cart_changed'; end if;
  q=public.viejo_quote(p_cart->>'service',p_cart->'items');
  if q->'items' is distinct from p_cart->'items' then raise exception 'price_or_availability_changed';end if;
  itemlist=q->'items'; amount=(q->>'subtotal')::integer;
  if p_cart->>'fulfillment' not in ('retiro','delivery') then raise exception 'fulfillment_required';end if;
  select coalesce(group_id,gen_random_uuid()) into related from public.guarni_orders where conversation_id=c.id and service<>p_cart->>'service' and status in ('pending','accepted','preparing','ready') order by created_at desc limit 1;
  if related is not null then update public.guarni_orders set group_id=related where conversation_id=c.id and status in ('pending','accepted','preparing','ready');end if;
  insert into public.guarni_orders(client_id,conversation_id,source_message_id,service,group_id,items,subtotal,customer_name,fulfillment,address,payment)
  values(c.client_id,c.id,j.message_id,p_cart->>'service',related,itemlist,amount,coalesce(nullif(p_cart->>'customer_name',''),'Cliente WhatsApp'),coalesce(p_cart->>'fulfillment','a_coordinar'),case when p_cart->>'fulfillment'='delivery' then left(btrim(coalesce(p_cart->>'address','')),500) else '' end,coalesce(p_cart->>'payment','a_coordinar'))
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
create or replace function public.viejo_staff_v12_base(p_actor uuid,p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name text;o public.guarni_orders;c public.guarni_conversations;q jsonb;next_status text;fee integer;amount integer;result jsonb;target uuid; schedule jsonb; clock text; dow integer;warning boolean;
begin
 select role into role_name from public.crm_members where user_id=p_actor;
 if role_name is null then raise exception 'not_member';end if;
 if p_action in ('settings','member') and role_name<>'admin' then raise exception 'admin_required';end if;
 if p_action='menu' and role_name<>'admin' and not exists(select 1 from public.crm_members where user_id=p_actor and menu_editor) then raise exception 'menu_permission_required';end if;
 if p_action in ('create_order','order_details') then
  if coalesce(p_data->>'fulfillment','a_coordinar') not in ('retiro','delivery','a_coordinar') then raise exception 'invalid_fulfillment';end if;
  if coalesce(p_data->>'payment','a_coordinar')<>'a_coordinar' and not exists(select 1 from public.guarni_settings where payment_methods @> to_jsonb(p_data->>'payment')) then raise exception 'invalid_payment';end if;
 end if;
 if p_action='menu' then
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
  insert into public.crm_members(user_id,display_name,role,catalog_editor,menu_editor) values(target,left(p_data->>'display_name',120),p_data->>'role',false,coalesce((p_data->>'menu_editor')::boolean,false)) on conflict(user_id) do update set display_name=excluded.display_name,role=excluded.role,catalog_editor=excluded.catalog_editor,menu_editor=excluded.menu_editor;
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
    if o.fulfillment='delivery' and (o.delivery_location_id is null) then raise exception 'delivery_location_required';end if;
    if o.fulfillment='delivery' and not exists(select 1 from public.guarni_locations where id=o.delivery_location_id and conversation_id=o.conversation_id and review_reason is distinct from 'stale_location') then raise exception 'invalid_location';end if;
    if o.fulfillment='delivery' and ((p_data->>'shipping_fee') is null or (p_data->>'shipping_fee') !~ '^[0-9]+$') then raise exception 'explicit_delivery_fee_required';end if;
    fee=case when o.fulfillment='delivery' then (p_data->>'shipping_fee')::integer else 0 end;
    if o.group_id is not null and coalesce((p_data->>'group_reviewed')::boolean,false) is not true then raise exception 'group_review_required';end if;
    select s.config->'schedules'->o.service into schedule from public.guarni_settings s where id=true;
    clock=to_char(now() at time zone 'America/Asuncion','HH24:MI');dow=extract(dow from now() at time zone 'America/Asuncion');
    warning=not (coalesce(schedule->'days','[]') @> to_jsonb(dow)) or clock<schedule->>'open' or clock>=schedule->>'close' or (o.fulfillment='delivery' and (schedule->>'delivery_open' is null or clock<schedule->>'delivery_open' or clock>=schedule->>'delivery_close'));
    if coalesce(warning,true) and coalesce((p_data->>'schedule_reviewed')::boolean,false) is not true then raise exception 'schedule_review_required';end if;
    q=public.viejo_quote(o.service,o.items);
    if c.mode<>'human' or c.owner_id is distinct from p_actor then raise exception 'take_conversation_first';end if;
    if coalesce((p_data->>'price_agreed')::boolean,false) is not true or (p_data->>'buffet_amount') is null or (p_data->>'buffet_amount') !~ '^[0-9]+$' or (p_data->>'buffet_amount')::integer<=0 then raise exception 'agreed_buffet_amount_required';end if;
    amount=(p_data->>'buffet_amount')::integer;
    update public.guarni_orders set items=q->'items',subtotal=amount,shipping_fee=fee,total=amount+fee,address=left(coalesce(p_data->>'address',address),500) where id=o.id;
   end if;
   update public.guarni_orders set status=next_status,decided_by=p_actor,decided_at=now(),updated_at=now(),note=left(coalesce(p_data->>'note',note),500) where id=o.id;
   -- Buffet: el importe se comunica personalmente; no lo anuncia el chatbot.
   if next_status in ('accepted','preparing','ready','out_for_delivery','delivered','cancelled','rejected') then
    insert into public.guarni_messages(conversation_id,direction,actor,actor_id,body,status)
    values(c.id,'outbound','system',p_actor,left(
      case next_status
      when 'accepted' then '*🍽️ BUFFET EL VIEJO — CASA CENTRAL*'||E'\n\n*Pedido #'||o.number||E' confirmado*\n\n*Productos solicitados:*\n'||
       (select case when length(lines)>3200 then left(lines,3190)||E'\n…' else lines end from (select string_agg('- '||(x->>'qty')||' × '||(x->>'name'),E'\n') lines from jsonb_array_elements(q->'items') x) products)||
       E'\n\n*Importe acordado:* Gs. '||replace(to_char(amount,'FM999,999,999,990'),',','.')||
       case when o.fulfillment='delivery' then E'\n*Delivery:* Gs. '||replace(to_char(fee,'FM999,999,999,990'),',','.') else E'\nRetiro en el local' end||
       E'\n\n*Total confirmado: Gs. '||replace(to_char(amount::bigint+fee,'FM999,999,999,990'),',','.')||E'*\n\n*Pago:* '||
       case when o.payment='a_coordinar' then 'Pendiente de coordinar' else o.payment end
      when 'preparing' then 'Tu pedido está en preparación.'
      when 'ready' then case when o.fulfillment='retiro' then 'Tu pedido está listo para retirar.' else 'Tu pedido está listo para el envío.' end
      when 'out_for_delivery' then 'Tu pedido salió para entrega.'
      when 'delivered' then case when o.fulfillment='retiro' then 'Tu pedido fue retirado.' else 'Tu pedido fue entregado.' end
      when 'cancelled' then 'Tu pedido fue cancelado.'
      when 'rejected' then 'El local no pudo aceptar tu pedido.'
      end,4096),'queued');
   end if;
  end if;
  insert into public.viejo_history(order_id,actor_id,action,before_data,after_data) select o.id,p_actor,p_action,to_jsonb(o),to_jsonb(n) from public.guarni_orders n where id=o.id;
 else
  return public.guarni_staff(p_actor,p_action,p_data);
 end if;
 insert into public.guarni_audit(actor_id,action,target_id) values(p_actor,p_action,p_data->>'id');
 return jsonb_build_object('ok',true);
end $$;
alter table public.guarni_orders add column if not exists accepted_at timestamptz;
alter table public.guarni_orders add column if not exists completed_at timestamptz;
alter table public.guarni_orders add column if not exists cancelled_at timestamptz;
alter table public.guarni_orders add column if not exists rejected_at timestamptz;
alter table public.guarni_orders add column if not exists version bigint not null default 0;
create table if not exists public.viejo_payment_movements(
 id uuid primary key default gen_random_uuid(),
 order_id uuid references public.guarni_orders(id) on delete set null,
 original_order_id uuid not null,order_number bigint not null,
 service text not null check(service='buffet'),
 kind text not null check(kind in ('receipt','refund')),
 amount bigint not null check(amount>0),method text not null,
 occurred_at timestamptz not null,actor_id uuid,source_history_id bigint,
 unique(original_order_id,kind)
);
create index if not exists viejo_movements_period on public.viejo_payment_movements(occurred_at,service);
create index if not exists viejo_orders_completed on public.guarni_orders(completed_at,service) where status='delivered';
alter table public.viejo_payment_movements enable row level security;
revoke all on public.viejo_payment_movements from public,anon,authenticated;
grant select,insert,update,delete on public.viejo_payment_movements to service_role;

-- Solo fechas respaldadas por transiciones registradas. Nunca created_at/updated_at como sustituto.
update public.guarni_orders o set
 accepted_at=coalesce(o.accepted_at,(select min(h.created_at) from public.viejo_history h where h.order_id=o.id and h.after_data->>'status'='accepted' and h.before_data->>'status' is distinct from 'accepted')),
 completed_at=coalesce(o.completed_at,(select min(h.created_at) from public.viejo_history h where h.order_id=o.id and h.after_data->>'status'='delivered' and h.before_data->>'status' is distinct from 'delivered')),
 cancelled_at=coalesce(o.cancelled_at,(select min(h.created_at) from public.viejo_history h where h.order_id=o.id and h.after_data->>'status'='cancelled' and h.before_data->>'status' is distinct from 'cancelled')),
 rejected_at=coalesce(o.rejected_at,(select min(h.created_at) from public.viejo_history h where h.order_id=o.id and h.after_data->>'status'='rejected' and h.before_data->>'status' is distinct from 'rejected'))
 where (o.accepted_at is null and exists(select 1 from public.viejo_history h where h.order_id=o.id and h.after_data->>'status'='accepted' and h.before_data->>'status' is distinct from 'accepted'))
 or (o.completed_at is null and exists(select 1 from public.viejo_history h where h.order_id=o.id and h.after_data->>'status'='delivered' and h.before_data->>'status' is distinct from 'delivered'))
 or (o.cancelled_at is null and exists(select 1 from public.viejo_history h where h.order_id=o.id and h.after_data->>'status'='cancelled' and h.before_data->>'status' is distinct from 'cancelled'))
 or (o.rejected_at is null and exists(select 1 from public.viejo_history h where h.order_id=o.id and h.after_data->>'status'='rejected' and h.before_data->>'status' is distinct from 'rejected'));
insert into public.viejo_payment_movements(order_id,original_order_id,order_number,service,kind,amount,method,occurred_at,actor_id,source_history_id)
 select distinct on(h.order_id,h.after_data->>'payment_status') o.id,o.id,o.number,o.service,
 case h.after_data->>'payment_status' when 'paid' then 'receipt' else 'refund' end,
 (h.after_data->>'total')::bigint,coalesce(h.after_data->>'payment','a_coordinar'),h.created_at,h.actor_id,h.id
 from public.viejo_history h join public.guarni_orders o on o.id=h.order_id
 where h.action='payment_status' and h.after_data->>'payment_status' in ('paid','refunded')
 and h.before_data->>'payment_status' is distinct from h.after_data->>'payment_status'
 and coalesce(h.after_data->>'total','') ~ '^[0-9]{1,10}$' and (h.after_data->>'total')::bigint>0
 order by h.order_id,h.after_data->>'payment_status',h.created_at,h.id on conflict(original_order_id,kind) do nothing;

create or replace function public.viejo_order_stamps() returns trigger language plpgsql set search_path='' as $$
begin
 new.version=old.version+1;new.updated_at=now();
 if new.status is distinct from old.status then
  if new.status='accepted' then new.accepted_at=now();end if;
  if new.status='delivered' then new.completed_at=now();end if;
  if new.status='cancelled' then new.cancelled_at=now();end if;
  if new.status='rejected' then new.rejected_at=now();end if;
 end if;
 return new;
end $$;
drop trigger if exists viejo_order_stamps on public.guarni_orders;
create trigger viejo_order_stamps before update on public.guarni_orders for each row execute function public.viejo_order_stamps();

-- Conserva la cadena de permisos y configuración de Casa Central. Reejecutable, sin renombrar de nuevo.
do $$begin
 if to_regprocedure('public.viejo_staff_casa_base(uuid,text,jsonb)') is null then
  alter function public.viejo_staff(uuid,text,jsonb) rename to viejo_staff_casa_base;
 end if;
end $$;
create or replace function public.viejo_staff(p_actor uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.guarni_orders;c public.guarni_conversations;result jsonb;method text;target text;point uuid;stamp timestamptz;amount bigint;
begin
 if not exists(select 1 from public.crm_members where user_id=p_actor) then raise exception 'not_member';end if;
 if p_action in ('order_status','order_details','payment_status') then
  select * into o from public.guarni_orders where id=(p_data->>'id')::uuid;
  if o.id is null then raise exception 'not_found';end if;
  if p_action='order_status' and p_data->>'status'='accepted' and o.group_id is not null then perform pg_advisory_xact_lock(hashtextextended(o.group_id::text,17));end if;
  select * into c from public.guarni_conversations where id=o.conversation_id for update;
  select * into o from public.guarni_orders where id=o.id for update;
  if o.id is null then raise exception 'not_found';end if;
  if p_data ? 'expected_version' and p_data->>'expected_version' is distinct from o.version::text then raise exception 'order_changed';end if;
  if p_action='order_status' and p_data->>'status'='accepted' and o.fulfillment='delivery' then
   if coalesce((p_data->>'location_reviewed')::boolean,false) is not true then raise exception 'location_review_required';end if;
   if coalesce((p_data->>'shipping_fee')::numeric,0)>0 and exists(
    select 1 from public.guarni_orders other join public.guarni_locations a on a.id=o.delivery_location_id join public.guarni_locations b on b.id=other.delivery_location_id
    where other.id<>o.id and other.group_id=o.group_id and other.fulfillment='delivery' and other.status in ('accepted','preparing','ready','out_for_delivery','delivered') and other.shipping_fee>0 and a.latitude=b.latitude and a.longitude=b.longitude
   ) then raise exception 'duplicate_delivery_fee';end if;
  end if;
  if p_action='payment_status' then
   target=p_data->>'payment_status';method=coalesce(p_data->>'payment',o.payment);
   if target is null or target not in ('pending','paid','refunded') then raise exception 'invalid_payment_transition';end if;
   if target<>o.payment_status and not ((o.payment_status='pending' and target='paid') or (o.payment_status='paid' and target='refunded')) then raise exception 'invalid_payment_transition';end if;
   if method is distinct from o.payment or target='paid' and o.payment_status<>'paid' then
    if method='a_coordinar' or not exists(select 1 from public.guarni_settings where payment_methods @> to_jsonb(method)) then raise exception 'payment_method_required';end if;
   end if;
   if target=o.payment_status and method=o.payment then return jsonb_build_object('ok',true,'unchanged',true);end if;
   if target<>o.payment_status then
    amount=o.total;
    if amount is null or amount<=0 then raise exception 'confirmed_amount_required';end if;
    if target='refunded' then select m.amount into amount from public.viejo_payment_movements m where m.original_order_id=o.id and m.kind='receipt';amount=coalesce(amount,o.total);end if;
    stamp=clock_timestamp();
    insert into public.viejo_payment_movements(order_id,original_order_id,order_number,service,kind,amount,method,occurred_at,actor_id)
     values(o.id,o.id,o.number,o.service,case target when 'paid' then 'receipt' else 'refund' end,amount,method,stamp,p_actor);
   end if;
   update public.guarni_orders set payment_status=target,payment=method where id=o.id;
   insert into public.viejo_history(order_id,actor_id,action,before_data,after_data) select o.id,p_actor,'payment_status',to_jsonb(o),to_jsonb(n) from public.guarni_orders n where id=o.id;
   insert into public.guarni_audit(actor_id,action,target_id,metadata) values(p_actor,'payment_status',o.id::text,jsonb_build_object('from',o.payment_status,'to',target));
   return jsonb_build_object('ok',true);
  end if;
 end if;
 if p_action='create_order' and p_data->>'fulfillment'='delivery' then
  select * into c from public.guarni_conversations where client_id=(p_data->>'client_id')::uuid for update;
  if exists(select 1 from public.guarni_orders where id=(p_data->>'request_id')::uuid) then
   if not exists(select 1 from public.guarni_orders where id=(p_data->>'request_id')::uuid and conversation_id=c.id) then raise exception 'invalid_target';end if;
   return jsonb_build_object('ok',true,'duplicate',true);
  end if;
  point=coalesce((p_data->>'delivery_location_id')::uuid,c.draft_location_id);
  if not exists(select 1 from public.guarni_locations where id=point and conversation_id=c.id and review_reason is distinct from 'stale_location') then raise exception 'delivery_location_required';end if;
 end if;
 result=public.viejo_staff_casa_base(p_actor,p_action,p_data);
 if p_action='create_order' and p_data->>'fulfillment'='delivery' then
  update public.guarni_orders set delivery_location_id=point where id=(p_data->>'request_id')::uuid;
  insert into public.guarni_order_locations(order_id,location_id,actor_id) values((p_data->>'request_id')::uuid,point,p_actor) on conflict do nothing;
 end if;
 return result;
end $$;

create or replace function public.viejo_financial_summary(p_actor uuid,p_period text default 'month',p_from date default null,p_to date default null,p_service text default 'all') returns jsonb
language plpgsql security definer set search_path='' as $$
declare today date=(now() at time zone 'America/Asuncion')::date;start_date date;end_date date;start_at timestamptz;end_at timestamptz;orders jsonb;payments jsonb;
begin
 if not exists(select 1 from public.crm_members where user_id=p_actor) then raise exception 'not_member';end if;
 if p_service is null or p_service not in ('all','buffet') then raise exception 'invalid_period';end if;
 case p_period
 when 'today' then start_date=today;end_date=today+1;
 when 'week' then start_date=date_trunc('week',today)::date;end_date=start_date+7;
 when 'month' then start_date=date_trunc('month',today)::date;end_date=(start_date+interval '1 month')::date;
 when 'previous_month' then end_date=date_trunc('month',today)::date;start_date=(end_date-interval '1 month')::date;
 when 'custom' then
  if p_from is null or p_to is null or p_from>p_to then raise exception 'invalid_period';end if;
  start_date=p_from;end_date=p_to+1;
 when 'all' then null;
 else raise exception 'invalid_period';end case;
 start_at=start_date::timestamp at time zone 'America/Asuncion';end_at=end_date::timestamp at time zone 'America/Asuncion';
 select jsonb_build_object(
  'pending',count(*) filter(where status='pending'),
  'active',count(*) filter(where status in ('accepted','preparing','ready','out_for_delivery')),
  'completed',count(*) filter(where status='delivered' and (p_period='all' or completed_at>=start_at and completed_at<end_at)),
  'completed_amount',coalesce(sum(total::bigint) filter(where status='delivered' and (p_period='all' or completed_at>=start_at and completed_at<end_at)),0),
  'undated_completed',count(*) filter(where status='delivered' and completed_at is null),
  'unknown_completed_amount',count(*) filter(where status='delivered' and total is null),
  'unknown_payments',count(*) filter(where payment_status in ('paid','refunded') and not exists(select 1 from public.viejo_payment_movements m where m.original_order_id=o.id and m.kind='receipt'))
 ) into orders from public.guarni_orders o where p_service='all' or service=p_service;
 select jsonb_build_object(
  'receipts',coalesce(sum(amount) filter(where kind='receipt'),0),
  'refunds',coalesce(sum(amount) filter(where kind='refund'),0),
  'net',coalesce(sum(case kind when 'receipt' then amount else -amount end),0),
  'retained_movements',count(*) filter(where order_id is null)
 ) into payments from public.viejo_payment_movements where (p_service='all' or service=p_service) and (p_period='all' or occurred_at>=start_at and occurred_at<end_at);
 return orders||payments||jsonb_build_object('period',p_period,'from',start_date,'to',end_date-1,'service',p_service,'timezone','America/Asuncion');
end $$;

create or replace function public.viejo_delete_order(p_actor uuid,p_id uuid,p_confirm boolean default false,p_confirmation text default null,p_preview_token text default null,p_payment_ack boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.guarni_orders;c public.guarni_conversations;s jsonb;reason text;fingerprint text;paid boolean;movement_count integer;
begin
 if not exists(select 1 from public.crm_members where user_id=p_actor and role='admin') then raise exception 'admin_required';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('viejo_history_gate',0));
 select * into o from public.guarni_orders where id=p_id;
 if o.id is null then raise exception 'not_found';end if;
 select * into c from public.guarni_conversations where id=o.conversation_id for update nowait;
 select * into o from public.guarni_orders where id=p_id for update nowait;
 if o.id is null then raise exception 'not_found';end if;
 select count(*) into movement_count from public.viejo_payment_movements where original_order_id=o.id;
 paid=o.payment_status in ('paid','refunded') or movement_count>0;
 if o.status not in ('delivered','rejected','cancelled') then reason='active_orders';
 elsif c.processing_until>now() or exists(select 1 from public.guarni_jobs where conversation_id=c.id and status in ('pending','processing')) then reason='processing_wait';
 elsif exists(select 1 from public.guarni_messages where conversation_id=c.id and status in ('queued','sending','uncertain')) then reason='queue_pending';end if;
 fingerprint=md5(to_jsonb(o)::text||movement_count::text);
 s=jsonb_build_object('kind','order','id',o.id,'number',o.number,'label','Pedido #'||o.number,'client',(select name from public.crm_clients where id=o.client_id),'service',o.service,'created_at',o.created_at,'status',o.status,'total',o.total,'payment_status',o.payment_status,'blocked',reason,'requires_payment_ack',paid,'movements_preserved',movement_count,'preview_token',fingerprint);
 if p_confirm is not true then return s;end if;
 if reason is not null then raise exception '%',reason;end if;
 if p_confirmation is distinct from 'ELIMINAR' then raise exception 'confirmation_required';end if;
 if p_preview_token is null then raise exception 'preview_required';end if;
 if p_preview_token<>fingerprint then raise exception 'preview_changed';end if;
 if paid and p_payment_ack is not true then raise exception 'payment_ack_required';end if;
 -- Se conserva evidencia de conciliación incluso en pedidos históricos sin fecha fiable de cobro.
 insert into public.guarni_audit(actor_id,action,target_id,metadata) values(p_actor,'delete_order',o.id::text,jsonb_build_object('result','deleted','number',o.number,'service',o.service,'previous_status',o.status,'total',o.total,'payment_status',o.payment_status,'payment_ack',p_payment_ack,'movements_preserved',movement_count));
 delete from public.guarni_orders where id=o.id;
 -- No se borran mensajes/ubicaciones de origen, ni se generan trabajos de envío.
 return s||jsonb_build_object('ok',true);
exception when lock_not_available then raise exception 'processing_wait';
end $$;
create or replace function public.guarni_delete(p_actor uuid,p_kind text,p_id uuid,p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_kind='client' then return public.viejo_delete_client(p_actor,p_id,p_confirm,false,null);end if;
 if p_kind='order' then return public.viejo_delete_order(p_actor,p_id,p_confirm);end if;
 raise exception 'invalid_target';
end $$;

do $$declare f record;begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('guarni_process_location','guarni_finish','guarni_delete','viejo_staff','viejo_financial_summary','viejo_delete_order','viejo_order_stamps','viejo_staff_v12_base','viejo_staff_casa_base') loop
  execute 'revoke all on function '||f.sig||' from public,anon,authenticated,service_role';
  if f.sig::text not like '%viejo_staff_v12_base%' and f.sig::text not like '%viejo_staff_casa_base%' and f.sig::text not like '%viejo_order_stamps%' then execute 'grant execute on function '||f.sig||' to service_role';end if;
 end loop;
end $$;
commit;
