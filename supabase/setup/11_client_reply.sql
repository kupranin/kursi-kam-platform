-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after the other setup files.
--
-- After treasury gives a rate, the KAM records the client's answer:
-- approved (writes the rate; treasury and managers are told, and treasury
-- can get an SMS), wants a better rate (treasury accepts or writes a
-- corrected rate), or declined (writes a reason).
-- Old requests are left as they are.
--

alter table public.requests add column if not exists client_reply text;
alter table public.requests add column if not exists approved_rate numeric(18,6);
alter table public.requests add column if not exists wanted_rate numeric(18,6);
alter table public.requests add column if not exists better_decision text;
alter table public.requests add column if not exists given_rate numeric(18,6);
alter table public.requests add column if not exists client_decline_reason text;
alter table public.requests add column if not exists client_replied_at timestamptz;
alter table public.requests add column if not exists better_decided_at timestamptz;
alter table public.requests add column if not exists better_decided_by uuid references public.profiles (id);

comment on column public.requests.client_reply is
  'Client answer after treasury quoted: approved, better, or declined. Empty until the KAM records it.';
comment on column public.requests.approved_rate is
  'Rate the client approved. Set only when client_reply is approved.';
comment on column public.requests.wanted_rate is
  'Rate the client wants instead. Set only when client_reply is better.';
comment on column public.requests.better_decision is
  'Treasury answer to a better-rate reply: accepted, or corrected. Empty while treasury has not answered.';
comment on column public.requests.given_rate is
  'Rate treasury will actually give after accepting or correcting a better-rate reply.';
comment on column public.requests.client_decline_reason is
  'Why the client said no to the quoted rate. Not the Follow-ups loss reason.';

alter table public.requests drop constraint if exists requests_client_reply_ok;
alter table public.requests add constraint requests_client_reply_ok check (
  (
    client_reply is null
    and approved_rate is null
    and wanted_rate is null
    and better_decision is null
    and given_rate is null
    and client_decline_reason is null
  )
  or (
    client_reply = 'approved'
    and approved_rate is not null
    and approved_rate > 0
    and wanted_rate is null
    and better_decision is null
    and given_rate is null
    and client_decline_reason is null
  )
  or (
    client_reply = 'better'
    and wanted_rate is not null
    and wanted_rate > 0
    and approved_rate is null
    and client_decline_reason is null
    and (
      (better_decision is null and given_rate is null)
      or (better_decision = 'accepted' and given_rate is not null and given_rate = wanted_rate)
      or (better_decision = 'corrected' and given_rate is not null and given_rate > 0)
    )
  )
  or (
    client_reply = 'declined'
    and client_decline_reason is not null
    and length(btrim(client_decline_reason)) between 2 and 500
    and approved_rate is null
    and wanted_rate is null
    and better_decision is null
    and given_rate is null
  )
);

create index if not exists requests_better_open_idx
  on public.requests (client_replied_at)
  where client_reply = 'better' and better_decision is null;

-- Outcomes view: same columns as before, then the client's answer.
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
  (w.tx_hit or w.file_won) as went_through,
  case
    when w.tx_hit or w.file_won then 'went_through'
    when w.file_lost then 'did_not_go_through'
    when w.file_open then 'waiting'
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
  end as quote_state,
  r.gets_amount,
  r.client_rate,
  r.loss_reason_note,
  r.client_reply,
  r.approved_rate,
  r.wanted_rate,
  r.better_decision,
  r.given_rate,
  r.client_decline_reason,
  r.client_replied_at,
  r.better_decided_at
from public.requests r
join public.clients c on c.client_id = r.client_id
left join public.profiles p on p.id = r.kam_id
cross join lateral (
  select
    exists (
      select 1
      from public.transactions t
      where t.client_id = r.client_id
        and t.tx_date = r.request_date
        and t.payment_status = 'SUCCESS'
        and (r.source = 'import' or t.tx_time >= r.requested_at - interval '1 minute')
    ) as tx_hit,
    (r.import_key like 'agreement:%' and r.legacy_status = 'შესრულდა') as file_won,
    (r.import_key like 'agreement:%' and r.legacy_status in (
        'არ შესრულდა',
        'ბანკმა გააჩერა ტრანზაქცია',
        'აღარ დასჭირდა და გააუქმა',
        'უარი თქვა, მცირედი განსხვავების გამო ბანკში ურჩევნოდა კონვერტაცია'
    )) as file_lost,
    (r.import_key like 'agreement:%' and (
        r.legacy_status is null
        or r.legacy_status in (
        'შესრულდა ნაწილობრივ',
        'შეთანხმებულია და გაწერეთ კურსი'
        )
    )) as file_open
) w;

-- ---------------------------------------------------------------------
-- KAM: record the client's answer. Only the KAM who owns the request.
-- ---------------------------------------------------------------------
drop function if exists public.kam_client_reply(bigint, text, numeric, text);

create or replace function public.kam_client_reply(
  p_request_id bigint,
  p_reply      text,
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
  f        jsonb;
begin
  if v_me is null or not private.can_write() then
    raise exception 'თქვენს ანგარიშს ამ მოთხოვნის შეცვლა არ შეუძლია' using errcode = '42501';
  end if;

  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_req.kam_id <> v_me then
    raise exception 'ეს მოთხოვნა სხვა კამ-ს ეკუთვნის' using errcode = '42501';
  end if;
  if v_req.source <> 'app' or v_req.quote_status <> 'quoted' then
    raise exception 'სახაზინომ ჯერ კურსი არ გასცა' using errcode = '22023';
  end if;
  if v_req.client_reply is not null then
    raise exception 'ამ მოთხოვნაზე პასუხი უკვე ჩაწერილია' using errcode = '22023';
  end if;
  if v_req.rate_valid_until is null or v_req.rate_valid_until <= now() then
    raise exception 'ეს კურსი ვადაგასულია. თუ კლიენტს კვლავ სურს კონვერტაცია, თავიდან სთხოვეთ.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.transactions t
    where t.client_id = v_req.client_id
      and t.tx_date = v_req.request_date
      and t.payment_status = 'SUCCESS'
      and (v_req.source = 'import' or t.tx_time >= v_req.requested_at - interval '1 minute')
  ) then
    raise exception 'ეს მოთხოვნა უკვე შესრულდა' using errcode = '22023';
  end if;

  if p_reply in ('approved', 'better') then
    if p_rate is null or p_rate <= 0 then
      raise exception 'ჩაწერეთ კურსი' using errcode = '22023';
    end if;
    v_rate := round(p_rate, 6);
  elsif p_reply = 'declined' then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null or length(v_reason) < 2 then
      raise exception 'ჩაწერეთ მიზეზი' using errcode = '22023';
    end if;
    if length(v_reason) > 500 then
      raise exception 'მიზეზი ძალიან გრძელია' using errcode = '22023';
    end if;
  else
    raise exception 'აირჩიეთ პასუხი' using errcode = '22023';
  end if;

  if p_reply = 'approved' then
    update public.requests r
       set client_reply = 'approved',
           approved_rate = v_rate,
           wanted_rate = null,
           better_decision = null,
           given_rate = null,
           client_decline_reason = null,
           client_replied_at = now(),
           better_decided_at = null,
           better_decided_by = null
     where r.id = p_request_id;
  elsif p_reply = 'better' then
    update public.requests r
       set client_reply = 'better',
           wanted_rate = v_rate,
           approved_rate = null,
           better_decision = null,
           given_rate = null,
           client_decline_reason = null,
           client_replied_at = now(),
           better_decided_at = null,
           better_decided_by = null
     where r.id = p_request_id;
  else
    update public.requests r
       set client_reply = 'declined',
           client_decline_reason = v_reason,
           approved_rate = null,
           wanted_rate = null,
           better_decision = null,
           given_rate = null,
           client_replied_at = now(),
           better_decided_at = null,
           better_decided_by = null
     where r.id = p_request_id;
  end if;

  if p_reply = 'approved' then
    begin
      f := private.request_facts(p_request_id);
      perform private.emit(
        'request.client_approved',
        p_request_id,
        v_req.kam_id,
        format('%s: %s approved %s. Quoted rate was %s. Client sells %s. Client gets %s.',
               f->>'kam_name', f->>'client_name', f->>'approved_rate_text', f->>'rate_text',
               f->>'sells_text', f->>'gets_text'),
        format('%s: %s-მა დაამტკიცა კურსი %s. სახაზინოს კურსი იყო %s. კლიენტი ყიდის %s. კლიენტი იღებს %s.',
               f->>'kam_name', f->>'client_name', f->>'approved_rate_text', f->>'rate_text',
               f->>'sells_text', f->>'gets_text'),
        f
      );
    exception when others then
      raise warning 'notification skipped: %', sqlerrm;
    end;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Treasury: accept the rate the client wants, or write another rate.
-- ---------------------------------------------------------------------
drop function if exists public.treasury_answer_better(bigint, text, numeric);

create or replace function public.treasury_answer_better(
  p_request_id bigint,
  p_decision   text,
  p_rate       numeric default null
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me   uuid := private.my_profile_id();
  v_req  public.requests%rowtype;
  v_rate numeric;
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
  else
    raise exception 'აირჩიეთ დადასტურება ან გასწორებული კურსი' using errcode = '22023';
  end if;

  update public.requests r
     set better_decision = p_decision,
         given_rate = v_rate,
         better_decided_at = now(),
         better_decided_by = v_me
   where r.id = p_request_id;
end;
$$;

-- What treasury still needs to see after a quote: a better rate waiting
-- for an answer, plus today's approvals, declines, and answered better rates.
drop function if exists public.treasury_client_replies();

create or replace function public.treasury_client_replies()
returns table (
  request_id            bigint,
  kam_name              text,
  client_id             text,
  client_name           text,
  sells_currency        text,
  gets_currency         text,
  amount                numeric,
  gets_amount           numeric,
  rate                  numeric,
  client_reply          text,
  approved_rate         numeric,
  wanted_rate           numeric,
  better_decision       text,
  given_rate            numeric,
  client_decline_reason text,
  client_replied_at     timestamptz,
  note                  text
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ სახაზინოს შეუძლია ამ სიის ნახვა' using errcode = '42501';
  end if;
  return query
  select r.id,
         p.full_name,
         r.client_id,
         c.name,
         r.sells_currency,
         r.gets_currency,
         r.amount,
         r.gets_amount,
         r.rate,
         r.client_reply,
         r.approved_rate,
         r.wanted_rate,
         r.better_decision,
         r.given_rate,
         r.client_decline_reason,
         r.client_replied_at,
         r.note
  from public.requests r
  join public.clients c on c.client_id = r.client_id
  join public.profiles p on p.id = r.kam_id
  where r.source = 'app'
    and r.client_reply is not null
    and (
      (r.client_reply = 'better' and r.better_decision is null)
      or (r.client_replied_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
      or (r.better_decided_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
    )
  order by
    case when r.client_reply = 'better' and r.better_decision is null then 0 else 1 end,
    r.client_replied_at desc;
end;
$$;

-- Asking again starts a fresh quote. Do not wipe an approval, or a
-- better-rate reply treasury has not answered yet.
create or replace function public.ask_again(p_request_id bigint, p_note text default null)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_row public.request_outcomes%rowtype;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot ask for rates' using errcode = '42501';
  end if;
  select * into v_row from public.request_outcomes o where o.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_row.kam_id <> v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;
  if v_row.went_through then
    raise exception 'This request already went through' using errcode = '22023';
  end if;
  if v_row.quote_state not in ('expired', 'declined') then
    raise exception 'You can ask again once the rate has expired or treasury has sent it back' using errcode = '22023';
  end if;
  if v_row.client_reply = 'approved' then
    raise exception 'კლიენტმა უკვე დაამტკიცა ეს კურსი' using errcode = '22023';
  end if;
  if v_row.client_reply = 'better' and v_row.better_decision is null then
    raise exception 'სახაზინო ჯერ პასუხობს კურსს, რომელიც კლიენტს სურს' using errcode = '22023';
  end if;
  update public.requests r
     set quote_status = 'asking', asked_at = now(), rate = null, rate_valid_until = null,
         decline_reason = null, quoted_by = null, quoted_at = null,
         note = coalesce(nullif(trim(p_note), ''), r.note),
         client_reply = null, approved_rate = null, wanted_rate = null,
         better_decision = null, given_rate = null, client_decline_reason = null,
         client_replied_at = null, better_decided_at = null, better_decided_by = null
   where r.id = p_request_id;
end;
$$;

-- Facts used by SMS. The approved rate is included for the new event.
create or replace function private.request_facts(p_request_id bigint)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'request_id',     r.id,
    'kam_id',         r.kam_id,
    'kam_name',       p.full_name,
    'client_id',      r.client_id,
    'client_name',    coalesce(c.name, r.client_id),
    'sells_currency', r.sells_currency,
    'gets_currency',  r.gets_currency,
    'amount',         r.amount,
    'amount_text',    private.fmt_amount(r.amount),
    'gets_amount',    r.gets_amount,
    'gets_amount_text', private.fmt_amount(r.gets_amount),
    'sells_text',     case
                        when r.amount is null then r.sells_currency
                        else r.sells_currency || ' ' || private.fmt_amount(r.amount)
                      end,
    'gets_text',      case
                        when r.gets_amount is null then r.gets_currency
                        else r.gets_currency || ' ' || private.fmt_amount(r.gets_amount)
                      end,
    'client_rate',    r.client_rate,
    'client_rate_text', private.fmt_rate(r.client_rate),
    'note',           r.note,
    'loss_reason_note', r.loss_reason_note,
    'rate',           r.rate,
    'rate_text',      private.fmt_rate(r.rate),
    'valid_until',    r.rate_valid_until,
    'valid_until_text', private.fmt_time(r.rate_valid_until),
    'decline_reason', r.decline_reason,
    'asked_at',       r.asked_at,
    'client_reply',   r.client_reply,
    'approved_rate',  r.approved_rate,
    'approved_rate_text', private.fmt_rate(r.approved_rate),
    'wanted_rate',    r.wanted_rate,
    'wanted_rate_text', private.fmt_rate(r.wanted_rate),
    'given_rate',     r.given_rate,
    'given_rate_text', private.fmt_rate(r.given_rate),
    'better_decision', r.better_decision,
    'client_decline_reason', r.client_decline_reason
  )
  from public.requests r
  join public.profiles p on p.id = r.kam_id
  left join public.clients c on c.client_id = r.client_id
  where r.id = p_request_id
$$;

insert into public.notification_rules (event_type, audience, enabled, description) values
  ('request.client_approved', 'treasury', true, 'კამ-მა ჩაწერა კურსი, რომელიც კლიენტმა დაამტკიცა'),
  ('request.client_approved', 'manager',  true, 'იგივე დადასტურება მენეჯერებს')
on conflict (event_type, audience) do nothing;

-- A test of this event carries the approved rate, same payload shape as a real one.
create or replace function public.send_test_notification(p_event text)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me   uuid := private.my_profile_id();
  v_data jsonb := jsonb_build_object(
    'test', true, 'request_id', 0, 'kam_name', 'Test KAM', 'client_id', '400000000', 'client_name', 'Test client',
    'sells_currency', 'USD', 'gets_currency', 'GEL', 'amount', 100000, 'amount_text', '100,000',
    'rate', 2.6900, 'rate_text', '2.6900', 'valid_until_text', '12:00', 'decline_reason', 'Amount too large',
    'approved_rate', 2.7000, 'approved_rate_text', '2.7000');
  v_en text;
  v_ka text;
begin
  if not private.is_admin() then
    raise exception 'Only admins can send test messages' using errcode = '42501';
  end if;
  if not exists (select 1 from public.notification_rules nr where nr.event_type = p_event) then
    raise exception 'Unknown message type %', p_event using errcode = '22023';
  end if;
  if p_event = 'request.client_approved' then
    v_en := '[Test] Test KAM: Test client approved 2.7000. Quoted rate was 2.6900. Client sells USD 100,000. Client gets GEL.';
    v_ka := '[ტესტი] Test KAM: Test client-მა დაამტკიცა კურსი 2.7000. სახაზინოს კურსი იყო 2.6900. კლიენტი ყიდის USD 100,000. კლიენტი იღებს GEL-ს.';
  else
    v_en := '[Test] ' || p_event || ': this is how this message arrives. Test client sells USD 100,000 for GEL, rate 2.6900.';
    v_ka := '[ტესტი] ' || p_event || ': ასე მოვა ეს გზავნილი. Test client ყიდის 100,000 USD-ს, კურსი 2.6900.';
  end if;
  return private.emit(p_event, null, v_me, v_en, v_ka, v_data);
end;
$$;

revoke execute on function
  public.kam_client_reply(bigint, text, numeric, text),
  public.treasury_answer_better(bigint, text, numeric),
  public.treasury_client_replies()
from public, anon;

grant execute on function
  public.kam_client_reply(bigint, text, numeric, text),
  public.treasury_answer_better(bigint, text, numeric),
  public.treasury_client_replies()
to authenticated;
