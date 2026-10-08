-- KAM platform: bank on a new request, and the outcomes list carries it.
-- Past requests stay on the existing read rules. This does not send messages.
-- Same text as supabase/setup/16_client_history.sql.

alter table public.requests add column if not exists bank text;

comment on column public.requests.bank is
  'Bank the client is sending to: TBC, BOG, or Liberty. Empty on imported history and on requests made before this column.';

alter table public.requests drop constraint if exists requests_bank_ok;
alter table public.requests add constraint requests_bank_ok
  check (bank is null or bank in ('TBC', 'BOG', 'Liberty'));

-- Outcomes view: same columns as 11_client_reply.sql, then the bank.
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
  r.better_decided_at,
  r.bank
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

-- A new request typed in the app must name TBC, BOG, or Liberty.
-- Imported rows are not inserted here, so they can stay empty.
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
  p_bank           text default null
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
  if p_bank is null or p_bank not in ('TBC', 'BOG', 'Liberty') then
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

  if not v_new and nullif(trim(p_client_name), '') is not null then
    update public.clients c set name = trim(p_client_name)
    where c.client_id = v_id and c.name is null;
  end if;

  if v_new then
    insert into private.backfill_queue (client_id) values (v_id)
    on conflict (client_id) do update set done_at = null, queued_at = now();
  end if;

  insert into public.requests (
    kam_id, client_id, sells_currency, gets_currency, amount, gets_amount, client_rate, note, bank
  )
  values (
    v_me, v_id, v_sells, v_gets,
    v_sell_amt, v_gets_amt,
    case when p_client_rate is null then null else round(p_client_rate, 6) end,
    nullif(trim(p_note), ''),
    p_bank
  )
  returning id into v_request_id;

  return v_request_id;
end;
$$;

revoke execute on function public.log_request(text, text, text, numeric, text, text, numeric, numeric, text) from public, anon;
grant execute on function public.log_request(text, text, text, numeric, text, text, numeric, numeric, text) to authenticated;
