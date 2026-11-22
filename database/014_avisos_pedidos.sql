-- V1.4: lectura mínima de TODOS los pendientes, sin el límite del listado reciente.
begin;
create or replace function public.viejo_pending_orders() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'number',number,'service',service,'status',status,'created_at',created_at) order by created_at desc,id),'[]'::jsonb)
 from public.guarni_orders where status='pending';
$$;
revoke all on function public.viejo_pending_orders() from public,anon,authenticated;
grant execute on function public.viejo_pending_orders() to service_role;
commit;
