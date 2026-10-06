-- =====================================================================
-- KAM platform, migration 13: a request only "went through" on a
-- transaction made after the request; imported rows are history
--
-- Same-day matching alone marked a new request as done when the client
-- had already converted earlier that day. Requests from the app now need
-- a successful transaction on the same day AND after the request was made
-- (1 minute's leeway for clock differences). Imported history keeps the date-only rule, since
-- the old file has no times.
-- =====================================================================

create or replace view public.request_outcomes
with (security_invoker = true)
as
select
  r.id,
  r.kam_id,
  p.full_name  as kam_name,
  r.client_id,
  c.name       as client_name,
  c.kind       as client_kind,
  r.requested_at,
  r.request_date,
  r.sells_currency,
  r.gets_currency,
  r.amount,
  r.rate,
  r.note,
  r.loss_reason,
  r.loss_reason_at,
  r.source,
  w.went_through,
  case
    when w.went_through then 'went_through'
    when r.request_date >= coalesce(private.freshness_date(), r.request_date) then 'waiting'
    else 'did_not_go_through'
  end as outcome,
  r.asked_at,
  r.quote_status,
  r.rate_valid_until,
  r.quoted_at,
  r.decline_reason,
  case
    when r.quote_status = 'quoted' and r.rate_valid_until is not null and r.rate_valid_until < now() then 'expired'
    else r.quote_status
  end as quote_state
from public.requests r
join public.clients c on c.client_id = r.client_id
left join public.profiles p on p.id = r.kam_id
cross join lateral (
  select exists (
    select 1
    from public.transactions t
    where t.client_id = r.client_id
      and t.tx_date = r.request_date
      and t.payment_status = 'SUCCESS'
      -- a request from the app only counts transactions made after it was asked
      -- (1 minute's leeway for clock differences); imported history has no times
      and (r.source = 'import' or t.tx_time >= r.requested_at - interval '1 minute')
  ) as went_through
) w;

create or replace function private.notify_transaction()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  r  record;
  f  jsonb;
begin
  begin
    if new.payment_status <> 'SUCCESS' then
      return null;
    end if;
    for r in
      select q.id, q.kam_id from public.requests q
      where q.client_id = new.client_id and q.request_date = new.tx_date
        and q.quote_status = 'quoted' and q.source = 'app'
        and new.tx_time >= q.requested_at - interval '1 minute'
    loop
      f := private.request_facts(r.id);
      perform private.emit_once('went:' || r.id, 'request.went_through', r.id, r.kam_id,
        format('%s''s transaction arrived: the request at %s went through.', f->>'client_name', f->>'rate_text'),
        format('%s-ის ტრანზაქცია შემოვიდა: მოთხოვნა %s კურსით შესრულდა.', f->>'client_name', f->>'rate_text'),
        f || jsonb_build_object('tx_id', new.tx_id));
    end loop;
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;
  return null;
end;
$$;

create or replace function private.notify_timers()
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_rules public.rules%rowtype;
  r       record;
  f       jsonb;
  v_min   int;
begin
  select * into v_rules from public.rules limit 1;

  for r in
    select q.id, q.kam_id, q.asked_at from public.requests q
    where q.quote_status = 'asking' and q.source = 'app'
      and q.asked_at < now() - make_interval(secs => v_rules.treasury_alert_seconds)
  loop
    f := private.request_facts(r.id);
    v_min := greatest(1, floor(extract(epoch from now() - r.asked_at) / 60))::int;
    perform private.emit_once('wait:' || r.id || ':' || extract(epoch from r.asked_at)::bigint,
      'request.waiting_long', r.id, r.kam_id,
      format('%s has waited %s min for a rate (%s, sells %s %s for %s).',
             f->>'client_name', v_min, f->>'kam_name', f->>'sells_currency', f->>'amount_text', f->>'gets_currency'),
      format('%s კურსს %s წუთია ელოდება (%s, ყიდის %s %s-ს, იღებს %s-ს).',
             f->>'client_name', v_min, f->>'kam_name', f->>'amount_text', f->>'sells_currency', f->>'gets_currency'),
      f || jsonb_build_object('waiting_minutes', v_min));
  end loop;

  for r in
    select q.id, q.kam_id, q.rate_valid_until from public.requests q
    where q.quote_status = 'quoted' and q.source = 'app'
      and q.rate_valid_until > now()
      and q.rate_valid_until <= now() + make_interval(mins => v_rules.expiry_warning_minutes)
      and not exists (
        select 1 from public.transactions t
        where t.client_id = q.client_id and t.tx_date = q.request_date and t.payment_status = 'SUCCESS'
          and t.tx_time >= q.requested_at - interval '1 minute'
      )
  loop
    f := private.request_facts(r.id);
    perform private.emit_once('exp:' || r.id || ':' || extract(epoch from r.rate_valid_until)::bigint,
      'rate.expiring', r.id, r.kam_id,
      format('Rate %s for %s expires at %s. The client''s transaction hasn''t arrived yet.',
             f->>'rate_text', f->>'client_name', f->>'valid_until_text'),
      format('%s-ის კურსი %s იწურება %s-ზე. კლიენტის ტრანზაქცია ჯერ არ შემოსულა.',
             f->>'client_name', f->>'rate_text', f->>'valid_until_text'),
      f);
  end loop;
end;
$$;

-- Rows from the old agreement file are history: never waiting for treasury
create or replace function private.import_rows_are_history()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.source = 'import' then
    new.quote_status := 'quoted';
    new.asked_at := new.requested_at;
  end if;
  return new;
end;
$$;
create trigger import_rows_are_history before insert on public.requests
  for each row execute function private.import_rows_are_history();
update public.requests set quote_status = 'quoted', asked_at = requested_at
where source = 'import' and quote_status = 'asking';

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today(),
  private.is_treasury()
to authenticated;
