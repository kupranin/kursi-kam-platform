-- Allow the public InexPay board on market_rates.
-- The fetcher stores source inexpay. Existing rows stay.
-- Does not touch requests, quotes, or transactions.

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
    'crystal', 'girocredit', 'fxhub', 'inexpay'
  ));

create or replace function private.rate_identity(p_source text, p_venue text, p_kind text)
returns table (key text, label text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text;
begin
  if p_kind = 'kiosk' or coalesce(p_venue, '') like '% app' then
    return;
  end if;
  v_name := lower(regexp_replace(coalesce(p_venue, ''), '[^a-zA-Z0-9]', '', 'g'));
  if p_source = 'kursi' and p_kind = 'board' then
    key := 'kursi'; label := 'Kursi'; return next; return;
  end if;
  if p_source = 'rico' and p_kind = 'board' then
    key := 'rico'; label := 'Rico'; return next; return;
  end if;
  if p_kind = 'bank' and v_name in ('tbc', 'tbcbank', 'tbcge') then
    key := 'tbc'; label := 'TBC'; return next; return;
  end if;
  if p_kind = 'bank' and v_name in ('bog', 'bogge', 'bankofgeorgia') then
    key := 'bog'; label := 'BOG'; return next; return;
  end if;
  if p_source = 'valuto' and p_kind = 'board' then
    key := 'valuto'; label := 'Valuto'; return next; return;
  end if;
  if p_source = 'expresslombard' and p_kind = 'board' then
    key := 'lombard'; label := 'Express Lombard'; return next; return;
  end if;
  if p_source = 'crystal' and p_kind = 'board' then
    key := 'crystal'; label := 'Crystal'; return next; return;
  end if;
  if p_source = 'girocredit' and p_kind = 'board' then
    key := 'giro'; label := 'Giro Credit'; return next; return;
  end if;
  if p_source = 'fxhub' and p_kind = 'board' then
    key := 'fxhub'; label := 'FX Hub'; return next; return;
  end if;
  if p_source = 'inexpay' and p_kind = 'board' then
    key := 'inexpay'; label := 'InexPay'; return next; return;
  end if;
  if p_kind = 'bank' and v_name <> '' then
    key := 'bank:' || v_name; label := p_venue; return next;
  end if;
end;
$$;
