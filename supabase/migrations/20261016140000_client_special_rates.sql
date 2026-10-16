-- Paste this in the Supabase SQL editor when you want the change.
-- Copy it from disk. Paste it after 41_rate_competitiveness.sql.
-- Do not re-run 1_platform.sql.
-- Safe to paste again. It does not change log_request, quotes, loss
-- approval, request_outcomes, or whether a transaction counts as a success.
-- It does not widen can_see_all.
--
-- Client-reported bank terms. One row per client and bank (TBC, BOG,
-- Liberty, or Other). Saving one bank leaves the other banks alone.
-- A blank field does not erase a value already stored. A numeric rate
-- is optional: the row can say that special conditions exist with no rate.
-- This is what the client told a KAM. It is not a verified market rate.
--
-- The table is not granted to the API. Two functions are the only door.
-- If this file has not been pasted, the request form hides the section
-- and log_request still runs.
--
-- Read (client_special_rates): an active admin or manager (can_see_all),
-- treasury, or a KAM for a client already in their book (is_my_client).
-- A KAM does not receive another KAM's client. An analyst is not added.
-- Write (save_client_special_rate): an admin, treasury, or a KAM for
-- their own client. A manager can read and cannot write.

create table if not exists public.client_special_rates (
  client_id       text not null references public.clients (client_id),
  bank            text not null,
  provider_label  text,
  comment         text,
  sells_currency  text,
  gets_currency   text,
  rate            numeric(18,6),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references public.profiles (id) on delete set null,
  primary key (client_id, bank)
);

alter table public.client_special_rates add column if not exists provider_label text;
alter table public.client_special_rates add column if not exists comment text;
alter table public.client_special_rates add column if not exists sells_currency text;
alter table public.client_special_rates add column if not exists gets_currency text;
alter table public.client_special_rates add column if not exists rate numeric(18,6);
alter table public.client_special_rates add column if not exists updated_at timestamptz not null default now();
alter table public.client_special_rates add column if not exists updated_by uuid references public.profiles (id) on delete set null;

comment on table public.client_special_rates is
  'Bank terms the client reported. One row per client and bank. Not a verified market rate. A blank save does not erase an earlier value, and saving one bank does not remove another.';

comment on column public.client_special_rates.bank is
  'TBC, BOG, Liberty, or Other. This is the client''s special-rate provider, not the banks on the request (requests.banks).';

comment on column public.client_special_rates.provider_label is
  'Name the KAM typed when bank is Other. Empty for TBC, BOG, and Liberty.';

comment on column public.client_special_rates.comment is
  'Optional details the client reported. At most 500 characters.';

comment on column public.client_special_rates.rate is
  'Optional numeric rate the client reported. Empty is allowed.';

comment on column public.client_special_rates.updated_by is
  'Profile that last wrote a non-blank value on this row.';

alter table public.client_special_rates drop constraint if exists client_special_rates_bank_ok;
alter table public.client_special_rates
  add constraint client_special_rates_bank_ok
  check (bank in ('TBC', 'BOG', 'Liberty', 'Other'));

alter table public.client_special_rates drop constraint if exists client_special_rates_label_ok;
alter table public.client_special_rates
  add constraint client_special_rates_label_ok
  check (provider_label is null or char_length(btrim(provider_label)) between 1 and 80);

alter table public.client_special_rates drop constraint if exists client_special_rates_comment_ok;
alter table public.client_special_rates
  add constraint client_special_rates_comment_ok
  check (comment is null or char_length(comment) <= 500);

alter table public.client_special_rates drop constraint if exists client_special_rates_pair_ok;
alter table public.client_special_rates
  add constraint client_special_rates_pair_ok
  check (
    (sells_currency is null and gets_currency is null)
    or (
      sells_currency ~ '^[A-Z]{3}$'
      and gets_currency ~ '^[A-Z]{3}$'
      and sells_currency <> gets_currency
    )
  );

alter table public.client_special_rates drop constraint if exists client_special_rates_rate_ok;
alter table public.client_special_rates
  add constraint client_special_rates_rate_ok
  check (rate is null or rate > 0);

alter table public.client_special_rates enable row level security;
revoke all on table public.client_special_rates from public, anon, authenticated;

-- No table grant. A direct select from the API cannot read or write these rows.

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

  select coalesce(array_agg(s.id), '{}'::text[])
    into v_ids
  from (
    select distinct private.normalize_client_id(u.x) as id
    from unnest(coalesce(p_client_ids, '{}'::text[])) as u(x)
  ) s
  where s.id ~ '^([0-9]{9}|[0-9]{11})$';

  if coalesce(cardinality(v_ids), 0) > 100 then
    v_ids := v_ids[1:100];
  end if;

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
    and (
      private.can_see_all()
      or private.is_treasury()
      or private.is_my_client(r.client_id)
    )
  order by r.client_id, array_position(array['TBC', 'BOG', 'Liberty', 'Other']::text[], r.bank);
end;
$$;

comment on function public.client_special_rates(text[]) is
  'Special-rate rows for clients the caller can already see. Admin and manager, treasury, or the KAM who owns the client. Does not list another KAM''s client.';

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
    or (private.my_role() = 'kam' and private.is_my_client(v_id))
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
    client_id, bank, provider_label, comment, sells_currency, gets_currency, rate, updated_at, updated_by
  ) values (
    v_id, v_bank, v_label, v_comment, v_sells, v_gets, v_rate, now(), v_me
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
      updated_at = case when v_touch then now() else s.updated_at end,
      updated_by = case when v_touch then v_me else s.updated_by end;
end;
$$;

comment on function public.save_client_special_rate(text, text, text, text, text, text, numeric) is
  'Upserts one client and bank. Blank arguments keep the stored value. Other banks on that client stay. Admin, treasury, or the owning KAM. Does not change the request.';

revoke all on function public.save_client_special_rate(text, text, text, text, text, text, numeric) from public, anon;
grant execute on function public.save_client_special_rate(text, text, text, text, text, text, numeric) to authenticated;
