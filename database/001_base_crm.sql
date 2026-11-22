-- VELTURIO CRM v1 · Supabase SQL Editor
-- Ejecutar UNA VEZ en un proyecto nuevo destinado exclusivamente al CRM.
-- NO crea usuarios de Auth: se invitan aparte desde Authentication > Users.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Solo el administrador del proyecto (SQL Editor) puede insertar miembros.
create table if not exists public.crm_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  role text not null check (role in ('admin', 'member')),
  created_at timestamptz not null default now()
);

create table if not exists public.crm_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  company text not null default '' check (length(company) <= 120),
  phone text not null default '' check (length(phone) <= 45),
  email text not null default '' check (length(email) <= 255),
  service text not null default 'Otro servicio' check (length(btrim(service)) between 1 and 120),
  status text not null default 'nuevo' check (status in ('nuevo', 'contactado', 'propuesta', 'cliente', 'inactivo')),
  notes text not null default '' check (length(notes) <= 3000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Compatible con bases creadas usando la v1.1; admite nuevos planes sin alterar la tabla cada vez.
alter table public.crm_clients drop constraint if exists crm_clients_service_check;
alter table public.crm_clients add constraint crm_clients_service_check check (length(btrim(service)) between 1 and 120);

create index if not exists crm_clients_created_idx on public.crm_clients(created_at desc);
create index if not exists crm_clients_status_idx on public.crm_clients(status);

-- Las funciones de autorización viven en un esquema NO expuesto por la API.
-- SECURITY DEFINER resuelve la comprobación de miembros sin recursión RLS.
create or replace function private.crm_is_member()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.crm_members m
    where m.user_id = (select auth.uid())
  );
$$;

create or replace function private.crm_is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.crm_members m
    where m.user_id = (select auth.uid()) and m.role = 'admin'
  );
$$;

revoke all on function private.crm_is_member() from public;
revoke all on function private.crm_is_admin() from public;
grant execute on function private.crm_is_member() to authenticated;
grant execute on function private.crm_is_admin() to authenticated;

create or replace function private.crm_touch_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists crm_clients_touch on public.crm_clients;
create trigger crm_clients_touch
before update on public.crm_clients
for each row execute function private.crm_touch_updated_at();

alter table public.crm_members enable row level security;
alter table public.crm_clients enable row level security;

-- Permisos mínimos de la API: visitantes sin autenticar no acceden.
revoke all on table public.crm_members from public, anon, authenticated;
revoke all on table public.crm_clients from public, anon, authenticated;
grant select on table public.crm_members to authenticated;
grant select, delete on table public.crm_clients to authenticated;
grant insert (name, company, phone, email, service, status, notes)
  on table public.crm_clients to authenticated;
grant update (name, company, phone, email, service, status, notes)
  on table public.crm_clients to authenticated;

-- Solo cada miembro puede leer SU perfil de acceso.
drop policy if exists crm_members_read_self on public.crm_members;
create policy crm_members_read_self on public.crm_members
for select to authenticated
using (user_id = (select auth.uid()));

-- Los miembros autorizados pueden leer, crear y editar clientes.
drop policy if exists crm_clients_read on public.crm_clients;
create policy crm_clients_read on public.crm_clients
for select to authenticated
using ((select private.crm_is_member()));

drop policy if exists crm_clients_insert on public.crm_clients;
create policy crm_clients_insert on public.crm_clients
for insert to authenticated
with check ((select private.crm_is_member()));

drop policy if exists crm_clients_update on public.crm_clients;
create policy crm_clients_update on public.crm_clients
for update to authenticated
using ((select private.crm_is_member()))
with check ((select private.crm_is_member()));

-- Solo los administradores pueden eliminar registros.
drop policy if exists crm_clients_delete on public.crm_clients;
create policy crm_clients_delete on public.crm_clients
for delete to authenticated
using ((select private.crm_is_admin()));

-- IMPORTANTE: registrar los 4 integrantes con el archivo `dar-acceso.sql`,
-- después de invitarlos en Supabase > Authentication > Users.
