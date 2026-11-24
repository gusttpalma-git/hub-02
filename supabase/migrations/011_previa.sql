-- Prévia da arte (menor) mostrada ao cliente antes do pagamento; a original fica para a produção.
alter table pn_generations add column if not exists preview_path text;
