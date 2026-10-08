-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 17_amount_match.sql. Do not re-run 1_platform.sql.
-- If you paste 10_request_sides.sql again, paste this file once more
-- afterwards. That older file puts the rate-expiry message back.
--
-- Stops the SMS whose Georgian text is
-- "{client}-ის კურსი {rate} იწურება {time}-ზე. კლიენტის ტრანზაქცია ჯერ არ შემოსულა."
-- English: "Rate {rate} for {client} expires at {time}. The client's transaction hasn't arrived yet."
-- The minute job still warns treasury when a request has waited too long.
-- GoSMS stays. New-request, client-reply, test, and invite messages stay.

create or replace function private.notify_timers()
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_rules    public.rules%rowtype;
  r          record;
  f          jsonb;
  v_min      int;
  v_extra_en text;
  v_extra_ka text;
begin
  select * into v_rules from public.rules limit 1;

  for r in
    select q.id, q.kam_id, q.asked_at from public.requests q
    where q.quote_status = 'asking' and q.source = 'app'
      and q.asked_at < now() - make_interval(secs => v_rules.treasury_alert_seconds)
  loop
    f := private.request_facts(r.id);
    v_min := greatest(1, floor(extract(epoch from now() - r.asked_at) / 60))::int;
    v_extra_en :=
      case when coalesce(f->>'client_rate_text', '') = '' then ''
           else ' Rate the client is asking: ' || (f->>'client_rate_text') || '.' end
      || coalesce(' Comment: ' || nullif(f->>'note', ''), '');
    v_extra_ka :=
      case when coalesce(f->>'client_rate_text', '') = '' then ''
           else ' კლიენტის მოთხოვნილი კურსი: ' || (f->>'client_rate_text') || '.' end
      || coalesce(' კომენტარი: ' || nullif(f->>'note', ''), '');
    perform private.emit_once('wait:' || r.id || ':' || extract(epoch from r.asked_at)::bigint,
      'request.waiting_long', r.id, r.kam_id,
      format('%s has waited %s min for a rate (%s). Client sells %s. Client gets %s.%s',
             f->>'client_name', v_min, f->>'kam_name', f->>'sells_text', f->>'gets_text', v_extra_en),
      format('%s კურსს %s წუთია ელოდება (%s). კლიენტი ყიდის %s. კლიენტი იღებს %s.%s',
             f->>'client_name', v_min, f->>'kam_name', f->>'sells_text', f->>'gets_text', v_extra_ka),
      f || jsonb_build_object('waiting_minutes', v_min));
  end loop;
end;
$$;

delete from public.notification_rules
 where event_type = 'rate.expiring';

-- A message already waiting, or waiting to be tried again, is not sent.
update public.notification_events
   set status = 'failed',
       attempts = greatest(attempts, 3),
       last_error = 'Stopped: the rate-expiry message is no longer sent.'
 where event_type = 'rate.expiring'
   and status in ('pending', 'failed')
   and attempts < 3;
