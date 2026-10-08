-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 16_client_history.sql. Do not re-run 1_platform.sql.
-- If you paste 3_analytics.sql or 16_client_history.sql again, paste this
-- file once more. Otherwise a file with no transaction id is rejected,
-- and a same-day payment would mark every request that day as done.
--
-- Some exports have no transaction id. Those rows are stored with tx_id
-- empty. Nothing here invents an id. A row is attached to a request only
-- when all of these are true, and only one request fits:
--   same client (sender id)
--   same calendar day (the file has a date and no clock time)
--   same currencies (currency is what the client sells, currency to send
--     is what the client gets)
--   the same lari amount, to the cent:
--     abs_gel when one side is GEL, otherwise cross_gel
--     compared with the request's lari figure (the typed lari amount,
--     or the sell amount when the client sells GEL, or the amount the
--     client gets when that side is GEL, or the lari value the app
--     already calculates from the rate)
-- If two requests share that amount, or two payments fit one request,
-- the row stays unattached. total_income is the fee, not the deal amount.
-- A file that does have a transaction id still updates that row.
-- Uploading the same days again replaces the rows that have no id, so
-- turnover is not counted twice. ClickHouse sync is unchanged.

-- tx_id stays unique for real ids. Rows with no id need their own key
-- so the table can hold them. That key is not a transaction id.
alter table public.transactions add column if not exists sells_currency text;
alter table public.transactions add column if not exists gets_currency text;
alter table public.transactions add column if not exists import_run bigint;
alter table public.transactions add column if not exists matched_request_id bigint;

do $transactions_without_tx_id$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) ilike '%tx_id%'
  ) then
    alter table public.transactions drop constraint transactions_pkey;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transactions'
      and column_name = 'id'
  ) then
    alter table public.transactions
      add column id bigint generated always as identity;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and contype = 'p'
  ) then
    alter table public.transactions
      add constraint transactions_pkey primary key (id);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transactions'
      and column_name = 'tx_id'
      and is_nullable = 'NO'
  ) then
    alter table public.transactions alter column tx_id drop not null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and conname = 'transactions_tx_id_key'
  ) then
    alter table public.transactions
      add constraint transactions_tx_id_key unique (tx_id);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and conname = 'transactions_matched_request_fkey'
  ) then
    alter table public.transactions
      add constraint transactions_matched_request_fkey
      foreign key (matched_request_id) references public.requests (id) on delete set null;
  end if;
end
$transactions_without_tx_id$;

create unique index if not exists transactions_one_match_idx
  on public.transactions (matched_request_id)
  where matched_request_id is not null;

create index if not exists transactions_amount_import_idx
  on public.transactions (import_run, client_id, tx_date)
  where tx_id is null;

comment on column public.transactions.tx_id is
  'Bank transaction id when the file or the sync has one. Empty when the uploaded file had no transaction id. Those rows are not given an invented id.';
comment on column public.transactions.id is
  'Internal row key. Not a transaction id.';
comment on column public.transactions.matched_request_id is
  'Set only when one payment and one request share the client, the day, the currencies, and the exact lari amount. Empty when that is not unique.';

-- A payment with no transaction id must not mark every request that day as done.
-- Only a real transaction id keeps the old same-day rule. An amount match
-- counts only for the one request it was attached to.

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
  (w.rate_written or w.tx_hit or w.file_won) as went_through,
  case
    when w.rate_written or w.tx_hit or w.file_won then 'went_through'
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
  r.better_decided_at,
  case
    when r.banks is not null and cardinality(r.banks) > 0 then (
      select string_agg(x, ', ' order by array_position(array['TBC', 'BOG', 'Liberty']::text[], x))
      from (
        select distinct btrim(u.x) as x
        from unnest(r.banks) as u(x)
      ) s
      where x in ('TBC', 'BOG', 'Liberty')
    )
    else r.bank
  end as bank
from public.requests r
join public.clients c on c.client_id = r.client_id
left join public.profiles p on p.id = r.kam_id
cross join lateral (
  select
    (r.rate_written_at is not null) as rate_written,
    exists (
      select 1
      from public.transactions t
      where t.payment_status = 'SUCCESS'
        and (
          (
            t.tx_id is not null
            and t.client_id = r.client_id
            and t.tx_date = r.request_date
            and (r.source = 'import' or t.tx_time >= r.requested_at - interval '1 minute')
          )
          or t.matched_request_id = r.id
        )
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

create or replace function public.client_request_history(
  p_client_id text,
  p_exclude_id bigint default null
)
returns table (
  id              bigint,
  request_date    date,
  requested_at    timestamptz,
  kam_name        text,
  sells_currency  text,
  gets_currency   text,
  amount          numeric,
  gets_amount     numeric,
  rate            numeric,
  outcome         text,
  bank            text,
  total_count     bigint
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me uuid := private.my_profile_id();
  v_id text := private.normalize_client_id(p_client_id);
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    return;
  end if;

  return query
  with matched as (
    select
      r.id,
      r.request_date,
      r.requested_at,
      p.full_name as kam_name,
      r.sells_currency,
      r.gets_currency,
      r.amount,
      r.gets_amount,
      case
        when r.client_reply = 'approved' and r.approved_rate > 0 then r.approved_rate
        when r.rate > 0 then r.rate
        else null
      end as rate,
      case
        when w.rate_written or w.tx_hit or w.file_won then 'went_through'
        when w.file_lost then 'did_not_go_through'
        when w.file_open then 'waiting'
        when r.request_date >= coalesce(private.freshness_date(), r.request_date) then 'waiting'
        else 'did_not_go_through'
      end as outcome,
      case
        when r.banks is not null and cardinality(r.banks) > 0 then (
          select string_agg(x, ', ' order by array_position(array['TBC', 'BOG', 'Liberty']::text[], x))
          from (
            select distinct btrim(u.x) as x
            from unnest(r.banks) as u(x)
          ) s
          where x in ('TBC', 'BOG', 'Liberty')
        )
        else r.bank
      end as bank
    from public.requests r
    left join public.profiles p on p.id = r.kam_id
    cross join lateral (
      select
        (r.rate_written_at is not null) as rate_written,
        exists (
          select 1
          from public.transactions t
          where t.payment_status = 'SUCCESS'
            and (
              (
                t.tx_id is not null
                and t.client_id = r.client_id
                and t.tx_date = r.request_date
                and (r.source = 'import' or t.tx_time >= r.requested_at - interval '1 minute')
              )
              or t.matched_request_id = r.id
            )
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
    ) w
    where r.client_id = v_id
      and r.request_date >= (private.tbilisi_today() - interval '6 months')::date
      and (p_exclude_id is null or r.id <> p_exclude_id)
      and (
        r.source = 'app'
        or r.import_key like 'agreement:%'
      )
  )
  select
    m.id,
    m.request_date,
    m.requested_at,
    m.kam_name,
    m.sells_currency,
    m.gets_currency,
    m.amount,
    m.gets_amount,
    m.rate,
    m.outcome,
    m.bank,
    count(*) over ()::bigint as total_count
  from matched m
  order by m.requested_at desc, m.id desc
  limit 50;
end;
$$;

comment on function public.client_request_history(text, bigint) is
  'One client, last 6 months in Tbilisi, every KAM. Agreement-file rows and requests typed in the app. At most 50, newest first. A written rate is went_through. Does not list any other client.';

revoke execute on function public.client_request_history(text, bigint) from public, anon;
grant execute on function public.client_request_history(text, bigint) to authenticated;

-- Analyst list. Same columns as 14_analyst.sql, including the stored lari
-- figure. Create or replace cannot insert or rename a column, so drop
-- the old list first.
drop view if exists public.analyst_deals;
create or replace view public.analyst_deals
with (security_invoker = false, security_barrier = true)
as
select
  d.id,
  d.request_date,
  d.kam_name,
  d.client_id,
  d.client_name,
  d.sells_currency,
  d.sell_amount,
  d.gets_currency,
  d.gets_amount,
  d.rate,
  d.amount_gel,
  d.gel_amount,
  d.status,
  case when d.status = 'lost' or d.rate_written then d.reason else null end as loss_reason,
  d.first_response_minutes,
  d.rate_write_minutes,
  d.quoted_by_name
from (
  select
    r.id,
    r.request_date,
    p.full_name as kam_name,
    r.client_id,
    c.name as client_name,
    r.sells_currency,
    r.amount as sell_amount,
    r.gets_currency,
    r.gets_amount,
    coalesce(r.approved_rate, r.rate) as rate,
    coalesce(
      r.gel_amount,
      private.request_gel(
        r.sells_currency, r.gets_currency, r.amount, r.gets_amount, coalesce(r.approved_rate, r.rate)
      )
    ) as amount_gel,
    r.gel_amount,
    (r.rate_written_at is not null) as rate_written,
    case
      when r.rate_written_at is not null then 'success'
      when w.tx_hit or w.file_won then 'success'
      when w.file_lost then 'lost'
      when w.file_open then 'open'
      when r.request_date >= coalesce(private.freshness_date(), r.request_date) then 'open'
      else 'lost'
    end as status,
    nullif(concat_ws(
      '. ',
      nullif(btrim(coalesce(lr.label_ka, r.legacy_loss_reason)), ''),
      nullif(btrim(r.loss_reason_note), ''),
      nullif(btrim(r.client_decline_reason), ''),
      nullif(btrim(r.decline_reason), '')
    ), '') as reason,
    private.first_response_minutes(r.id, r.asked_at, r.requested_at, r.quoted_at, r.source) as first_response_minutes,
    private.rate_write_minutes(r.client_reply, r.client_replied_at, r.rate_written_at, r.source) as rate_write_minutes,
    nullif(btrim(qb.full_name), '') as quoted_by_name
  from public.requests r
  join public.clients c on c.client_id = r.client_id
  left join public.profiles p on p.id = r.kam_id
  -- The view owner reads the name, so an analyst needs no grant on profiles.
  left join public.profiles qb on qb.id = r.quoted_by
  left join public.loss_reasons lr on lr.code = r.loss_reason
  cross join lateral (
    select
      exists (
        select 1
        from public.transactions t
        where t.payment_status = 'SUCCESS'
          and (
            (
              t.tx_id is not null
              and t.client_id = r.client_id
              and t.tx_date = r.request_date
              and (r.source = 'import' or t.tx_time >= r.requested_at - interval '1 minute')
            )
            or t.matched_request_id = r.id
          )
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
  ) w
) d
where private.my_role() in ('analyst', 'admin');

comment on view public.analyst_deals is
  'Every request for an analyst or an admin. Dates, both amounts, the lari value, success or lost, the reason, the treasury person who quoted (empty until someone quotes), the client id in its own column, and the two treasury times in minutes. A written rate is success even when a loss reason is still shown. An admin corrects a row with admin_correct_request. An analyst cannot change a row.';

revoke all on public.analyst_deals from public, anon;
grant select on public.analyst_deals to authenticated;


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


-- A row with no transaction id is not a same-day hit for every request.
-- The amount match notifies only the one request it was attached to.
create or replace function private.notify_transaction()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  r  record;
  f  jsonb;
begin
  begin
    if new.payment_status <> 'SUCCESS' or new.tx_id is null then
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

-- Parsed upload rows. No id is invented: tx_id stays empty when the file had none.
create or replace function private.clean_import_rows(p_rows jsonb)
returns table (
  tx_id text,
  tx_date date,
  client_id text,
  client_name text,
  segment text,
  operation_type text,
  payment_status text,
  abs_gel numeric,
  cross_gel numeric,
  total_income numeric,
  spread_income numeric,
  revaluation numeric,
  sells_currency text,
  gets_currency text
)
language sql stable set search_path = ''
as $$
  select nullif(trim(x.tx_id), ''),
         case when x.tx_date ~ '^\d{4}-\d{2}-\d{2}$' then x.tx_date::date end,
         private.normalize_client_id(x.client_id),
         nullif(left(btrim(coalesce(x.client_name, '')), 200), ''),
         nullif(btrim(x.segment), ''),
         nullif(btrim(x.operation_type), ''),
         upper(nullif(btrim(x.payment_status), '')),
         round(coalesce(x.abs_gel, 0), 2),
         round(coalesce(x.cross_gel, 0), 2),
         round(coalesce(x.total_income, 0), 2),
         round(x.spread_income, 2),
         round(x.revaluation, 2),
         case when upper(btrim(coalesce(x.sells_currency, ''))) ~ '^[A-Z]{3}$'
              then upper(btrim(x.sells_currency)) end,
         case when upper(btrim(coalesce(x.gets_currency, ''))) ~ '^[A-Z]{3}$'
              then upper(btrim(x.gets_currency)) end
  from jsonb_to_recordset(p_rows) as x(
    tx_id text, tx_date text, client_id text, client_name text,
    segment text, operation_type text, payment_status text,
    abs_gel numeric, cross_gel numeric, total_income numeric,
    spread_income numeric, revaluation numeric,
    sells_currency text, gets_currency text
  )
$$;

revoke all on function private.clean_import_rows(jsonb) from public, anon, authenticated;

-- Drop the one-argument form so PostgREST does not see two uploads.
drop function if exists public.import_transactions(jsonb);
drop function if exists public.import_transactions(jsonb, bigint, boolean);

-- Rows from the Excel or CSV. Admins only. A real transaction id updates
-- that row. A file with no transaction id is stored without one and then
-- matched to requests by the exact lari amount. p_finish runs that match
-- after the last batch. At most 1000 rows per call.
create or replace function public.import_transactions(
  p_rows jsonb,
  p_run bigint default null,
  p_finish boolean default false
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_run        bigint;
  v_before     bigint;
  v_after      bigint;
  v_upserted   int := 0;
  v_skipped    int := 0;
  v_clients    int := 0;
  v_matched    int := 0;
  v_ambiguous  int := 0;
  v_touch      int := 0;
  v_amount     boolean;
  r            record;
  f            jsonb;
begin
  if not private.is_admin() then
    raise exception 'Only admins can upload transactions' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Expected a list of transactions';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'Send at most 1000 transactions at a time';
  end if;

  v_amount := not exists (
    select 1 from private.clean_import_rows(p_rows) c where c.tx_id is not null
  );

  if v_amount and p_finish and p_run is null then
    raise exception 'Upload run not found';
  end if;

  if v_amount and p_run is not null then
    select s.id into v_run
    from private.sync_runs s
    where s.id = p_run and s.kind = 'upload';
    if v_run is null then
      raise exception 'Upload run not found';
    end if;
  elsif not (v_amount and jsonb_array_length(p_rows) = 0) then
    insert into private.sync_runs (kind) values ('upload') returning id into v_run;
  end if;

  if jsonb_array_length(p_rows) > 0 then
    select count(*) into v_before from public.clients;

    if v_amount then
      with good as (
        select c.*
        from private.clean_import_rows(p_rows) c
        where c.tx_id is null
          and c.tx_date is not null
          and c.client_id <> ''
          and c.payment_status is not null
          and lower(coalesce(c.operation_type, '')) not in
              ('position-close-in-bank', 'fastoo', 'bitnet', 'unipay')
      ),
      added as (
        insert into public.clients as cl (client_id, name)
        select distinct on (g.client_id) g.client_id, g.client_name
        from good g
        where g.client_id ~ '^([0-9]{9}|[0-9]{11})$'
        order by g.client_id, g.client_name nulls last
        on conflict (client_id) do update
          set name = coalesce(cl.name, excluded.name)
        returning 1
      ),
      saved as (
        insert into public.transactions (
          tx_id, tx_time, tx_date, client_id, segment, operation_type, payment_status,
          abs_gel, cross_gel, total_income, spread_income, revaluation, synced_at,
          sells_currency, gets_currency, import_run
        )
        select null,
               (g.tx_date + time '12:00') at time zone 'Asia/Tbilisi',
               g.tx_date, g.client_id, g.segment, g.operation_type, g.payment_status,
               g.abs_gel, g.cross_gel, g.total_income, g.spread_income, g.revaluation, now(),
               g.sells_currency, g.gets_currency, v_run
        from good g
        returning 1
      )
      select (select count(*) from saved),
             (select count(*) from private.clean_import_rows(p_rows)) - (select count(*) from good),
             (select count(*) from added)
        into v_upserted, v_skipped, v_touch;
    else
      with good as (
        select distinct on (c.tx_id) c.*
        from private.clean_import_rows(p_rows) c
        where c.tx_id is not null
          and c.tx_date is not null
          and c.client_id <> ''
          and c.payment_status is not null
          and lower(coalesce(c.operation_type, '')) not in
              ('position-close-in-bank', 'fastoo', 'bitnet', 'unipay')
        order by c.tx_id
      ),
      added as (
        insert into public.clients as cl (client_id, name)
        select distinct on (g.client_id) g.client_id, g.client_name
        from good g
        where g.client_id ~ '^([0-9]{9}|[0-9]{11})$'
        order by g.client_id, g.client_name nulls last
        on conflict (client_id) do update
          set name = coalesce(cl.name, excluded.name)
        returning 1
      ),
      saved as (
        insert into public.transactions as t (
          tx_id, tx_time, tx_date, client_id, segment, operation_type, payment_status,
          abs_gel, cross_gel, total_income, spread_income, revaluation, synced_at,
          sells_currency, gets_currency
        )
        select g.tx_id,
               (g.tx_date + time '12:00') at time zone 'Asia/Tbilisi',
               g.tx_date, g.client_id, g.segment, g.operation_type, g.payment_status,
               g.abs_gel, g.cross_gel, g.total_income, g.spread_income, g.revaluation, now(),
               g.sells_currency, g.gets_currency
        from good g
        on conflict (tx_id) do update set
          tx_time = excluded.tx_time,
          tx_date = excluded.tx_date,
          client_id = excluded.client_id,
          segment = excluded.segment,
          operation_type = excluded.operation_type,
          payment_status = excluded.payment_status,
          abs_gel = excluded.abs_gel,
          cross_gel = excluded.cross_gel,
          total_income = excluded.total_income,
          spread_income = excluded.spread_income,
          revaluation = excluded.revaluation,
          synced_at = now(),
          sells_currency = coalesce(excluded.sells_currency, t.sells_currency),
          gets_currency = coalesce(excluded.gets_currency, t.gets_currency)
        returning 1
      )
      select (select count(*) from saved),
             (select count(*) from private.clean_import_rows(p_rows)) - (select count(*) from good),
             (select count(*) from added)
        into v_upserted, v_skipped, v_touch;
    end if;

    select count(*) into v_after from public.clients;
    v_clients := v_after - v_before;
  end if;

  if v_amount and p_finish then
    delete from public.transactions prev
    where prev.tx_id is null
      and prev.import_run is distinct from v_run
      and prev.tx_date in (
        select n.tx_date
        from public.transactions n
        where n.import_run = v_run and n.tx_id is null
      );

    update public.transactions pay
       set matched_request_id = null
     where pay.import_run = v_run
       and pay.tx_id is null
       and pay.matched_request_id is not null;

    with pays as (
      select t.id,
             t.client_id,
             t.tx_date,
             t.sells_currency,
             t.gets_currency,
             case
               when t.sells_currency = 'GEL' or t.gets_currency = 'GEL' then
                 case when t.abs_gel > 0 and t.cross_gel = 0 then round(t.abs_gel, 2) end
               when t.sells_currency is not null and t.gets_currency is not null then
                 case when t.cross_gel > 0 and t.abs_gel = 0 then round(t.cross_gel, 2) end
             end as file_gel
      from public.transactions t
      where t.import_run = v_run
        and t.tx_id is null
        and t.payment_status = 'SUCCESS'
    ),
    pairs as (
      select p.id as pay_id, rq.id as request_id
      from pays p
      join public.requests rq
        on rq.client_id = p.client_id
       and rq.request_date = p.tx_date
       and upper(rq.sells_currency) = p.sells_currency
       and upper(rq.gets_currency) = p.gets_currency
       and round(coalesce(
             rq.gel_amount,
             private.request_gel(
               rq.sells_currency, rq.gets_currency, rq.amount, rq.gets_amount,
               coalesce(rq.approved_rate, rq.rate)
             )
           ), 2) = p.file_gel
      where p.file_gel is not null
        and p.sells_currency is not null
        and p.gets_currency is not null
    ),
    pay_n as (
      select pay_id, count(*) as n from pairs group by pay_id
    ),
    req_n as (
      select request_id, count(*) as n from pairs group by request_id
    ),
    unique_pairs as (
      select p.pay_id, p.request_id
      from pairs p
      join pay_n pn on pn.pay_id = p.pay_id and pn.n = 1
      join req_n rn on rn.request_id = p.request_id and rn.n = 1
    ),
    ambiguous_pays as (
      select distinct p.pay_id
      from pairs p
      join pay_n pn on pn.pay_id = p.pay_id
      join req_n rn on rn.request_id = p.request_id
      where pn.n > 1 or rn.n > 1
    ),
    updated as (
      update public.transactions t
         set matched_request_id = u.request_id
        from unique_pairs u
       where t.id = u.pay_id
         and t.import_run = v_run
         and t.tx_id is null
      returning t.id
    )
    select (select count(*) from updated),
           (select count(*) from ambiguous_pays)
      into v_matched, v_ambiguous;

    begin
      for r in
        select q.id, q.kam_id
        from public.requests q
        join public.transactions pay on pay.matched_request_id = q.id
        where pay.import_run = v_run
          and pay.tx_id is null
          and pay.payment_status = 'SUCCESS'
          and q.quote_status = 'quoted'
          and q.source = 'app'
      loop
        f := private.request_facts(r.id);
        perform private.emit_once(
          'went:' || r.id, 'request.went_through', r.id, r.kam_id,
          format('%s''s transaction arrived: the request at %s went through.', f->>'client_name', f->>'rate_text'),
          format('%s-ის ტრანზაქცია შემოვიდა: მოთხოვნა %s კურსით შესრულდა.', f->>'client_name', f->>'rate_text'),
          f
        );
      end loop;
    exception when others then
      raise warning 'notification skipped: %', sqlerrm;
    end;
  end if;

  if v_run is not null then
    if v_amount and not p_finish then
      update private.sync_runs
         set rows_upserted = coalesce(rows_upserted, 0) + v_upserted
       where id = v_run;
    else
      update private.sync_runs
         set finished_at = now(),
             ok = true,
             rows_upserted = coalesce(rows_upserted, 0) + v_upserted
       where id = v_run;
    end if;
  end if;

  return jsonb_build_object(
    'upserted', v_upserted,
    'skipped', v_skipped,
    'clients_added', v_clients,
    'run_id', case when v_amount then v_run end,
    'matched', v_matched,
    'ambiguous', v_ambiguous
  );
exception when others then
  if v_run is not null then
    update private.sync_runs
       set finished_at = now(), ok = false, error = sqlerrm
     where id = v_run;
  end if;
  raise;
end;
$$;

revoke execute on function public.import_transactions(jsonb, bigint, boolean) from public, anon;
grant execute on function public.import_transactions(jsonb, bigint, boolean) to authenticated;
