-- Enfeites adicionais no mesmo pedido (outro pet ou mais um igual).
alter table public.pn_orders
  add column if not exists extras integer not null default 0 check (extras between 0 and 3),
  add column if not exists extras_cents integer not null default 0;

create table if not exists public.pn_order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.pn_orders (id) on delete cascade,
  position          integer not null check (position between 1 and 3),
  kind              text check (kind in ('novo', 'copia')),
  credits_total     integer not null default 3,
  credits_used      integer not null default 0,
  chosen_generation uuid references public.pn_generations (id) on delete set null,
  pet_name          text,
  unique (order_id, position)
);
alter table public.pn_order_items enable row level security;

alter table public.pn_generations add column if not exists item integer not null default 0;

-- Como pn_start_generation, mas para o pet principal (item 0) ou um adicional (1..3).
create or replace function public.pn_start_generation_item(p_order uuid, p_item integer, p_source text)
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
  if not exists (select 1 from pn_orders where id = p_order and payment_status = 'paid' and confirmed_at is null) then
    return null;
  end if;

  if p_item = 0 then
    update pn_orders set credits_used = credits_used + 1
     where id = p_order and credits_used < credits_total;
  else
    update pn_order_items set credits_used = credits_used + 1, kind = coalesce(kind, 'novo')
     where order_id = p_order and position = p_item and coalesce(kind, 'novo') = 'novo' and credits_used < credits_total;
  end if;
  if not found then
    return null;
  end if;

  insert into pn_generations (order_id, source_path, item)
  values (p_order, p_source, p_item)
  returning id into v_id;
  return v_id;
end;
$$;

-- Devolve o crédito ao item certo quando a geração falha.
create or replace function public.pn_fail_generation(p_gen uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order uuid;
  v_item integer;
begin
  update pn_generations
     set status = 'failed', error = left(p_error, 500), finished_at = now()
   where id = p_gen and status = 'processing'
  returning order_id, item into v_order, v_item;

  if v_order is null then
    return;
  end if;
  if coalesce(v_item, 0) = 0 then
    update pn_orders set credits_used = greatest(credits_used - 1, 0) where id = v_order;
  else
    update pn_order_items set credits_used = greatest(credits_used - 1, 0) where order_id = v_order and position = v_item;
  end if;
end;
$$;

revoke all on function public.pn_start_generation_item(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.pn_start_generation_item(uuid, integer, text) to service_role;

insert into public.pn_settings (key, value) values
  ('extra_prices', '1290,990,690'),
  ('extra_credits', '3')
on conflict (key) do nothing;
