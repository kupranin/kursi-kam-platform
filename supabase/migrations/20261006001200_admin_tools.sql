-- =====================================================================
-- KAM platform, migration 12: what the admin screen and live updates need
-- =====================================================================

-- "Sync now" runs count as fresh data too
create or replace function public.data_freshness()
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select max(s.finished_at)
  from private.sync_runs s
  where s.ok and s.kind in ('hourly', 'nightly', 'manual')
$$;

-- Data sync panel: freshness, last runs, clients waiting for history
create or replace function public.admin_sync_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only admins can see the sync status' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'freshness', public.data_freshness(),
    'last_nightly', (select max(s.finished_at) from private.sync_runs s where s.ok and s.kind = 'nightly'),
    'backfill_waiting', (select count(*) from private.backfill_queue q where q.done_at is null and q.attempts < 5),
    'runs', coalesce((
      select jsonb_agg(x order by x.started_at desc)
      from (
        select s.id, s.kind, s.started_at, s.finished_at, s.ok, s.rows_upserted, s.error
        from private.sync_runs s
        order by s.started_at desc
        limit 10
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

-- "Sync now" button: re-reads the last 2 days right away
create or replace function public.admin_sync_now()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only admins can start a sync' using errcode = '42501';
  end if;
  perform private.sync_transactions(2, 'manual');
  return public.admin_sync_status();
end;
$$;

-- Messages panel: is each role's Make webhook set, and how is delivery going
create or replace function public.admin_message_status()
returns table (audience text, has_webhook boolean, last_delivered_at timestamptz, failed_last_24h bigint, waiting bigint)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_admin() then
    raise exception 'Only admins can see message status' using errcode = '42501';
  end if;
  return query
  select a.aud,
         exists (select 1 from vault.decrypted_secrets ds where ds.name = 'make_webhook_' || a.aud),
         (select max(n.delivered_at) from public.notification_events n where n.audience = a.aud),
         (select count(*) from public.notification_events n where n.audience = a.aud and n.status = 'failed' and n.created_at > now() - interval '1 day'),
         (select count(*) from public.notification_events n where n.audience = a.aud and n.status in ('pending', 'sent'))
  from (values ('treasury'), ('kam'), ('admin'), ('manager')) a(aud);
end;
$$;

revoke execute on function public.admin_sync_status(), public.admin_sync_now(), public.admin_message_status(), public.data_freshness() from public, anon;
grant execute on function public.admin_sync_status(), public.admin_sync_now(), public.admin_message_status(), public.data_freshness() to authenticated;

-- Live updates: new requests reach treasury and rates reach KAMs without refreshing.
-- Realtime still applies the access rules, so everyone only receives rows they may see.
do $$
begin
  alter publication supabase_realtime add table public.requests;
exception when others then
  raise notice 'Realtime publication not changed: %', sqlerrm;
end;
$$;
