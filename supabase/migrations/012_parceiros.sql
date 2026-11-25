-- Parceiros (pet shops, clínicas, banho e tosa): link/QR por loja e comissão sobre vendas pagas.
--
-- • O cliente chega por patinhasdenatal.eezo.com.br/?p=CODIGO; o site guarda o código por 30 dias
--   e manda no começo do teste grátis. O pedido fica marcado com a loja (partner_id).
-- • A comissão é calculada quando o pagamento entra (foto do valor na hora: mudar a % depois não
--   mexe no passado) e só conta enquanto o pedido estiver pago (reembolso = sai da conta).
-- • Pagamentos de comissão (Pix) ficam em pn_partner_payouts. Saldo = ganho − pago.

create table if not exists pn_partners (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{3,12}$'),
  name text not null,
  contact_name text,
  whatsapp text,
  pix_key text,
  city text,
  commission_pct numeric(5,2) not null default 10 check (commission_pct >= 0 and commission_pct <= 50),
  secret text not null unique,
  active boolean not null default true,
  hits integer not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists pn_partner_payouts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references pn_partners(id) on delete cascade,
  amount_cents integer not null check (amount_cents <> 0),
  note text,
  paid_at timestamptz not null default now()
);

alter table pn_partners enable row level security;
alter table pn_partner_payouts enable row level security;

alter table pn_orders
  add column if not exists partner_id uuid references pn_partners(id) on delete set null,
  add column if not exists partner_commission_cents integer;

create index if not exists pn_orders_partner on pn_orders (partner_id, created_at) where partner_id is not null;
create index if not exists pn_partner_payouts_partner on pn_partner_payouts (partner_id, paid_at);

-- Conta uma visita vinda do QR da loja (uma por navegador) e devolve o nome da loja ativa.
create or replace function pn_partner_hit(p_code text)
returns text
language sql
security definer
set search_path to 'public'
as $$
  update pn_partners set hits = hits + 1 where code = upper(p_code) and active returning name;
$$;

revoke all on function pn_partner_hit(text) from public, anon, authenticated;
grant execute on function pn_partner_hit(text) to service_role;
