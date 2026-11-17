-- O cliente já escolhe na oferta se o 2º enfeite é de outro pet ou igual ao primeiro.
alter table public.pn_upsells add column if not exists kind text check (kind in ('novo', 'copia'));

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
  v_kind text;
  v_extras integer;
begin
  update pn_upsells set status = 'paid', paid_at = now(), mp_payment_id = p_payment
   where id = p_upsell and status = 'pending'
  returning order_id, qty, amount_cents, kind into v_order, v_qty, v_amount, v_kind;
  if v_order is null then
    return false;
  end if;

  select extras into v_extras from pn_orders where id = v_order for update;
  v_qty := least(v_qty, 3 - v_extras);
  if v_qty <= 0 then
    return false;
  end if;

  insert into pn_order_items (order_id, position, credits_total, kind)
  select v_order, v_extras + g, p_credits, v_kind from generate_series(1, v_qty) g;

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

-- Só 1 enfeite a mais por pedido.
insert into public.pn_settings (key, value) values ('extra_max', '1')
on conflict (key) do update set value = excluded.value, updated_at = now();
