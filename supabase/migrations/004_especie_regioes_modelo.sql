-- Tipo de pet de cada arte, embalagem do Mini Envios e medidas da peça 3D.
alter table public.pn_generations add column if not exists species text;

insert into public.pn_settings (key, value) values
  ('package_length', '16'),
  ('package_width', '11'),
  ('package_height', '2'),
  ('model_diameter', '70'),
  ('model_base', '3.2'),
  ('model_band', '0.4')
on conflict (key) do nothing;

-- Peça de ~20 g + envelope: 50 g no total.
update public.pn_settings set value = '50', updated_at = now()
 where key = 'package_weight_g' and value = '100';
