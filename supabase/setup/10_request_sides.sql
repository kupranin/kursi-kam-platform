-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after the other setup files. If you paste the agreement
-- files again later, paste this one once more at the end.
--
-- A KAM fills in what the client sells and what the client gets.
-- Only one amount is required. The other amount stays empty.
-- The rate the client is asking, and a comment, are optional.
-- Old requests are left as they are: their amount stays the sell side.
-- Other, on Follow-ups, can carry words the KAM types.


alter table public.requests add column if not exists gets_amount numeric(18,2);
alter table public.requests add column if not exists client_rate numeric(18,6);
alter table public.requests add column if not exists loss_reason_note text;

comment on column public.requests.amount is
  'Amount the client sells. Empty when the KAM filled only the amount the client gets.';
comment on column public.requests.gets_amount is
  'Amount the client gets. Empty when the KAM filled only the amount the client sells.';
comment on column public.requests.client_rate is
  'The rate the client is asking, when they named one. Empty when they did not.';
comment on column public.requests.note is
  'Optional comment from the KAM for treasury.';
comment on column public.requests.loss_reason_note is
  'What the KAM typed next to Other. Empty for every listed reason.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'requests_gets_amount_positive') then
    alter table public.requests
      add constraint requests_gets_amount_positive check (gets_amount is null or gets_amount > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_client_rate_positive') then
    alter table public.requests
      add constraint requests_client_rate_positive check (client_rate is null or client_rate > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'requests_loss_reason_note_len') then
    alter table public.requests
      add constraint requests_loss_reason_note_len check (loss_reason_note is null or length(loss_reason_note) <= 500);
  end if;
end $$;

alter table public.requests drop constraint if exists requests_app_rows_complete;
alter table public.requests add constraint requests_app_rows_complete check (
  source = 'import'
  or (
    sells_currency is not null
    and gets_currency is not null
    and (amount is not null or gets_amount is not null)
  )
);

-- Outcomes view: same columns as before, then the new ones.
-- Keeps the agreement-file rules (went through / lost / still open).
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
  r.loss_reason_note
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
-- KAM: ask for a rate. One amount is enough.
-- ---------------------------------------------------------------------
drop function if exists public.log_request(text, text, text, numeric, numeric, text, text);
drop function if exists public.log_request(text, text, text, numeric, text, text);

create or replace function public.log_request(
  p_client_id      text,
  p_sells_currency text,
  p_gets_currency  text,
  p_amount         numeric,
  p_note           text default null,
  p_client_name    text default null,
  p_gets_amount    numeric default null,
  p_client_rate    numeric default null
)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me         uuid := private.my_profile_id();
  v_id         text := private.normalize_client_id(p_client_id);
  v_sells      text := upper(trim(coalesce(p_sells_currency, '')));
  v_gets       text := upper(trim(coalesce(p_gets_currency, '')));
  v_sell_amt   numeric := case when p_amount is null then null else round(p_amount, 2) end;
  v_gets_amt   numeric := case when p_gets_amount is null then null else round(p_gets_amount, 2) end;
  v_new        boolean;
  v_request_id bigint;
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot ask for rates' using errcode = '42501';
  end if;
  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    raise exception 'Check the ID: companies have 9 digits, people 11' using errcode = '22023';
  end if;
  if v_sells !~ '^[A-Z]{3}$' or v_gets !~ '^[A-Z]{3}$' or v_sells = v_gets then
    raise exception 'Choose two different currencies' using errcode = '22023';
  end if;
  if p_amount is not null and coalesce(v_sell_amt, 0) <= 0 then
    raise exception 'Enter a valid amount, or leave that side blank' using errcode = '22023';
  end if;
  if p_gets_amount is not null and coalesce(v_gets_amt, 0) <= 0 then
    raise exception 'Enter a valid amount, or leave that side blank' using errcode = '22023';
  end if;
  if coalesce(v_sell_amt, 0) <= 0 and coalesce(v_gets_amt, 0) <= 0 then
    raise exception 'Enter an amount on one side' using errcode = '22023';
  end if;
  if p_client_rate is not null and p_client_rate <= 0 then
    raise exception 'Enter the rate the client is asking, or leave it blank' using errcode = '22023';
  end if;
  if length(coalesce(trim(p_note), '')) > 500 then
    raise exception 'The comment is too long' using errcode = '22023';
  end if;
  if not exists (select 1 from public.clients c where c.client_id = v_id and c.name is not null)
     and length(coalesce(trim(p_client_name), '')) < 2 then
    raise exception 'New client: enter the client''s name' using errcode = '22023';
  end if;

  insert into public.clients (client_id, name, created_by)
  values (v_id, nullif(trim(p_client_name), ''), v_me)
  on conflict (client_id) do nothing;
  v_new := found;

  if not v_new and nullif(trim(p_client_name), '') is not null then
    update public.clients c set name = trim(p_client_name)
    where c.client_id = v_id and c.name is null;
  end if;

  if v_new then
    insert into private.backfill_queue (client_id) values (v_id)
    on conflict (client_id) do update set done_at = null, queued_at = now();
  end if;

  insert into public.requests (
    kam_id, client_id, sells_currency, gets_currency, amount, gets_amount, client_rate, note
  )
  values (
    v_me, v_id, v_sells, v_gets,
    v_sell_amt, v_gets_amt,
    case when p_client_rate is null then null else round(p_client_rate, 6) end,
    nullif(trim(p_note), '')
  )
  returning id into v_request_id;

  return v_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Reason a request did not go through. Other can carry typed words.
-- ---------------------------------------------------------------------
drop function if exists public.set_loss_reason(bigint, text);

create or replace function public.set_loss_reason(
  p_request_id bigint,
  p_reason     text,
  p_detail     text default null
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me      uuid := private.my_profile_id();
  v_row     public.request_outcomes%rowtype;
  v_other   boolean := false;
  v_detail  text := nullif(trim(p_detail), '');
begin
  if v_me is null or not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;
  select * into v_row from public.request_outcomes o where o.id = p_request_id;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_row.kam_id <> v_me and not private.is_admin() then
    raise exception 'This request belongs to another KAM' using errcode = '42501';
  end if;
  if v_row.outcome <> 'did_not_go_through' then
    raise exception 'Only requests that did not go through need a reason' using errcode = '22023';
  end if;
  if p_reason is not null and not exists (
    select 1 from public.loss_reasons l where l.code = p_reason and l.active
  ) then
    raise exception 'Unknown reason' using errcode = '22023';
  end if;
  if length(coalesce(v_detail, '')) > 500 then
    raise exception 'The reason is too long' using errcode = '22023';
  end if;

  if p_reason is not null then
    select p_reason = 'other' or lower(trim(l.label_en)) = 'other'
      into v_other
    from public.loss_reasons l
    where l.code = p_reason;
  end if;

  update public.requests r
     set loss_reason = p_reason,
         loss_reason_at = case when p_reason is null then null else now() end,
         loss_reason_note = case when v_other then v_detail else null end
   where r.id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Treasury queue and today's quotes, with both sides
-- ---------------------------------------------------------------------
drop function if exists public.treasury_queue();
create or replace function public.treasury_queue()
returns table (
  request_id       bigint,
  asked_at         timestamptz,
  waiting_seconds  int,
  kam_name         text,
  client_id        text,
  client_name      text,
  client_kind      text,
  is_new_client    boolean,
  sells_currency   text,
  gets_currency    text,
  amount           numeric,
  note             text,
  last_rate        numeric,
  last_rate_at     timestamptz,
  standard_rate    numeric,
  nbg_rate         numeric,
  last_given_today numeric,
  gets_amount      numeric,
  client_rate      numeric,
  loss_reason_note text
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can see the rate queue' using errcode = '42501';
  end if;
  return query
  select r.id,
         r.asked_at,
         extract(epoch from now() - r.asked_at)::int,
         p.full_name,
         r.client_id,
         c.name,
         c.kind,
         not exists (select 1 from public.requests r2 where r2.client_id = r.client_id and r2.id <> r.id),
         r.sells_currency,
         r.gets_currency,
         r.amount,
         r.note,
         lq.rate,
         lq.created_at,
         private.standard_rate_for(r.sells_currency, r.gets_currency),
         private.nbg_rate_for(r.sells_currency, r.gets_currency),
         lt.rate,
         r.gets_amount,
         r.client_rate,
         r.loss_reason_note
  from public.requests r
  join public.clients c  on c.client_id = r.client_id
  join public.profiles p on p.id = r.kam_id
  left join lateral (
    select q.rate, q.created_at
    from public.quotes q
    join public.requests r3 on r3.id = q.request_id
    where r3.client_id = r.client_id
      and r3.sells_currency = r.sells_currency
      and r3.gets_currency = r.gets_currency
      and q.action = 'quoted'
    order by q.created_at desc
    limit 1
  ) lq on true
  left join lateral (
    select q.rate
    from public.quotes q
    join public.requests r4 on r4.id = q.request_id
    where r4.sells_currency = r.sells_currency
      and r4.gets_currency = r.gets_currency
      and q.action = 'quoted'
      and (q.created_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
    order by q.created_at desc
    limit 1
  ) lt on true
  where r.quote_status = 'asking'
  order by r.asked_at;
end;
$$;

drop function if exists public.treasury_quotes_today();
create or replace function public.treasury_quotes_today()
returns table (
  request_id       bigint,
  client_name      text,
  kam_name         text,
  sells_currency   text,
  gets_currency    text,
  amount           numeric,
  rate             numeric,
  quoted_at        timestamptz,
  valid_until      timestamptz,
  quote_state      text,
  went_through     boolean,
  gets_amount      numeric,
  client_rate      numeric,
  note             text,
  loss_reason_note text
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can see quotes' using errcode = '42501';
  end if;
  return query
  select o.id, o.client_name, o.kam_name, o.sells_currency, o.gets_currency, o.amount,
         o.rate, o.quoted_at, o.rate_valid_until, o.quote_state, o.went_through,
         o.gets_amount, o.client_rate, o.note, o.loss_reason_note
  from public.request_outcomes o
  where o.quote_status = 'quoted'
    and o.source = 'app'
    and (o.quoted_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
  order by o.quoted_at desc;
end;
$$;

-- Messages to treasury name both sides, the asked rate, and the comment
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
    'asked_at',       r.asked_at
  )
  from public.requests r
  join public.profiles p on p.id = r.kam_id
  left join public.clients c on c.client_id = r.client_id
  where r.id = p_request_id
$$;

create or replace function private.notify_request_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  f          jsonb;
  v_extra_en text;
  v_extra_ka text;
begin
  begin
    if new.source <> 'app' then
      return null;
    end if;
    f := private.request_facts(new.id);
    v_extra_en :=
      case when coalesce(f->>'client_rate_text', '') = '' then ''
           else ' Rate the client is asking: ' || (f->>'client_rate_text') || '.' end
      || coalesce(' Comment: ' || nullif(f->>'note', ''), '');
    v_extra_ka :=
      case when coalesce(f->>'client_rate_text', '') = '' then ''
           else ' კლიენტის მოთხოვნილი კურსი: ' || (f->>'client_rate_text') || '.' end
      || coalesce(' კომენტარი: ' || nullif(f->>'note', ''), '');

    if tg_op = 'INSERT' then
      perform private.emit('request.new', new.id, new.kam_id,
        format('New rate request from %s: %s. Client sells %s. Client gets %s.%s',
               f->>'kam_name', f->>'client_name', f->>'sells_text', f->>'gets_text', v_extra_en),
        format('ახალი მოთხოვნა კურსზე, %s: %s. კლიენტი ყიდის %s. კლიენტი იღებს %s.%s',
               f->>'kam_name', f->>'client_name', f->>'sells_text', f->>'gets_text', v_extra_ka),
        f);

    elsif old.quote_status = 'asking' and new.quote_status = 'quoted' then
      perform private.emit('rate.ready', new.id, new.kam_id,
        format('Rate for %s: %s. Client sells %s. Client gets %s. Valid until %s.',
               f->>'client_name', f->>'rate_text', f->>'sells_text', f->>'gets_text', f->>'valid_until_text'),
        format('%s-ის კურსი: %s. კლიენტი ყიდის %s. კლიენტი იღებს %s. მოქმედებს %s-მდე.',
               f->>'client_name', f->>'rate_text', f->>'sells_text', f->>'gets_text', f->>'valid_until_text'),
        f);

    elsif old.quote_status = 'asking' and new.quote_status = 'declined' then
      perform private.emit('request.sent_back', new.id, new.kam_id,
        format('Treasury sent back %s (client sells %s, client gets %s): %s',
               f->>'client_name', f->>'sells_text', f->>'gets_text', f->>'decline_reason'),
        format('სახაზინო სამსახურმა დააბრუნა მოთხოვნა: %s (კლიენტი ყიდის %s, იღებს %s). მიზეზი: %s',
               f->>'client_name', f->>'sells_text', f->>'gets_text', f->>'decline_reason'),
        f);

    elsif old.quote_status in ('quoted', 'declined') and new.quote_status = 'asking' then
      perform private.emit('request.asked_again', new.id, new.kam_id,
        format('%s asks again: %s. Client sells %s. Client gets %s.%s',
               f->>'kam_name', f->>'client_name', f->>'sells_text', f->>'gets_text', v_extra_en),
        format('ხელახალი მოთხოვნა, %s: %s. კლიენტი ყიდის %s. კლიენტი იღებს %s.%s',
               f->>'kam_name', f->>'client_name', f->>'sells_text', f->>'gets_text', v_extra_ka),
        f);
    end if;
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

revoke execute on function
  public.log_request(text, text, text, numeric, text, text, numeric, numeric),
  public.set_loss_reason(bigint, text, text),
  public.treasury_queue(),
  public.treasury_quotes_today()
from public, anon;

grant execute on function
  public.log_request(text, text, text, numeric, text, text, numeric, numeric),
  public.set_loss_reason(bigint, text, text),
  public.treasury_queue(),
  public.treasury_quotes_today()
to authenticated;
