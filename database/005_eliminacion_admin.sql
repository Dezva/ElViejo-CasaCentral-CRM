-- Ejecutar UNA VEZ en Supabase > SQL Editor para habilitar la eliminación desde el CRM.
-- No elimina registros al instalarla. Solo los administradores podrán confirmar eliminaciones.
begin;

create index if not exists guarni_conversations_client on public.guarni_conversations(client_id);
create index if not exists guarni_jobs_conversation on public.guarni_jobs(conversation_id);
create index if not exists guarni_orders_client on public.guarni_orders(client_id);
create index if not exists guarni_orders_conversation on public.guarni_orders(conversation_id);

create or replace function public.guarni_delete(p_actor uuid,p_kind text,p_id uuid,p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name text; cl public.crm_clients; o public.guarni_orders;
 chat_ids uuid[]; order_count integer; message_count integer; result jsonb;
begin
 select role into role_name from public.crm_members where user_id=p_actor;
 if role_name is null then raise exception 'not_member'; end if;
 if role_name<>'admin' then raise exception 'admin_required'; end if;
 if p_kind is null or p_kind not in ('client','order') or p_id is null then raise exception 'invalid_target'; end if;

 if p_kind='order' then
  if p_confirm is true then
   select * into o from public.guarni_orders where id=p_id for update;
  else
   select * into o from public.guarni_orders where id=p_id;
  end if;
  if o.id is null then
   if p_confirm is true then return jsonb_build_object('ok',true,'already_deleted',true); end if;
   raise exception 'not_found';
  end if;
  result=jsonb_build_object('kind','order','id',p_id,'label','Pedido #'||o.number,'orders',1,'conversations',0,'messages',0);
  if p_confirm is not true then return result; end if;
  -- Conservar mensajes y trabajos mantiene la deduplicación de los webhooks ya recibidos.
  delete from public.guarni_orders where id=p_id;
 else
  select * into cl from public.crm_clients where id=p_id;
  if cl.id is null then
   if p_confirm is true then return jsonb_build_object('ok',true,'already_deleted',true); end if;
   raise exception 'not_found';
  end if;
  if p_confirm is true then
   -- Mismo bloqueo que guarni_ingest: un mensaje nuevo se registra antes o después del borrado.
   if cl.whatsapp_id is not null then perform pg_advisory_xact_lock(hashtextextended(cl.whatsapp_id,0)); end if;
   select * into cl from public.crm_clients where id=p_id for update;
   if cl.id is null then return jsonb_build_object('ok',true,'already_deleted',true); end if;
   perform 1 from public.guarni_conversations where client_id=p_id order by id for update nowait;
   if exists(select 1 from public.guarni_conversations where client_id=p_id and processing_until>now()) then
    raise exception 'processing_wait';
   end if;
  end if;
  select coalesce(array_agg(id),'{}'::uuid[]) into chat_ids from public.guarni_conversations where client_id=p_id;
  select count(*) into order_count from public.guarni_orders
   where client_id=p_id or conversation_id=any(chat_ids)
   or source_message_id in (select id from public.guarni_messages where conversation_id=any(chat_ids));
  select count(*) into message_count from public.guarni_messages where conversation_id=any(chat_ids);
  result=jsonb_build_object('kind','client','id',p_id,'label',cl.name,'orders',order_count,'conversations',cardinality(chat_ids),'messages',message_count);
  if p_confirm is not true then return result; end if;
  -- Borrado físico y transaccional: respetar el orden de las claves foráneas.
  delete from public.guarni_orders where client_id=p_id or conversation_id=any(chat_ids)
   or source_message_id in (select id from public.guarni_messages where conversation_id=any(chat_ids));
  delete from public.guarni_jobs where conversation_id=any(chat_ids)
   or message_id in (select id from public.guarni_messages where conversation_id=any(chat_ids));
  delete from public.guarni_messages where conversation_id=any(chat_ids);
  delete from public.guarni_conversations where id=any(chat_ids);
  delete from public.crm_clients where id=p_id;
 end if;
 -- Auditoría mínima sin nombres, teléfonos ni contenido de mensajes.
 insert into public.guarni_audit(actor_id,action,target_id) values(p_actor,'delete_'||p_kind,p_id::text);
 return result||jsonb_build_object('ok',true);
exception when lock_not_available then
 raise exception 'processing_wait';
end $$;

revoke all on function public.guarni_delete(uuid,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.guarni_delete(uuid,text,uuid,boolean) to service_role;
-- Canal único para borrar clientes: autorización, bloqueo y auditoría del procedimiento anterior.
revoke delete on public.crm_clients from authenticated;

commit;
