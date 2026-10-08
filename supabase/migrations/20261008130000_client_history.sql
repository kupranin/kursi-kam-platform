-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 14_analyst.sql. Do not re-run 1_platform.sql.
-- If you paste 8_agreement_requests_1_rules.sql, 10_request_sides.sql,
-- 11_client_reply.sql, 14_analyst.sql, or 4_company_search.sql again,
-- paste this file once more so the request still stores every bank,
-- client search still returns the banks already saved for that client,
-- and a written rate still counts as a success.
--
-- The request form and the rate desk read one client's last 6 months
-- from public.client_request_history. That function is security definer.
-- It checks the caller is an active signed-in profile, then returns only
-- that client's rows: every KAM, imported agreement rows (import_key
-- like agreement:%) and requests typed in the app, newest first, at most
-- 50. A written rate is went_through, same as the view below.
-- It does not open the rest of public.requests. requests_read is unchanged:
-- a KAM still cannot list every request. The view still uses the caller's
-- own rights, so treasury, an admin, and a manager read every request there.
-- The standard comparison is the latest Kursi board row already stored
-- in public.market_rates. Those same roles can already read it.
-- Nothing here sends a message.
--
-- A written rate counts as went through. The analyst list at the end of
-- this file uses the same rule. This file does not change the lari formula.
--
-- One request can use any combination of TBC, BOG, and Liberty, including
-- all three. At least one is required on a new request typed in the app.
-- Imported history can still have no bank. An older row that stored one
-- bank is copied into the set the first time this file runs.

alter table public.requests add column if not exists bank text;
alter table public.requests add column if not exists banks text[];
alter table public.clients add column if not exists banks text[];

-- The set lives in banks (text[]). requests.bank stays text: it is the
-- label older screens already read ("BOG" or "TBC, BOG").
-- If an older paste created banks as a single text column, 'BOG' is not a
-- valid array literal and reading it fails with malformed array literal.
-- Turn that text into {BOG} and only then change the type. A second paste
-- sees text[] and leaves the rows alone.
do $promote_bank_sets$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'requests'
      and column_name = 'banks'
      and data_type = 'text'
  ) then
    alter table public.requests drop constraint if exists requests_banks_ok;
    alter table public.requests
      alter column banks type text[]
      using (
        nullif(array(
          select cleaned
          from (
            select btrim(piece, ' "') as cleaned
            from unnest(string_to_array(
              case
                when banks is null or btrim(banks) = '' then null
                when left(btrim(banks), 1) = '{' then btrim(banks, '{}')
                else banks
              end,
              ','
            )) as piece
          ) s
          where cleaned in ('TBC', 'BOG', 'Liberty')
          order by array_position(array['TBC', 'BOG', 'Liberty']::text[], cleaned)
        ), '{}'::text[])
      );
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'clients'
      and column_name = 'banks'
      and data_type = 'text'
  ) then
    alter table public.clients drop constraint if exists clients_banks_ok;
    alter table public.clients
      alter column banks type text[]
      using (
        nullif(array(
          select cleaned
          from (
            select btrim(piece, ' "') as cleaned
            from unnest(string_to_array(
              case
                when banks is null or btrim(banks) = '' then null
                when left(btrim(banks), 1) = '{' then btrim(banks, '{}')
                else banks
              end,
              ','
            )) as piece
          ) s
          where cleaned in ('TBC', 'BOG', 'Liberty')
          order by array_position(array['TBC', 'BOG', 'Liberty']::text[], cleaned)
        ), '{}'::text[])
      );
  end if;
end
$promote_bank_sets$;

comment on column public.requests.bank is
  'Banks on this request, written as text for older screens: TBC, BOG, Liberty, or a comma-separated combination. Empty on imported history.';

comment on column public.requests.banks is
  'Banks this deal uses, in order TBC, BOG, Liberty. One, two, or all three. Empty on imported history and on requests made before this column.';

comment on column public.clients.banks is
  'Banks this client has used. A later request adds banks; it does not remove one already stored here.';

-- A second paste drops the check and adds the same one again.
-- NOT VALID does not scan existing rows, so this stays a short lock.
-- New inserts are still checked. One code, or "TBC, BOG, Liberty", is allowed.
alter table public.requests drop constraint if exists requests_bank_ok;
alter table public.requests
  add constraint requests_bank_ok
  check (
    bank is null
    or bank ~ '^(TBC|BOG|Liberty)(, (TBC|BOG|Liberty)){0,2}$'
  ) not valid;

alter table public.requests drop constraint if exists requests_banks_ok;
alter table public.requests
  add constraint requests_banks_ok
  check (
    banks is null
    or (
      cardinality(banks) between 1 and 3
      and banks <@ array['TBC', 'BOG', 'Liberty']::text[]
    )
  ) not valid;

alter table public.clients drop constraint if exists clients_banks_ok;
alter table public.clients
  add constraint clients_banks_ok
  check (
    banks is null
    or (
      cardinality(banks) between 1 and 3
      and banks <@ array['TBC', 'BOG', 'Liberty']::text[]
    )
  ) not valid;

-- Copy a single stored bank into the set. A second paste leaves rows that
-- already have a set alone, so it does not drop a bank.
update public.requests as r
set banks = parsed.banks
from (
  select
    req.id,
    (
      select array_agg(x order by array_position(array['TBC', 'BOG', 'Liberty']::text[], x))
      from (
        select distinct btrim(piece) as x
        from unnest(string_to_array(req.bank, ',')) as u(piece)
      ) s
      where x in ('TBC', 'BOG', 'Liberty')
    ) as banks
  from public.requests as req
  where req.banks is null
    and req.bank is not null
    and btrim(req.bank) <> ''
) as parsed
where r.id = parsed.id
  and parsed.banks is not null;

-- Outcomes view: same columns as 11_client_reply.sql, then the banks
-- for this request as one text value. The column stays text, so this
-- replace does not change the view's shape.
-- A written rate is a success: rate_written_at set (treasury pressed
-- კურსი გაწერილია) means went_through, even with no transaction and
-- even when a loss reason is saved later. A treasury or client decline
-- with no written rate stays not a success. Agreement-file rows marked
-- შესრულდა stay a success. Rows marked არ შესრულდა stay lost unless
-- the rate was written. Anything else still open stays waiting until a
-- payment judges it.
alter table public.requests add column if not exists rate_written_at timestamptz;

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

-- Return type gains the client's saved banks, so replace, do not alter in place.
do $drop_client_lookup$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('lookup_client', 'search_my_clients')
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end
$drop_client_lookup$;

create or replace function public.lookup_client(p_client_id text)
returns table (client_id text, valid boolean, known boolean, name text, kind text, banks text[])
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id text := private.normalize_client_id(p_client_id);
begin
  if private.my_profile_id() is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  return query
  select v_id,
         v_id ~ '^([0-9]{9}|[0-9]{11})$',
         c.client_id is not null,
         c.name,
         case when length(v_id) = 9 then 'company' when length(v_id) = 11 then 'person' end,
         c.banks
  from (select 1) d
  left join public.clients c on c.client_id = v_id;
end;
$$;

-- Same search as 4_company_search.sql, plus the banks saved on the client.
create or replace function public.search_my_clients(p_query text default '', p_limit int default 8)
returns table (
  client_id            text,
  name                 text,
  kind                 text,
  last_request_date    date,
  last_sells_currency  text,
  last_gets_currency   text,
  banks                text[]
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me     uuid := private.my_profile_id();
  v_all    boolean := private.can_see_all();
  v_q      text := trim(coalesce(p_query, ''));
  v_digits boolean;
  v_like   text;
  v_limit  int := least(greatest(coalesce(p_limit, 8), 1), 20);
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;

  v_digits := v_q ~ '^[0-9 ]+$';
  if v_digits then
    v_q := replace(v_q, ' ', '');
  end if;
  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  return query
  with pool as (
    select c.client_id, c.name, c.kind, c.banks
    from public.clients c
    where (v_q = '' and (
            v_all
         or c.assigned_kam_id = v_me
         or exists (select 1 from public.requests r where r.client_id = c.client_id and r.kam_id = v_me)
          ))
       or v_q <> ''
  ),
  last_req as (
    select distinct on (r.client_id)
           r.client_id, r.request_date, r.sells_currency, r.gets_currency, r.requested_at
    from public.requests r
    where r.client_id in (select p.client_id from pool p)
      and (v_all or r.kam_id = v_me)
    order by r.client_id, r.requested_at desc
  )
  select p.client_id, p.name, p.kind, lr.request_date, lr.sells_currency, lr.gets_currency, p.banks
  from pool p
  left join last_req lr on lr.client_id = p.client_id
  where v_q = ''
     or (v_digits and (p.client_id like v_like || '%' or p.client_id like '0' || v_like || '%'))
     or (not v_digits and p.name ilike '%' || v_like || '%')
  order by lr.requested_at desc nulls last, p.name
  limit v_limit;
end;
$$;

revoke execute on function public.lookup_client(text) from public, anon;
grant execute on function public.lookup_client(text) to authenticated;
revoke execute on function public.search_my_clients(text, int) from public, anon;
grant execute on function public.search_my_clients(text, int) to authenticated;

-- One client's requests for the last 6 months, every KAM.
-- The form and the desk call this. A KAM cannot read another KAM's rows
-- through request_outcomes, so this function reads the table itself and
-- returns only this client. Date, KAM name, both sides and amounts, the
-- rate, the outcome, and the banks. Nothing else about the request.
-- Imported agreement rows (import_key like agreement:%) and requests
-- typed in the app. A written rate is went_through, same rule as the view.
-- Today is Asia/Tbilisi. At most 50 rows, newest first. total_count is
-- how many matched before that cap. p_exclude_id leaves out the open
-- desk card. A second paste drops every older overload first.
do $drop_client_request_history$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'client_request_history'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end
$drop_client_request_history$;

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

-- A new request typed in the app must name at least one of TBC, BOG, Liberty.
-- p_bank is text[]. The app sends a JSON array: ["BOG"], or ["TBC","BOG"],
-- or ["TBC","BOG","Liberty"]. A bare string such as BOG is not an array
-- literal and Postgres rejects it. Older overloads are dropped below so
-- PostgREST finds this one. Imported rows are not inserted here.
do $drop_log_request$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'log_request'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end
$drop_log_request$;

create or replace function public.log_request(
  p_client_id      text,
  p_sells_currency text,
  p_gets_currency  text,
  p_amount         numeric,
  p_note           text default null,
  p_client_name    text default null,
  p_gets_amount    numeric default null,
  p_client_rate    numeric default null,
  p_bank           text[] default null
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
  v_banks      text[];
  v_saved      text[];
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
  -- New requests: GEL, USD, EUR, RUB, CNY. The column still allows any
  -- 3-letter code, so older GBP rows keep loading. This only blocks a new insert.
  if v_sells not in ('GEL', 'USD', 'EUR', 'RUB', 'CNY') or v_gets not in ('GEL', 'USD', 'EUR', 'RUB', 'CNY') then
    raise exception 'აირჩიეთ GEL, USD, EUR, RUB ან CNY' using errcode = '22023';
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
  if length(coalesce(trim(p_client_name), '')) > 200 then
    raise exception 'სახელი 200 სიმბოლოზე გრძელია' using errcode = '22023';
  end if;

  if p_bank is null or cardinality(p_bank) < 1 then
    raise exception 'აირჩიეთ ერთი ბანკი მაინც: TBC, BOG ან Liberty' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(p_bank) as u(x)
    where btrim(coalesce(x, '')) not in ('TBC', 'BOG', 'Liberty')
  ) then
    raise exception 'აირჩიეთ ბანკი: TBC, BOG ან Liberty' using errcode = '22023';
  end if;
  select coalesce(array_agg(x order by array_position(array['TBC', 'BOG', 'Liberty']::text[], x)), '{}'::text[])
    into v_banks
  from (
    select distinct btrim(x) as x
    from unnest(p_bank) as u(x)
  ) s
  where x in ('TBC', 'BOG', 'Liberty');
  if cardinality(v_banks) < 1 or cardinality(v_banks) > 3 then
    raise exception 'აირჩიეთ ბანკი: TBC, BOG ან Liberty' using errcode = '22023';
  end if;

  if not exists (select 1 from public.clients c where c.client_id = v_id and c.name is not null)
     and length(coalesce(trim(p_client_name), '')) < 2 then
    raise exception 'New client: enter the client''s name' using errcode = '22023';
  end if;

  insert into public.clients (client_id, name, created_by)
  values (v_id, nullif(trim(p_client_name), ''), v_me)
  on conflict (client_id) do nothing;
  v_new := found;

  -- Fill a missing name. Do not replace a name that is already stored.
  if not v_new and nullif(trim(p_client_name), '') is not null then
    update public.clients c set name = trim(p_client_name)
    where c.client_id = v_id and c.name is null;
  end if;

  -- Remember every bank this client has used. This request does not remove one.
  select c.banks into v_saved from public.clients c where c.client_id = v_id;
  update public.clients c
  set banks = (
    select coalesce(array_agg(x order by array_position(array['TBC', 'BOG', 'Liberty']::text[], x)), '{}'::text[])
    from (
      select distinct unnest(coalesce(v_saved, '{}'::text[]) || v_banks) as x
    ) u
    where x in ('TBC', 'BOG', 'Liberty')
  )
  where c.client_id = v_id;

  if v_new then
    insert into private.backfill_queue (client_id) values (v_id)
    on conflict (client_id) do update set done_at = null, queued_at = now();
  end if;

  insert into public.requests (
    kam_id, client_id, sells_currency, gets_currency, amount, gets_amount, client_rate, note, bank, banks
  )
  values (
    v_me, v_id, v_sells, v_gets,
    v_sell_amt, v_gets_amt,
    case when p_client_rate is null then null else round(p_client_rate, 6) end,
    nullif(trim(p_note), ''),
    array_to_string(v_banks, ', '),
    v_banks
  )
  returning id into v_request_id;

  return v_request_id;
end;
$$;

revoke execute on function public.log_request(text, text, text, numeric, text, text, numeric, numeric, text[]) from public, anon;
grant execute on function public.log_request(text, text, text, numeric, text, text, numeric, numeric, text[]) to authenticated;

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
  ) w
) d
where private.my_role() in ('analyst', 'admin');

comment on view public.analyst_deals is
  'Every request for an analyst or an admin. Dates, both amounts, the lari value, success or lost, the reason, the treasury person who quoted (empty until someone quotes), the client id in its own column, and the two treasury times in minutes. A written rate is success even when a loss reason is still shown. An admin corrects a row with admin_correct_request. An analyst cannot change a row.';

revoke all on public.analyst_deals from public, anon;
grant select on public.analyst_deals to authenticated;

-- Follow-ups win-back list. A client whose latest request has a written
-- rate has gone through, so they leave this list even with no transaction.
-- Same function as 8_agreement_requests_1_rules.sql, plus that one check.
create or replace function private.winback_for(p_kam uuid, p_all boolean)
returns table (
  client_id           text,
  client_name         text,
  client_kind         text,
  owner_id            uuid,
  owner_name          text,
  tier                text,
  last_request        date,
  last_deal           date,
  prior_turnover_gel  numeric,
  max_request_gel     numeric,
  last_reason         text,
  step                text,
  step_at             timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me    uuid := p_kam;
  v_all   boolean := p_all;
  v_today date := private.tbilisi_today();
  v_fresh date;
  v_rules public.rules%rowtype;
begin
  v_fresh := coalesce(private.freshness_date(), v_today);
  select * into v_rules from public.rules limit 1;

  return query
  with o as (
    select * from private.owners(v_today - v_rules.winback_window_days, v_today)
  ),
  latest as (
    select distinct on (r.client_id)
           r.client_id, r.request_date, r.import_key, r.legacy_status, r.rate_written_at
    from public.requests r
    where r.client_id in (select o.client_id from o)
    order by r.client_id, r.request_date desc, r.requested_at desc, r.id desc
  ),
  last_ok as (
    select t.client_id, max(t.tx_date) as last_deal
    from public.transactions t
    where t.payment_status = 'SUCCESS' and t.client_id in (select o.client_id from o)
    group by t.client_id
  ),
  cand as (
    select o.client_id, o.owner_id, lt.request_date as last_request, lk.last_deal
    from o
    join latest lt on lt.client_id = o.client_id
    left join last_ok lk on lk.client_id = o.client_id
    where lt.request_date < v_fresh
      and lt.rate_written_at is null
      and (lk.last_deal is null or lk.last_deal < lt.request_date)
      -- A completed, partial, or still-open agreement row is not a lost client.
      -- A written rate is a success, so that client leaves this list.
      -- "Did not go through" still is, unless a successful payment is on or after that day.
      -- Requests typed in the app keep the payment rule when the rate was not written.
      and (
        lt.import_key is null
        or lt.import_key not like 'agreement:%'
        or coalesce(lt.legacy_status, '') in (
          'არ შესრულდა',
          'ბანკმა გააჩერა ტრანზაქცია',
          'აღარ დასჭირდა და გააუქმა',
          'უარი თქვა, მცირედი განსხვავების გამო ბანკში ურჩევნოდა კონვერტაცია'
        )
      )
  ),
  sizes as (
    select cd.client_id,
           (select coalesce(sum(t.abs_gel + t.cross_gel), 0)
              from public.transactions t
             where t.client_id = cd.client_id
               and t.payment_status = 'SUCCESS'
               and t.tx_date >= cd.last_request - 180
               and t.tx_date <  cd.last_request) as prior_turnover_gel,
           (select round(max(case when r.sells_currency = 'GEL' then r.amount
                                  when r.gets_currency  = 'GEL' then r.amount * r.rate end), 2)
              from public.requests r
             where r.client_id = cd.client_id
               and r.request_date >= v_today - v_rules.winback_window_days) as max_request_gel
    from cand cd
  ),
  latest_reason as (
    select distinct on (r.client_id) r.client_id, r.loss_reason
    from public.requests r
    where r.client_id in (select cd.client_id from cand cd)
    order by r.client_id, r.requested_at desc
  ),
  latest_step as (
    select distinct on (w.client_id) w.client_id, w.step, w.created_at
    from public.winback_actions w
    where w.client_id in (select cd.client_id from cand cd)
    order by w.client_id, w.created_at desc
  ),
  scored as (
    select cd.*, s.prior_turnover_gel, s.max_request_gel,
           greatest(s.prior_turnover_gel, coalesce(s.max_request_gel, 0)) as size_gel
    from cand cd
    join sizes s on s.client_id = cd.client_id
  )
  select sc.client_id,
         cl.name,
         cl.kind,
         sc.owner_id,
         p.full_name,
         case when sc.size_gel >= v_rules.tier_a_min_gel then 'A'
              when sc.size_gel >= v_rules.tier_b_min_gel then 'B'
              else 'C' end,
         sc.last_request,
         sc.last_deal,
         sc.prior_turnover_gel,
         sc.max_request_gel,
         lr.loss_reason,
         coalesce(ls.step, 'not_contacted'),
         ls.created_at
  from scored sc
  join public.clients cl  on cl.client_id = sc.client_id
  join public.profiles p  on p.id = sc.owner_id
  left join latest_reason lr on lr.client_id = sc.client_id
  left join latest_step  ls on ls.client_id = sc.client_id
  where v_all or sc.owner_id = v_me
  order by 6, sc.size_gel desc;
end;
$$;

revoke all on function private.winback_for(uuid, boolean) from public, anon, authenticated;
