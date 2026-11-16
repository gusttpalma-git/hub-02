-- Frete calculado por CEP e link do site (usado nos e-mails do pedido).
alter table public.pn_orders
  add column if not exists shipping_cents integer not null default 0,
  add column if not exists shipping_label text,
  add column if not exists site_url text;

insert into public.pn_settings (key, value) values
  ('shipping_mode', 'incluso'),
  ('package_weight_g', '100')
on conflict (key) do nothing;

-- Cada pedido novo passa a ter 4 artes.
insert into public.pn_settings (key, value) values ('credits_per_order', '4')
on conflict (key) do update set value = '4', updated_at = now();
alter table public.pn_orders alter column credits_total set default 4;
