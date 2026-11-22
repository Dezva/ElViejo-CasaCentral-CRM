-- V1.4: telemetría mínima, sin textos, fotos, clientes, claves ni costos estimados.
begin;
create table if not exists public.viejo_ai_usage(
 id uuid primary key default gen_random_uuid(),model text not null check(length(model) between 1 and 160),
 operation text not null check(operation in ('conversation','vision')),
 input_tokens bigint check(input_tokens>=0),output_tokens bigint check(output_tokens>=0),total_tokens bigint check(total_tokens>=0),
 context_chars integer check(context_chars>=0),created_at timestamptz not null default now()
);
create index if not exists viejo_ai_usage_date on public.viejo_ai_usage(created_at);
alter table public.viejo_ai_usage enable row level security;
revoke all on public.viejo_ai_usage from public,anon,authenticated;
grant all on public.viejo_ai_usage to service_role;
commit;
