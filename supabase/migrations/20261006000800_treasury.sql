-- =====================================================================
-- KAM platform, migration 8: treasury gives the rates
--
-- Flow: a KAM asks for a rate -> the request waits in treasury's queue
-- -> treasury sends a rate with a validity time, or sends the request
-- back with a reason -> the KAM tells the client -> the client's
-- transaction closes the request (unchanged: same-day SUCCESS).
-- An expired or sent-back request can be asked again.
-- Every rate treasury gives is kept in public.quotes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Treasury role
-- ---------------------------------------------------------------------
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'manager', 'treasury', 'kam'));
comment on table public.profiles is
  'One row per person. Roles: admin = everything incl. users and rules; manager = sees everything, changes nothing; treasury = gives rates, sees all requests; kam = own requests, clients and follow-ups.';

-- ---------------------------------------------------------------------
-- 2. Requests: the rate now comes from treasury, not from the KAM
-- ---------------------------------------------------------------------
alter table public.requests drop constraint requests_app_rows_complete;
alter table public.requests add constraint requests_app_rows_complete check (
  source = 'import'
  or (sells_currency is not null and gets_currency is not null and amount is not null)
);

alter table public.requests
  add column asked_at          timestamptz not null default now(),
  add column quote_status      text not null default 'asking'
                               check (quote_status in ('asking', 'quoted', 'declined')),
  add column rate_valid_until  timestamptz,
  add column quoted_by         uuid references public.profiles (id),
  add column quoted_at         timestamptz,
  add column decline_reason    text check (length(decline_reason) <= 200);

comment on column public.requests.rate is 'The rate treasury gave (latest). Imported rows keep the rate from the old file.';

-- imported history is not waiting for anyone
update public.requests set quote_status = 'quoted', asked_at = requested_at where source = 'import';

create index requests_asking_idx on public.requests (asked_at) where quote_status = 'asking';

-- ---------------------------------------------------------------------
-- 3. Every rate treasury gives, and every request sent back
-- ---------------------------------------------------------------------
create table public.quotes (
  id           bigint generated always as identity primary key,
  request_id   bigint not null references public.requests (id) on delete cascade,
  action       text not null check (action in ('quoted', 'declined')),
  rate         numeric(18,6) check (rate > 0),
  valid_until  timestamptz,
  reason       text check (length(reason) <= 200),
  created_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now()
);
create index quotes_request_idx on public.quotes (request_id, created_at desc);
create trigger audit_quotes after insert on public.quotes for each row execute function private.audit_row();

-- ---------------------------------------------------------------------
-- 4. Default validity of a rate
-- ---------------------------------------------------------------------
alter table public.rules
  add column default_quote_minutes int not null default 15 check (default_quote_minutes between 1 and 240);
grant update (default_quote_minutes) on public.rules to authenticated;

-- ---------------------------------------------------------------------
-- 5. Who may do what
-- ---------------------------------------------------------------------
create or replace function private.is_treasury()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() = 'treasury', false) $$;

-- treasury reads every request and client (also needed for live updates)
drop policy requests_read on public.requests;
create policy requests_read on public.requests for select to authenticated
  using (
    kam_id = (select private.my_profile_id())
    or (select private.can_see_all())
    or (select private.is_treasury())
  );

drop policy clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated
  using (
    (select private.can_see_all())
    or (select private.is_treasury())
    or private.is_my_client(client_id)
  );

alter table public.quotes enable row level security;
revoke all on public.quotes from anon, authenticated;
grant select on public.quotes to authenticated;
create policy quotes_read on public.quotes for select to authenticated
  using (
    (select private.can_see_all())
    or (select private.is_treasury())
    or exists (
      select 1 from public.requests r
      where r.id = quotes.request_id and r.kam_id = (select private.my_profile_id())
    )
  );

-- ---------------------------------------------------------------------
-- 6. Outcomes view: same columns as before, plus the quote state
--    quote_state: asking | quoted | expired | declined
-- ---------------------------------------------------------------------
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
  ) as went_through
) w;

-- ---------------------------------------------------------------------
-- 7. KAM: ask for a rate (replaces the old log_request, which took a rate)
-- ---------------------------------------------------------------------
drop function public.log_request(text, text, text, numeric, numeric, text, text);

create or replace function public.log_request(
  p_client_id      text,
  p_sells_currency text,
  p_gets_currency  text,
  p_amount         numeric,
  p_note           text default null,
  p_client_name    text default null
)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me         uuid := private.my_profile_id();
  v_id         text := private.normalize_client_id(p_client_id);
  v_sells      text := upper(trim(coalesce(p_sells_currency, '')));
  v_gets       text := upper(trim(coalesce(p_gets_currency, '')));
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
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter the amount' using errcode = '22023';
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

  insert into public.requests (kam_id, client_id, sells_currency, gets_currency, amount, note)
  values (v_me, v_id, v_sells, v_gets, round(p_amount, 2), nullif(trim(p_note), ''))
  returning id into v_request_id;

  return v_request_id;
end;
$$;

-- KAM: ask again after a rate expired or treasury sent the request back
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
  update public.requests r
     set quote_status = 'asking', asked_at = now(), rate = null, rate_valid_until = null,
         decline_reason = null, quoted_by = null, quoted_at = null,
         note = coalesce(nullif(trim(p_note), ''), r.note)
   where r.id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Treasury: the queue, giving a rate, sending a request back
-- ---------------------------------------------------------------------
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
  last_rate        numeric,   -- last rate given to this client for the same currencies (incl. an expired one on this request)
  last_rate_at     timestamptz
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
         lq.created_at
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
  where r.quote_status = 'asking'
  order by r.asked_at;
end;
$$;

create or replace function public.treasury_quote(p_request_id bigint, p_rate numeric, p_valid_minutes int default null)
returns timestamptz
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me     uuid := private.my_profile_id();
  v_req    public.requests%rowtype;
  v_min    int;
  v_until  timestamptz;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can give rates' using errcode = '42501';
  end if;
  -- lock the row so two dealers can't answer the same request
  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.quote_status <> 'asking' then
    raise exception 'This request has already been answered' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'Enter a rate first' using errcode = '22023';
  end if;
  v_min := coalesce(p_valid_minutes, (select r.default_quote_minutes from public.rules r));
  if v_min < 1 or v_min > 240 then
    raise exception 'Validity must be between 1 and 240 minutes' using errcode = '22023';
  end if;
  v_until := now() + make_interval(mins => v_min);

  update public.requests r
     set rate = p_rate, quote_status = 'quoted', rate_valid_until = v_until,
         quoted_by = v_me, quoted_at = now(), decline_reason = null
   where r.id = p_request_id;
  insert into public.quotes (request_id, action, rate, valid_until, created_by)
  values (p_request_id, 'quoted', p_rate, v_until, v_me);
  return v_until;
end;
$$;

create or replace function public.treasury_decline(p_request_id bigint, p_reason text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_me  uuid := private.my_profile_id();
  v_req public.requests%rowtype;
begin
  if v_me is null or not (private.is_treasury() or private.is_admin()) then
    raise exception 'Only treasury can send requests back' using errcode = '42501';
  end if;
  if length(coalesce(trim(p_reason), '')) < 2 then
    raise exception 'Tell the KAM why' using errcode = '22023';
  end if;
  select * into v_req from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.quote_status <> 'asking' then
    raise exception 'This request has already been answered' using errcode = '22023';
  end if;
  update public.requests r
     set quote_status = 'declined', decline_reason = trim(p_reason),
         quoted_by = v_me, quoted_at = now(), rate = null, rate_valid_until = null
   where r.id = p_request_id;
  insert into public.quotes (request_id, action, reason, created_by)
  values (p_request_id, 'declined', trim(p_reason), v_me);
end;
$$;

-- today's rates, for treasury's "Your quotes" list
create or replace function public.treasury_quotes_today()
returns table (
  request_id      bigint,
  client_name     text,
  kam_name        text,
  sells_currency  text,
  gets_currency   text,
  amount          numeric,
  rate            numeric,
  quoted_at       timestamptz,
  valid_until     timestamptz,
  quote_state     text,
  went_through    boolean
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
         o.rate, o.quoted_at, o.rate_valid_until, o.quote_state, o.went_through
  from public.request_outcomes o
  where o.quote_status = 'quoted'
    and o.source = 'app'
    and (o.quoted_at at time zone 'Asia/Tbilisi')::date = private.tbilisi_today()
  order by o.quoted_at desc;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. Permissions
-- ---------------------------------------------------------------------
revoke execute on function
  public.log_request(text, text, text, numeric, text, text),
  public.ask_again(bigint, text),
  public.treasury_queue(),
  public.treasury_quote(bigint, numeric, int),
  public.treasury_decline(bigint, text),
  public.treasury_quotes_today()
from public, anon;

grant execute on function
  public.log_request(text, text, text, numeric, text, text),
  public.ask_again(bigint, text),
  public.treasury_queue(),
  public.treasury_quote(bigint, numeric, int),
  public.treasury_decline(bigint, text),
  public.treasury_quotes_today()
to authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.my_profile_id(), private.my_role(), private.can_see_all(), private.is_admin(),
  private.can_write(), private.is_my_client(text), private.freshness_date(), private.tbilisi_today(),
  private.is_treasury()
to authenticated;
