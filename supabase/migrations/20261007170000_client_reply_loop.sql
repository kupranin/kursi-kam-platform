-- After a treasury quote, the client's answer can go around again.
-- Accepting or correcting a better rate sends that rate back to the KAM.
-- Only client approved, client declined, or treasury declined stops it.
-- The file to paste in the SQL editor is supabase/setup/11_client_reply.sql.
-- This migration is the same loop for databases that already ran
-- 20261007160000_client_reply.sql. It does not replace that file.

-- Remove the previous treasury_answer_better, whatever its argument names were.
do $drop_better$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'treasury_answer_better'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end
$drop_better$;

-- ---------------------------------------------------------------------
-- Treasury: accept the rate the client wants, write another rate, or
-- decline. Accept and correct send that rate back to the KAM and do
-- not end the loop. Decline writes a reason and ends it.
-- Argument names: p_request_id, p_decision, p_rate, p_reason.
-- ---------------------------------------------------------------------
create or replace function public.treasury_answer_better(
  p_request_id bigint,
  p_decision   text,
  p_rate       numeric default null,
  p_reason     text default null
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me     uuid := private.my_profile_id();
  v_req    public.requests%rowtype;
  v_rate   numeric;
  v_reason text;
  v_min    int;
  v_until  timestamptz;
  f        jsonb;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ სახაზინოს შეუძლია ამ კურსის პასუხი' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.client_reply <> 'better' or v_req.better_decision is not null or v_req.wanted_rate is null then
    raise exception 'ეს მოთხოვნა აღარ ელოდება უკეთეს კურსს' using errcode = '22023';
  end if;

  if p_decision = 'accepted' then
    v_rate := v_req.wanted_rate;
  elsif p_decision = 'corrected' then
    if p_rate is null or p_rate <= 0 then
      raise exception 'ჩაწერეთ გასწორებული კურსი' using errcode = '22023';
    end if;
    v_rate := round(p_rate, 6);
  elsif p_decision = 'declined' then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null or length(v_reason) < 2 then
      raise exception 'ჩაწერეთ მიზეზი' using errcode = '22023';
    end if;
    if length(v_reason) > 200 then
      raise exception 'მიზეზი ძალიან გრძელია' using errcode = '22023';
    end if;
  else
    raise exception 'აირჩიეთ დადასტურება, გასწორებული კურსი ან უარი' using errcode = '22023';
  end if;

  if p_decision = 'declined' then
    -- The client has not agreed. Treasury stopping here ends the loop.
    update public.requests r
       set quote_status = 'declined',
           decline_reason = v_reason,
           quoted_by = v_me,
           quoted_at = now(),
           rate = null,
           rate_valid_until = null,
           client_reply = null,
           approved_rate = null,
           wanted_rate = null,
           better_decision = null,
           given_rate = null,
           client_decline_reason = null,
           client_replied_at = null,
           better_decided_at = null,
           better_decided_by = null
     where r.id = p_request_id;
    insert into public.quotes (request_id, action, reason, created_by)
    values (p_request_id, 'declined', v_reason, v_me);
    begin
      f := private.request_facts(p_request_id);
      perform private.emit(
        'request.sent_back',
        p_request_id,
        v_req.kam_id,
        format('Treasury sent back %s (client sells %s, client gets %s): %s',
               f->>'client_name', f->>'sells_text', f->>'gets_text', f->>'decline_reason'),
        format('სახაზინო სამსახურმა დააბრუნა მოთხოვნა: %s (კლიენტი ყიდის %s, იღებს %s). მიზეზი: %s',
               f->>'client_name', f->>'sells_text', f->>'gets_text', f->>'decline_reason'),
        f
      );
    exception when others then
      raise warning 'notification skipped: %', sqlerrm;
    end;
    return;
  end if;

  -- Accept or correct: this is the new rate for the client. The KAM
  -- must ask the client again, so the previous reply is cleared.
  select rules.default_quote_minutes into v_min from public.rules rules limit 1;
  if v_min is null or v_min < 1 or v_min > 240 then
    v_min := 15;
  end if;
  v_until := now() + make_interval(mins => v_min);

  update public.requests r
     set rate = v_rate,
         quote_status = 'quoted',
         rate_valid_until = v_until,
         quoted_by = v_me,
         quoted_at = now(),
         decline_reason = null,
         client_reply = null,
         approved_rate = null,
         wanted_rate = null,
         better_decision = null,
         given_rate = null,
         client_decline_reason = null,
         client_replied_at = null,
         better_decided_at = null,
         better_decided_by = null
   where r.id = p_request_id;
  insert into public.quotes (request_id, action, rate, valid_until, created_by)
  values (p_request_id, 'quoted', v_rate, v_until, v_me);
  begin
    f := private.request_facts(p_request_id);
    perform private.emit(
      'rate.ready',
      p_request_id,
      v_req.kam_id,
      format('Rate for %s: %s. Client sells %s. Client gets %s. Valid until %s.',
             f->>'client_name', f->>'rate_text', f->>'sells_text', f->>'gets_text', f->>'valid_until_text'),
      format('%s-ის კურსი: %s. კლიენტი ყიდის %s. კლიენტი იღებს %s. მოქმედებს %s-მდე.',
             f->>'client_name', f->>'rate_text', f->>'sells_text', f->>'gets_text', f->>'valid_until_text'),
      f
    );
  exception when others then
    raise warning 'notification skipped: %', sqlerrm;
  end;
end;
$$;


revoke execute on function public.treasury_answer_better(bigint, text, numeric, text) from public, anon;
grant execute on function public.treasury_answer_better(bigint, text, numeric, text) to authenticated;

-- A better rate treasury already accepted or corrected is not finished.
-- Send that rate back so the KAM sees it and can answer again.
update public.requests r
   set rate = r.given_rate,
       quote_status = 'quoted',
       rate_valid_until = now() + make_interval(mins => coalesce(
         (select rules.default_quote_minutes from public.rules rules limit 1), 15)),
       quoted_at = now(),
       decline_reason = null,
       client_reply = null,
       approved_rate = null,
       wanted_rate = null,
       better_decision = null,
       given_rate = null,
       client_decline_reason = null,
       client_replied_at = null,
       better_decided_at = null,
       better_decided_by = null
 where r.source = 'app'
   and r.quote_status = 'quoted'
   and r.client_reply = 'better'
   and r.better_decision in ('accepted', 'corrected')
   and r.given_rate is not null
   and not exists (
     select 1 from public.transactions t
     where t.client_id = r.client_id
       and t.tx_date = r.request_date
       and t.payment_status = 'SUCCESS'
       and t.tx_time >= r.requested_at - interval '1 minute'
   );
