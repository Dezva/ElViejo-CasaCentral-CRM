-- OPCIONAL: ejecutar SOLO en Supabase aislado autorizado, después de 009.
-- No se necesita para demo/PGlite ni crea URLs/políticas públicas.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('el-viejo-menu-private','el-viejo-menu-private',false,3145728,array['image/png','image/jpeg','image/webp'])
on conflict(id) do nothing;
do $$ begin
 if exists(select 1 from storage.buckets where id='el-viejo-menu-private' and public) then
  raise exception 'El bucket existente es público. Revisar infraestructura; no habilitar el flujo.';
 end if;
end $$;
-- Sin políticas anon/authenticated para este bucket: solo Functions con service_role.
-- Auditar políticas generales de storage.objects antes de activar.
commit;
