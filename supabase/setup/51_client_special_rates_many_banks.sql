-- Paste this in the Supabase SQL editor after 49_client_ownership.sql.
-- Copy it from disk. Do not re-run 42 or 49 after this file: both replace
-- client_special_rates, and 42 also replaces save_client_special_rate,
-- without the active flag.
-- Do not re-run 1_platform.sql. Safe to paste again.
--
-- Client-reported bank terms stay one row per client and bank
-- (TBC, BOG, Liberty, Other). This file does not drop the table and
-- does not delete rows. There is no audit trigger on this table, and
-- this file does not add one.
--
-- active is true while that bank term is current. Existing rows become
-- true, so terms already stored stay visible. Saving one bank sets that
-- bank true and leaves every other bank alone. A blank field still
-- keeps the stored value.
--
-- Unchecking the special-rate box is an explicit clear. clear_client_special_rates
-- sets active false on every bank for that client and keeps the row.
-- The read returns only active rows, so the next open shows the box
-- unchecked and does not present those banks as current.
--
-- Write is an admin (private.is_admin), treasury, or a KAM. A KAM may
-- already view every client, and this write uses that same role check.
-- A manager can still read and cannot write. An analyst is rejected.
-- This file does not change private.is_my_client or transactions_read.
-- It does not write a request, a quote, or a negotiated adjustment.

alter table public.client_special_rates
  add column if not exists active boolean not null default true;

comment on table public.client_special_rates is
  'Bank terms the client reported. One row per client and bank. Active rows are the current terms. Clearing the special-rate box sets active false and keeps the row. A blank save does not erase an earlier value, and saving one bank does not remove another.';

comment on column public.client_special_rates.active is
  'True while this bank term is current. Clearing the special-rate box sets every bank for that client to false and keeps the row. Saving one bank sets that bank back to true and does not change the other banks.';

comment on column public.client_special_rates.updated_by is
  'Profile that last saved a bank term or cleared the special-rate status.';

-- Same return columns as setup 42 and 49, so CREATE OR REPLACE does not hit 42P13.
-- Read audience stays the widened rule from 49. Inactive rows are not returned.
create or replace function public.client_special_rates(p_client_ids text[])
returns table (
  client_id        text,
  bank             text,
  provider_label   text,
  comment          text,
  sells_currency   text,
  gets_currency    text,
  rate             numeric,
  updated_at       timestamptz,
  updated_by_name  text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me  uuid := private.my_profile_id();
  v_ids text[];
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;

  -- Keep at most 100 ids, the lowest normalized client id text first.
  select coalesce(array_agg(picked.id order by picked.id), '{}'::text[])
    into v_ids
  from (
    select s.id
    from (
      select distinct private.normalize_client_id(u.x) as id
      from unnest(coalesce(p_client_ids, '{}'::text[])) as u(x)
    ) s
    where s.id ~ '^([0-9]{9}|[0-9]{11})$'
    order by s.id
    limit 100
  ) picked;

  return query
  select
    r.client_id,
    r.bank,
    r.provider_label,
    r.comment,
    r.sells_currency,
    r.gets_currency,
    r.rate,
    r.updated_at,
    p.full_name
  from public.client_special_rates r
  left join public.profiles p on p.id = r.updated_by
  where r.client_id = any (v_ids)
    and r.active
    and (
      private.can_see_all()
      or private.is_treasury()
      or private.my_role() = 'kam'
      or private.is_my_client(r.client_id)
    )
  order by r.client_id, array_position(array['TBC', 'BOG', 'Liberty', 'Other']::text[], r.bank);
end;
$$;

comment on function public.client_special_rates(text[]) is
  'Active special-rate rows for clients the caller can already open. A KAM may read any client. Admin and manager (can_see_all) and treasury may read. An analyst is not added. Inactive rows stay stored and are not returned.';

revoke all on function public.client_special_rates(text[]) from public, anon;
grant execute on function public.client_special_rates(text[]) to authenticated;

-- p_bank here is one provider: TBC, BOG, Liberty, or Other.
-- It is not log_request's p_bank array, and it is not written onto the request.
create or replace function public.save_client_special_rate(
  p_client_id       text,
  p_bank            text,
  p_provider_label  text default null,
  p_comment         text default null,
  p_sells_currency  text default null,
  p_gets_currency   text default null,
  p_rate            numeric default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me      uuid := private.my_profile_id();
  v_id      text := private.normalize_client_id(p_client_id);
  v_bank    text := btrim(coalesce(p_bank, ''));
  v_label   text := nullif(btrim(coalesce(p_provider_label, '')), '');
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_sells   text := nullif(upper(btrim(coalesce(p_sells_currency, ''))), '');
  v_gets    text := nullif(upper(btrim(coalesce(p_gets_currency, ''))), '');
  v_rate    numeric := p_rate;
  v_touch   boolean;
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if v_id is null or v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    raise exception 'კლიენტი ვერ მოიძებნა' using errcode = '22023';
  end if;
  if v_bank not in ('TBC', 'BOG', 'Liberty', 'Other') then
    raise exception 'ბანკი არასწორია' using errcode = '22023';
  end if;
  if not (
    private.is_admin()
    or private.is_treasury()
    or private.my_role() = 'kam'
  ) then
    raise exception 'ამ კლიენტის პირობების შენახვა არ შეგიძლიათ' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients c where c.client_id = v_id) then
    raise exception 'კლიენტი ვერ მოიძებნა' using errcode = 'P0002';
  end if;

  if v_bank <> 'Other' then
    v_label := null;
  end if;
  if v_comment is not null and char_length(v_comment) > 500 then
    raise exception 'კომენტარი 500 სიმბოლოზე გრძელია' using errcode = '22023';
  end if;
  if v_label is not null and char_length(v_label) > 80 then
    raise exception 'პროვაიდერის სახელი გრძელია' using errcode = '22023';
  end if;
  if v_sells is null or v_gets is null or v_sells = v_gets
     or v_sells !~ '^[A-Z]{3}$' or v_gets !~ '^[A-Z]{3}$' then
    v_sells := null;
    v_gets := null;
  end if;
  if v_rate is not null and not (v_rate > 0) then
    v_rate := null;
  end if;

  v_touch := v_comment is not null
    or v_rate is not null
    or v_sells is not null
    or v_label is not null;

  insert into public.client_special_rates as s (
    client_id, bank, provider_label, comment, sells_currency, gets_currency, rate, active, updated_at, updated_by
  ) values (
    v_id, v_bank, v_label, v_comment, v_sells, v_gets, v_rate, true, now(), v_me
  )
  on conflict (client_id, bank) do update
  set provider_label = case
        when excluded.bank = 'Other' then coalesce(excluded.provider_label, s.provider_label)
        else s.provider_label
      end,
      comment = coalesce(excluded.comment, s.comment),
      sells_currency = coalesce(excluded.sells_currency, s.sells_currency),
      gets_currency = coalesce(excluded.gets_currency, s.gets_currency),
      rate = coalesce(excluded.rate, s.rate),
      active = true,
      updated_at = case when v_touch or s.active is not true then now() else s.updated_at end,
      updated_by = case when v_touch or s.active is not true then v_me else s.updated_by end;
end;
$$;

comment on function public.save_client_special_rate(text, text, text, text, text, text, numeric) is
  'Upserts one client and bank and sets that row active. Blank arguments keep the stored value. Other banks on that client stay. Admin, treasury, or any KAM. A manager cannot write. An analyst is rejected. Does not change the request.';

revoke all on function public.save_client_special_rate(text, text, text, text, text, text, numeric) from public, anon;
grant execute on function public.save_client_special_rate(text, text, text, text, text, text, numeric) to authenticated;

-- Uncheck. Sets active false. Does not delete the row.
create or replace function public.clear_client_special_rates(p_client_id text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me uuid := private.my_profile_id();
  v_id text := private.normalize_client_id(p_client_id);
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if v_id is null or v_id !~ '^([0-9]{9}|[0-9]{11})$' then
    raise exception 'კლიენტი ვერ მოიძებნა' using errcode = '22023';
  end if;
  if not (
    private.is_admin()
    or private.is_treasury()
    or private.my_role() = 'kam'
  ) then
    raise exception 'ამ კლიენტის პირობების შენახვა არ შეგიძლიათ' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients c where c.client_id = v_id) then
    raise exception 'კლიენტი ვერ მოიძებნა' using errcode = 'P0002';
  end if;

  update public.client_special_rates
  set active = false,
      updated_at = now(),
      updated_by = v_me
  where client_id = v_id
    and active;
end;
$$;

comment on function public.clear_client_special_rates(text) is
  'Sets active false on every special-rate bank for one client. Keeps the rows. Admin, treasury, or any KAM. A manager cannot write. An analyst is rejected. Does not change the request.';

revoke all on function public.clear_client_special_rates(text) from public, anon;
grant execute on function public.clear_client_special_rates(text) to authenticated;
