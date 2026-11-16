-- Patinha de Natal — estrutura do banco
-- Todas as tabelas têm RLS ligado e NENHUMA policy: só a Edge Function
-- (service role) lê e escreve. O site nunca fala direto com o banco.

create extension if not exists pgcrypto;

create table if not exists public.pn_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.pn_settings enable row level security;

create table if not exists public.pn_orders (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  token             text not null unique,
  name              text not null,
  email             text not null,
  whatsapp          text not null,
  amount_cents      integer not null,
  payment_status    text not null default 'pending'
                    check (payment_status in ('pending', 'paid', 'refunded')),
  mp_preference_id  text,
  mp_payment_id     text,
  paid_at           timestamptz,
  is_test           boolean not null default false,
  credits_total     integer not null default 3,
  credits_used      integer not null default 0,
  chosen_generation uuid,
  pet_name          text,
  recipient         text,
  cep               text,
  street            text,
  number            text,
  complement        text,
  district          text,
  city              text,
  state             text,
  confirmed_at      timestamptz,
  production_status text not null default 'aguardando'
                    check (production_status in ('aguardando', 'producao', 'enviado', 'entregue')),
  tracking_code     text,
  admin_notes       text,
  created_at        timestamptz not null default now()
);
alter table public.pn_orders enable row level security;
create index if not exists pn_orders_created_idx on public.pn_orders (created_at desc);
create index if not exists pn_orders_email_idx on public.pn_orders (lower(email));

create table if not exists public.pn_generations (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.pn_orders (id) on delete cascade,
  status      text not null default 'processing'
              check (status in ('processing', 'done', 'failed')),
  source_path text not null,
  result_path text,
  error       text,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.pn_generations enable row level security;
create index if not exists pn_generations_order_idx on public.pn_generations (order_id, created_at);

alter table public.pn_orders
  drop constraint if exists pn_orders_chosen_fk;
alter table public.pn_orders
  add constraint pn_orders_chosen_fk
  foreign key (chosen_generation) references public.pn_generations (id) on delete set null;

-- Gasta 1 crédito e cria a geração, de forma atômica.
-- Devolve o id da geração, ou null se não há crédito / já existe uma em andamento.
create or replace function public.pn_start_generation(p_order uuid, p_source text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform 1 from pn_orders where id = p_order for update;

  if exists (select 1 from pn_generations where order_id = p_order and status = 'processing') then
    return null;
  end if;

  update pn_orders
     set credits_used = credits_used + 1
   where id = p_order
     and payment_status = 'paid'
     and confirmed_at is null
     and credits_used < credits_total;
  if not found then
    return null;
  end if;

  insert into pn_generations (order_id, source_path)
  values (p_order, p_source)
  returning id into v_id;
  return v_id;
end;
$$;

-- Marca a geração como falha e devolve o crédito (só uma vez).
create or replace function public.pn_fail_generation(p_gen uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order uuid;
begin
  update pn_generations
     set status = 'failed', error = left(p_error, 500), finished_at = now()
   where id = p_gen and status = 'processing'
  returning order_id into v_order;

  if v_order is not null then
    update pn_orders set credits_used = greatest(credits_used - 1, 0) where id = v_order;
  end if;
end;
$$;

revoke all on function public.pn_start_generation(uuid, text) from public, anon, authenticated;
revoke all on function public.pn_fail_generation(uuid, text) from public, anon, authenticated;
grant execute on function public.pn_start_generation(uuid, text) to service_role;
grant execute on function public.pn_fail_generation(uuid, text) to service_role;

-- Bucket privado com as fotos enviadas e as artes geradas.
insert into storage.buckets (id, name, public, file_size_limit)
values ('pn-pets', 'pn-pets', false, 10485760)
on conflict (id) do nothing;

-- Configurações iniciais (podem ser alteradas no painel /admin.html).
insert into public.pn_settings (key, value) values
  ('price_cents', '4990'),
  ('credits_per_order', '3'),
  ('test_mode', 'false'),
  ('openai_image_model', 'gpt-image-2'),
  ('openai_image_quality', 'medium')
on conflict (key) do nothing;
