-- Enfeites adicionais vendidos no fim da criação (upsell) e custo real do frete.
alter table public.pn_orders add column if not exists shipping_cost_cents integer;

create table if not exists public.pn_upsells (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.pn_orders (id) on delete cascade,
  qty              integer not null check (qty between 1 and 3),
  amount_cents     integer not null,
  status           text not null default 'pending' check (status in ('pending', 'paid')),
  mp_preference_id text,
  mp_payment_id    text,
  created_at       timestamptz not null default now(),
  paid_at          timestamptz
);
alter table public.pn_upsells enable row level security;
create index if not exists pn_upsells_order on public.pn_upsells (order_id);

-- Pagamento do adicional aprovado: cria os enfeites no pedido (uma única vez).
create or replace function public.pn_apply_upsell(p_upsell uuid, p_payment text, p_credits integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order uuid;
  v_qty integer;
  v_amount integer;
  v_extras integer;
begin
  update pn_upsells set status = 'paid', paid_at = now(), mp_payment_id = p_payment
   where id = p_upsell and status = 'pending'
  returning order_id, qty, amount_cents into v_order, v_qty, v_amount;
  if v_order is null then
    return false;
  end if;

  select extras into v_extras from pn_orders where id = v_order for update;
  v_qty := least(v_qty, 3 - v_extras);
  if v_qty <= 0 then
    return false;
  end if;

  insert into pn_order_items (order_id, position, credits_total)
  select v_order, v_extras + g, p_credits from generate_series(1, v_qty) g;

  -- Se o pedido ainda não entrou em produção, reabre para o cliente escolher as artes novas.
  update pn_orders
     set extras = extras + v_qty,
         extras_cents = extras_cents + v_amount,
         amount_cents = amount_cents + v_amount,
         confirmed_at = case when production_status = 'aguardando' then null else confirmed_at end
   where id = v_order;
  return true;
end;
$$;
revoke all on function public.pn_apply_upsell(uuid, text, integer) from public, anon, authenticated;

insert into public.pn_settings (key, value) values
  ('extra_price_cents', '1290'),
  ('extra_max', '3'),
  ('free_shipping_up_to_cents', '2000')
on conflict (key) do nothing;
insert into public.pn_settings (key, value) values ('shipping_mode', 'gratis_ate')
 on conflict (key) do update set value = excluded.value;
