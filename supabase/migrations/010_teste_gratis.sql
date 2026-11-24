-- Teste grátis: o cliente cria a arte antes de pagar.
-- O pedido nasce como "teste" (trial), sem contato; os dados entram enquanto a arte é desenhada
-- (lead_at) e o pagamento vem depois, no mesmo pedido.

alter table pn_orders
  alter column name drop not null,
  alter column email drop not null,
  alter column whatsapp drop not null,
  alter column amount_cents set default 0;

alter table pn_orders
  add column if not exists trial boolean not null default false,
  add column if not exists lead_at timestamptz,
  add column if not exists client_ip text;

-- gerações feitas antes de pagar (contam no limite diário de testes grátis)
alter table pn_generations add column if not exists free boolean not null default false;

create index if not exists pn_orders_trial_ip on pn_orders (client_ip, created_at) where trial;
create index if not exists pn_generations_free on pn_generations (created_at) where free;

-- Pode gerar: pedido pago ainda não finalizado, ou teste grátis (só o enfeite principal).
create or replace function pn_start_generation_item(p_order uuid, p_item integer, p_source text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_free boolean;
begin
  perform 1 from pn_orders where id = p_order for update;

  if exists (select 1 from pn_generations where order_id = p_order and status = 'processing') then
    return null;
  end if;
  select payment_status = 'pending' into v_free
    from pn_orders
   where id = p_order and confirmed_at is null
     and (payment_status = 'paid' or (payment_status = 'pending' and trial and p_item = 0));
  if v_free is null then
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

  insert into pn_generations (order_id, source_path, item, free)
  values (p_order, p_source, p_item, v_free)
  returning id into v_id;
  return v_id;
end;
$$;

insert into pn_settings (key, value) values
  ('trial_credits', '2'),
  ('trial_daily_cap', '300'),
  ('trial_ip_limit', '6')
on conflict (key) do nothing;
