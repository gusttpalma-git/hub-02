-- Venda de balcão (lojas parceiras, foco em Cosmópolis):
-- • a loja parceira pode ser ponto de retirada (endereço e horário próprios);
-- • quem veio pela loja e não precisa de Correios (retira na loja ou recebe em mãos na cidade)
--   paga o "preço de balcão" (configurável no painel); a comissão padrão sobe para 15%.

alter table pn_partners
  add column if not exists pickup boolean not null default true,
  add column if not exists address text,
  add column if not exists hours text;

alter table pn_partners alter column commission_pct set default 15;

alter table pn_orders
  add column if not exists local_deal boolean not null default false,
  add column if not exists pickup_label text;

insert into pn_settings (key, value) values
  ('local_price_cents', '2990'),
  ('local_extra_prices_cents', '1500,1200,1200'),
  ('local_ceps', '13150'),
  ('local_delivery_cents', '500'),
  ('pickup_days', '3')
on conflict (key) do nothing;
