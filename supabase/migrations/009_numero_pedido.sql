-- Número sequencial do pedido (#001, #002…), dado quando o pagamento é confirmado.
-- Pedidos de teste não recebem número, então a contagem real começa do 1.
alter table public.pn_orders add column if not exists order_no integer unique;
create sequence if not exists public.pn_order_number;

create or replace function public.pn_assign_number()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.payment_status = 'paid' and new.order_no is null and not new.is_test then
    new.order_no := nextval('pn_order_number');
  end if;
  return new;
end;
$$;

drop trigger if exists pn_orders_number on public.pn_orders;
create trigger pn_orders_number before insert or update of payment_status on public.pn_orders
  for each row execute function public.pn_assign_number();

insert into public.pn_settings (key, value) values ('ntfy_topic', '') on conflict (key) do nothing;
