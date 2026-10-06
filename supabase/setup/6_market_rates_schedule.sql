-- Paste this in the Supabase SQL editor. Safe to run again: it replaces the same job.
-- Every 30 minutes the database asks fetch-market-rates to store new rates.
-- The Update rates button still works for an admin or treasury.
--
-- Before the job can succeed, deploy the function fetch-market-rates
-- with Enforce JWT verification turned off.
-- The token below is created here. You do not type or paste a key.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.secrets s where s.name = 'market_rates_cron_token') then
    perform vault.create_secret(
      gen_random_uuid()::text || gen_random_uuid()::text,
      'market_rates_cron_token',
      'Sent as X-Kursi-Token by the 30-minute market rates job'
    );
  end if;
end
$$;

-- Only the service key can read the token. The edge function uses that key
-- to check the header. Signed-in people cannot read it.
create or replace function public.market_rates_cron_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
  from vault.decrypted_secrets ds
  where ds.name = 'market_rates_cron_token'
$$;

revoke all on function public.market_rates_cron_secret() from public, anon, authenticated;
grant execute on function public.market_rates_cron_secret() to service_role;

create or replace function private.refresh_market_rates()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select ds.decrypted_secret into v_token
  from vault.decrypted_secrets ds
  where ds.name = 'market_rates_cron_token';

  if v_token is null or v_token = '' then
    raise warning 'market rates refresh skipped: vault secret market_rates_cron_token is not set';
    return;
  end if;

  begin
    perform net.http_post(
      url := 'https://tktqrdapdvnaznryiije.supabase.co/functions/v1/fetch-market-rates',
      body := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Kursi-Token', v_token
      ),
      timeout_milliseconds := 120000
    );
  exception when others then
    raise warning 'market rates refresh was not sent: %', sqlerrm;
  end;
end;
$$;

revoke execute on function private.refresh_market_rates() from public, anon, authenticated;

-- Replace the job if this file is pasted again.
do $$
declare
  v_jobid bigint;
begin
  for v_jobid in select j.jobid from cron.job j where j.jobname = 'kam-market-rates'
  loop
    perform cron.unschedule(v_jobid);
  end loop;
end
$$;

select cron.schedule(
  'kam-market-rates',
  '*/30 * * * *',
  $$select private.refresh_market_rates()$$
);

-- Ask for a refresh now, then the job repeats every 30 minutes.
select private.refresh_market_rates();
