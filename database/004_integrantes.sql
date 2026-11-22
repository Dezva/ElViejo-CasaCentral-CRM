-- Crear/invitar primero al usuario en Supabase > Authentication > Users.
-- Reemplazar estos datos. No usar usuarios ni proyecto de Velturio.
insert into public.crm_members(user_id,display_name,role)
select id,'Nombre del integrante','member'
from auth.users where lower(email)=lower('integrante@ejemplo.com')
on conflict(user_id) do update set display_name=excluded.display_name,role=excluded.role;
-- Para el responsable del negocio, reemplazar 'member' por 'admin'.
select m.display_name,m.role,u.email from public.crm_members m
join auth.users u on u.id=m.user_id order by m.display_name;
