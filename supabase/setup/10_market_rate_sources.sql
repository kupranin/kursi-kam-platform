-- Paste this in the Supabase SQL editor. Safe to run again.
-- The rates table only allowed Kursi, Rico, Myvaluta, Valuto and Express Lombard.
-- This lets it store Crystal, Giro Credit and FX Hub as well.
-- Rows already stored stay. This does not touch requests, quotes or transactions.

do $$
declare
  cname text;
begin
  for cname in
    select c.conname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = 'public.market_rates'::regclass
      and c.contype = 'c'
      and a.attname = 'source'
  loop
    execute format('alter table public.market_rates drop constraint %I', cname);
  end loop;
end
$$;

alter table public.market_rates
  add constraint market_rates_source_check
  check (source in (
    'kursi', 'rico', 'myvaluta', 'valuto', 'expresslombard',
    'crystal', 'girocredit', 'fxhub'
  ));
