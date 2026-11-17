-- Retirada no ponto (Studio Lina Palma, Cosmópolis) como alternativa aos Correios.
alter table public.pn_orders
  add column if not exists delivery_method text not null default 'correios'
  check (delivery_method in ('correios', 'retirada'));

insert into public.pn_settings (key, value) values
  ('pickup_enabled', 'true'),
  ('pickup_name', 'Studio Lina Palma'),
  ('pickup_address', 'Rua 7 de Setembro, 433 - Centro, Cosmópolis - SP, 13150-013')
on conflict (key) do nothing;
