-- Observações do cliente no pedido.
alter table public.pn_orders add column if not exists customer_notes text;
