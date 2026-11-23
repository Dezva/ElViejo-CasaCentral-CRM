-- Casa Central V1.7: aplicar solo después de 014. No ejecuta limpiezas ni borrados al instalar.
begin;
create table if not exists public.viejo_message_tombstones(
 external_id text primary key check(length(external_id) between 1 and 200),created_at timestamptz not null default now()
);
alter table public.viejo_message_tombstones enable row level security;
revoke all on public.viejo_message_tombstones from public,anon,authenticated;
grant all on public.viejo_message_tombstones to service_role;
alter table public.guarni_audit add column if not exists metadata jsonb not null default '{}' check(jsonb_typeof(metadata)='object');
create or replace function public.guarni_ingest(p_external text,p_wa text,p_name text,p_body text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.guarni_conversations; client uuid; msg uuid;
begin
 if p_external is null or length(p_external)=0 or p_wa is null or p_body is null or p_wa !~ '^[0-9]{7,18}$' or length(p_external)>200 or length(p_body) not between 1 and 4096 then raise exception 'invalid_message'; end if;
 -- Un mismo webhook reintentado no incrementa no leídos ni crea otro trabajo.
 -- Barrera compartida: recepciones concurrentes normales; limpieza exclusiva solo durante su transacción.
 perform pg_advisory_xact_lock_shared(hashtextextended('viejo_history_gate',0));
 perform pg_advisory_xact_lock(hashtextextended(p_wa,0));
 if exists(select 1 from public.viejo_message_tombstones where external_id=p_external) then return jsonb_build_object('duplicate',true);end if;
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


-- Privadas a las RPC definer: nunca se exponen como rutas alternativas de borrado.
create or replace function public.viejo_protected_messages(p_chat uuid) returns table(id uuid)
language sql stable set search_path='' as $$
 select m.id from public.guarni_messages m where m.conversation_id=p_chat and (
  exists(select 1 from public.guarni_orders o where o.source_message_id=m.id)
  or exists(select 1 from public.guarni_locations l where l.message_id=m.id and (
   exists(select 1 from public.guarni_orders o where o.delivery_location_id=l.id)
   or exists(select 1 from public.guarni_order_locations ol where ol.location_id=l.id)))
 );
$$;
create or replace function public.viejo_history_snapshot(p_chat uuid) returns jsonb
language plpgsql set search_path='' as $$
declare c public.guarni_conversations;n integer;kept integer;orders_n integer;active_n integer;reason text;fingerprint text;
begin
 select * into c from public.guarni_conversations where id=p_chat;
 if c.id is null then raise exception 'not_found';end if;
 select count(*) into n from public.guarni_messages where conversation_id=p_chat;
 select count(*) into kept from public.viejo_protected_messages(p_chat);
 select count(*),count(*) filter(where status in ('draft','needs_info','pending','accepted','preparing','ready','out_for_delivery')) into orders_n,active_n from public.guarni_orders where conversation_id=p_chat or source_message_id in(select id from public.guarni_messages where conversation_id=p_chat);
 if active_n>0 then reason='active_orders';
 elsif c.processing_until>now() or exists(select 1 from public.guarni_jobs where conversation_id=p_chat and status in ('pending','processing')) then reason='processing_wait';
 elsif exists(select 1 from public.guarni_messages where conversation_id=p_chat and status in ('queued','sending','uncertain')) then reason='queue_pending';end if;
 select md5(c.revision::text||c.cart::text||c.mode||coalesce(c.owner_id::text,'')||coalesce(c.draft_location_id::text,'')||
 coalesce((select string_agg(id::text||status,',' order by id) from public.guarni_messages where conversation_id=p_chat),'')||
 coalesce((select string_agg(id::text||status,',' order by id) from public.guarni_orders where conversation_id=p_chat),'')||kept::text) into fingerprint;
 return jsonb_build_object('kind','conversation','id',p_chat,'messages',n,'messages_to_delete',n-kept,'messages_preserved',kept,'orders',orders_n,'orders_preserved',orders_n,'active_orders',active_n,'blocked',reason,'preview_token',fingerprint,'resets_drafts',true,'mode_preserved',c.mode);
end $$;
create or replace function public.viejo_clear_history(p_actor uuid,p_conversation uuid,p_confirm boolean default false,p_preview_token text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.guarni_conversations;s jsonb;deleted_n integer;
begin
 if not exists(select 1 from public.crm_members where user_id=p_actor and role='admin') then raise exception 'admin_required';end if;
 -- Cantidad constante de bloqueos aun con miles de mensajes; no hay un lock por external_id.
 if p_confirm is true then
  if not pg_try_advisory_xact_lock(hashtextextended('viejo_history_gate',0)) then raise exception 'processing_wait';end if;
 else perform pg_advisory_xact_lock_shared(hashtextextended('viejo_history_gate',0));end if;
 select * into c from public.guarni_conversations where id=p_conversation;
 if c.id is null then raise exception 'not_found';end if;
 if not pg_try_advisory_xact_lock(hashtextextended(c.wa_id,0)) then raise exception 'processing_wait';end if;
 select * into c from public.guarni_conversations where id=p_conversation for update nowait;
 if c.id is null then raise exception 'not_found';end if;
 s=public.viejo_history_snapshot(p_conversation);
 if p_confirm is not true then return s;end if;
 if s->>'blocked' is not null then raise exception '%',s->>'blocked';end if;
 if p_preview_token is null then raise exception 'preview_required';end if;
 if p_preview_token is distinct from s->>'preview_token' then raise exception 'preview_changed';end if;
 insert into public.viejo_message_tombstones(external_id) select m.external_id from public.guarni_messages m where m.conversation_id=p_conversation and m.external_id is not null and not exists(select 1 from public.viejo_protected_messages(p_conversation) k where k.id=m.id) on conflict do nothing;
 delete from public.guarni_jobs j where j.conversation_id=p_conversation and not exists(select 1 from public.viejo_protected_messages(p_conversation) k where k.id=j.message_id);
 -- Se conserva atención humana/propietario y la ventana de WhatsApp; se descartan todos los borradores/contextos.
 update public.guarni_conversations set cart=jsonb_build_object('items','[]'::jsonb,'service',c.cart->>'service','fulfillment','a_coordinar','quoted',false,'saved_carts','{}'::jsonb),draft_location_id=null,unread=0,revision=revision+1,processing_token=null,processing_until=null,updated_at=now() where id=p_conversation;
 delete from public.guarni_messages m where m.conversation_id=p_conversation and not exists(select 1 from public.viejo_protected_messages(p_conversation) k where k.id=m.id);
 get diagnostics deleted_n=row_count;
 insert into public.guarni_audit(actor_id,action,target_id,metadata) values(p_actor,'clear_history',p_conversation::text,jsonb_build_object('type','all_safe','messages_deleted',deleted_n,'messages_preserved',(s->>'messages_preserved')::integer,'orders_preserved',(s->>'orders')::integer));
 return s||jsonb_build_object('ok',true,'deleted',deleted_n);
exception when lock_not_available then raise exception 'processing_wait';
end $$;

create or replace function public.viejo_delete_client(p_actor uuid,p_id uuid,p_confirm boolean default false,p_delete_orders boolean default false,p_preview_token text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cl public.crm_clients;ch public.guarni_conversations;chats uuid[];s jsonb;reason text;active_n integer;orders_n integer;messages_n integer;locations_n integer;fingerprint text;
begin
 if not exists(select 1 from public.crm_members where user_id=p_actor and role='admin') then raise exception 'admin_required';end if;
 -- Cantidad constante de bloqueos aun con miles de mensajes; no hay un lock por external_id.
 if p_confirm is true then
  if not pg_try_advisory_xact_lock(hashtextextended('viejo_history_gate',0)) then raise exception 'processing_wait';end if;
 else perform pg_advisory_xact_lock_shared(hashtextextended('viejo_history_gate',0));end if;
 select * into cl from public.crm_clients where id=p_id;
 if cl.id is null then raise exception 'not_found';end if;
 if cl.whatsapp_id is not null and not pg_try_advisory_xact_lock(hashtextextended(cl.whatsapp_id,0)) then raise exception 'processing_wait';end if;
 select * into cl from public.crm_clients where id=p_id for update nowait;
 if cl.id is null then raise exception 'not_found';end if;
 -- Mismo orden de bloqueo que recepción/worker. Incluye fichas con más de una conversación.
 for ch in select * from public.guarni_conversations where client_id=p_id order by id loop
  if not pg_try_advisory_xact_lock(hashtextextended(ch.wa_id,0)) then raise exception 'processing_wait';end if;
 end loop;
 perform 1 from public.guarni_conversations where client_id=p_id order by id for update nowait;
 select coalesce(array_agg(id),'{}') into chats from public.guarni_conversations where client_id=p_id;
 select count(*),count(*) filter(where status in ('draft','needs_info','pending','accepted','preparing','ready','out_for_delivery')) into orders_n,active_n from public.guarni_orders where client_id=p_id or conversation_id=any(chats) or source_message_id in(select id from public.guarni_messages where conversation_id=any(chats));
 select count(*) into messages_n from public.guarni_messages where conversation_id=any(chats);
 select count(*) into locations_n from public.guarni_locations where conversation_id=any(chats);
 if exists(select 1 from public.guarni_orders o where o.client_id<>p_id and (o.conversation_id=any(chats) or o.source_message_id in(select id from public.guarni_messages where conversation_id=any(chats)) or o.delivery_location_id in(select id from public.guarni_locations where conversation_id=any(chats)) or o.id in(select ol.order_id from public.guarni_order_locations ol join public.guarni_locations l on l.id=ol.location_id where l.conversation_id=any(chats)))) then reason='linked_records';
 elsif active_n>0 then reason='active_orders';
 elsif exists(select 1 from public.guarni_conversations where id=any(chats) and processing_until>now()) or exists(select 1 from public.guarni_jobs where conversation_id=any(chats) and status in ('pending','processing')) then reason='processing_wait';
 elsif exists(select 1 from public.guarni_messages where conversation_id=any(chats) and status in ('queued','sending','uncertain')) then reason='queue_pending';end if;
 select md5(cl.id::text||cl.updated_at::text||coalesce((select string_agg(id::text||revision::text||cart::text,',' order by id) from public.guarni_conversations where id=any(chats)),'')||
 coalesce((select string_agg(id::text||status,',' order by id) from public.guarni_messages where conversation_id=any(chats)),'')||
 coalesce((select string_agg(id::text||status,',' order by id) from public.guarni_orders where client_id=p_id or conversation_id=any(chats)),'')||locations_n::text) into fingerprint;
 s=jsonb_build_object('kind','client','id',p_id,'label',cl.name,'conversations',cardinality(chats),'messages',messages_n,'orders',orders_n,'locations',locations_n,'active_orders',active_n,'blocked',reason,'preview_token',fingerprint,'requires_order_ack',orders_n>0);
 if p_confirm is not true then return s;end if;
 if reason is not null then raise exception '%',reason;end if;
 if p_preview_token is null then raise exception 'preview_required';end if;
 if p_preview_token is distinct from fingerprint then raise exception 'preview_changed';end if;
 if orders_n>0 and p_delete_orders is not true then raise exception 'history_ack_required';end if;
 insert into public.viejo_message_tombstones(external_id) select external_id from public.guarni_messages where conversation_id=any(chats) and external_id is not null on conflict do nothing;
 -- Los FKs de ubicaciones/viejo_history se resuelven en el mismo commit; ninguna cascada alcanza a otros clientes.
 delete from public.guarni_orders where client_id=p_id or conversation_id=any(chats) or source_message_id in(select id from public.guarni_messages where conversation_id=any(chats));
 delete from public.guarni_jobs where conversation_id=any(chats) or message_id in(select id from public.guarni_messages where conversation_id=any(chats));
 delete from public.guarni_messages where conversation_id=any(chats);
 delete from public.guarni_conversations where id=any(chats);
 delete from public.crm_clients where id=p_id;
 insert into public.guarni_audit(actor_id,action,target_id,metadata) values(p_actor,'delete_client',p_id::text,jsonb_build_object('type','full_explicit','messages_deleted',messages_n,'orders_deleted',orders_n,'conversations_deleted',cardinality(chats),'locations_deleted',locations_n));
 return s||jsonb_build_object('ok',true);
exception when lock_not_available then raise exception 'processing_wait';
end $$;

-- Se cierra también la vía antigua: nunca evita la vista previa ni el consentimiento de pedidos.
create or replace function public.guarni_delete(p_actor uuid,p_kind text,p_id uuid,p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.guarni_orders;
begin
 if not exists(select 1 from public.crm_members where user_id=p_actor and role='admin') then raise exception 'admin_required';end if;
 if p_kind='client' then return public.viejo_delete_client(p_actor,p_id,p_confirm,false,null);end if;
 if p_kind is distinct from 'order' or p_id is null then raise exception 'invalid_target';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('viejo_history_gate',0));
 select * into o from public.guarni_orders where id=p_id for update;
 if o.id is null then raise exception 'not_found';end if;
 if o.status in ('draft','needs_info','pending','accepted','preparing','ready','out_for_delivery') then raise exception 'active_orders';end if;
 if p_confirm then raise exception 'preview_required';end if;
 return jsonb_build_object('ok',p_confirm,'kind','order','id',p_id,'label','Pedido #'||o.number,'orders',1,'conversations',0,'messages',0);
end $$;
revoke all on function public.viejo_protected_messages(uuid),public.viejo_history_snapshot(uuid) from public,anon,authenticated,service_role;
revoke all on function public.guarni_ingest(text,text,text,text),public.guarni_delete(uuid,text,uuid,boolean),public.viejo_clear_history(uuid,uuid,boolean,text),public.viejo_delete_client(uuid,uuid,boolean,boolean,text) from public,anon,authenticated;
grant execute on function public.guarni_ingest(text,text,text,text),public.guarni_delete(uuid,text,uuid,boolean),public.viejo_clear_history(uuid,uuid,boolean,text),public.viejo_delete_client(uuid,uuid,boolean,boolean,text) to service_role;
commit;
