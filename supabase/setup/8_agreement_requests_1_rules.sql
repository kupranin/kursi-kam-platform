-- Paste this first in the Supabase SQL editor (file 1 of 6).
-- Safe to paste again.
--
-- Loads nothing yet. It teaches the app how a row from the agreement
-- file should be read, so a completed deal is not treated as a lost client.
-- The file's own status is kept on the request (legacy_status). The
-- screens already use three results: went through, waiting, or did not
-- go through. This maps the file onto those:
--   შესრულდა                  went through (won), even with no bank payment
--   არ შესრულდა               did not go through (lost)
--   შესრულდა ნაწილობრივ       left open (not won, not lost; the original
--                              words stay on the row)
--   blank                      left open
-- A real successful bank payment still counts as went through.
-- Requests typed in the app are unchanged.

alter table public.requests add column if not exists import_key text;
create unique index if not exists requests_import_key_key on public.requests (import_key);
comment on column public.requests.import_key is
  'Stable key for one row of the agreement workbook (agreement:<sheet row>). A second paste updates that row instead of adding another.';

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
  end as quote_state
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
           r.client_id, r.request_date, r.import_key, r.legacy_status
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
      and (lk.last_deal is null or lk.last_deal < lt.request_date)
      -- A completed, partial, or still-open agreement row is not a lost client.
      -- "Did not go through" still is, unless a successful payment is on or after that day.
      -- Requests typed in the app keep the payment rule.
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
