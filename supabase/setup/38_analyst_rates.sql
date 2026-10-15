-- Paste this in the Supabase SQL editor. Copy it from disk. Safe to run again.
-- An analyst can read stored rates and download them. They still cannot
-- refresh the live board. This does not open analytics, the bank file, or admin.

drop policy if exists market_rates_read on public.market_rates;
create policy market_rates_read on public.market_rates
  for select to authenticated
  using ((select private.my_role()) in ('admin', 'manager', 'treasury', 'kam', 'analyst'));

do $$
begin
  if to_regclass('public.market_rate_hours') is null then
    return;
  end if;
  execute 'drop policy if exists market_rate_hours_read on public.market_rate_hours';
  execute $policy$
    create policy market_rate_hours_read on public.market_rate_hours
      for select to authenticated
      using ((select private.my_role()) in ('admin', 'manager', 'treasury', 'kam', 'analyst'))
  $policy$;
end $$;
