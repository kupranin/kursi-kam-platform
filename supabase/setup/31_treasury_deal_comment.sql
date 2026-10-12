-- Paste this in the Supabase SQL editor. Safe to paste again.
-- Paste it after 30_rate_people.sql. Do not re-run 1_platform.sql.
-- If you paste 26_desk_and_history.sql again later, paste this file once more afterwards.
-- Do not drop requests. Do not delete rows.
--
-- Treasury sees the same analyst list as an analyst or an admin.
-- requests.treasury_deal_comment is a note on each row of that list.
-- It is not the loss-approval comment (loss_approval_comment), which the
-- list still shows as treasury_comment.
-- Only treasury or an admin can write the new note. An analyst can read
-- it. A KAM cannot. A written rate still cannot be deleted.
--
-- The list gains one column at the end (deal_comment). Create or replace
-- can add a column at the end, so this file does not drop the view.
-- Do not drop public.request_outcomes. Do not change treasury_queue().
-- If the paste says the view columns do not match, the list is still the
-- older one. Paste 26_desk_and_history.sql, then paste this file again.
-- Do not use DROP VIEW CASCADE.


begin;
set local lock_timeout = '3s';
alter table public.requests add column if not exists treasury_deal_comment text;
alter table public.requests drop constraint if exists requests_treasury_deal_comment_len;
alter table public.requests add constraint requests_treasury_deal_comment_len
  check (
    treasury_deal_comment is null
    or char_length(treasury_deal_comment) between 1 and 500
  );
comment on column public.requests.treasury_deal_comment is
  'Note treasury or an admin writes on each row of the analyst list. Not the loss-approval comment (loss_approval_comment). Empty is stored as null. An analyst can read it and cannot change it. A KAM cannot write it.';
commit;

-- Direct updates from a KAM are rejected. The function below is security
-- definer, so it runs as the owner and this guard lets it through.
-- Treasury and an admin may also write the column directly. The app uses
-- the function.
create or replace function private.guard_treasury_deal_comment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.treasury_deal_comment is null then
      return new;
    end if;
  elsif new.treasury_deal_comment is not distinct from old.treasury_deal_comment then
    return new;
  end if;
  if current_user is distinct from 'authenticated' then
    return new;
  end if;
  if private.is_admin() or private.is_treasury() then
    return new;
  end if;
  raise exception 'მხოლოდ ხაზინას ან ადმინს შეუძლია კომენტარის ჩაწერა' using errcode = '42501';
end;
$$;

revoke all on function private.guard_treasury_deal_comment() from public, anon, authenticated;

drop trigger if exists requests_guard_treasury_deal_comment on public.requests;
create trigger requests_guard_treasury_deal_comment
  before insert or update on public.requests
  for each row execute function private.guard_treasury_deal_comment();

create or replace function public.set_deal_comment(p_request_id bigint, p_comment text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  if not (private.is_treasury() or private.is_admin()) then
    raise exception 'მხოლოდ ხაზინას ან ადმინს შეუძლია კომენტარის ჩაწერა' using errcode = '42501';
  end if;
  if v_comment is not null and char_length(v_comment) > 500 then
    raise exception 'კომენტარი ძალიან გრძელია' using errcode = '22023';
  end if;

  update public.requests r
     set treasury_deal_comment = v_comment
   where r.id = p_request_id;
  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.set_deal_comment(bigint, text) from public, anon;
grant execute on function public.set_deal_comment(bigint, text) to authenticated;

comment on function public.set_deal_comment(bigint, text) is
  'Writes the per-row treasury note on a request. Treasury or an admin only. Empty is stored as null. Does not change the loss-approval comment or a written rate.';

-- Same columns as 26_desk_and_history.sql, plus deal_comment at the end.
-- Treasury can read the list. A KAM and a manager still cannot.
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
  case when d.status = 'lost' or d.rate_written or d.payment_confirmed then d.reason else null end as loss_reason,
  d.first_response_minutes,
  d.rate_write_minutes,
  d.quoted_by_name,
  d.treasury_comment,
  d.deal_comment
from (
  select
    r.id,
    r.request_date,
    p.full_name as kam_name,
    r.client_id,
    cl.name as client_name,
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
    (r.payment_confirmed_at is not null) as payment_confirmed,
    case
      when r.rate_written_at is not null or r.payment_confirmed_at is not null then 'success'
      when w.tx_hit or w.file_won then 'success'
      when r.marked_lost_at is not null and r.loss_approved_at is null then 'open'
      when r.marked_lost_at is not null then 'lost'
      when r.client_reply = 'better' and r.better_decision is null then 'open'
      when lc.loss_candidate and r.loss_approved_at is null then 'open'
      when lc.loss_candidate then 'lost'
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
    nullif(btrim(qb.full_name), '') as quoted_by_name,
    nullif(btrim(r.loss_approval_comment), '') as treasury_comment,
    nullif(btrim(r.treasury_deal_comment), '') as deal_comment
  from public.requests r
  join public.clients cl on cl.client_id = r.client_id
  left join public.profiles p on p.id = r.kam_id
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
  cross join lateral (
    select (
      r.source = 'app'
      and r.rate_written_at is null
      and r.payment_confirmed_at is null
      and not w.tx_hit
      and not w.file_won
      and (
        r.marked_lost_at is not null
        or (
          not (r.client_reply = 'better' and r.better_decision is null)
          and (
            r.client_reply = 'declined'
            or r.quote_status = 'declined'
            or r.request_date < coalesce(private.freshness_date(), r.request_date)
          )
        )
      )
    ) as loss_candidate
  ) lc
) d
where private.my_role() in ('analyst', 'admin', 'treasury');

comment on view public.analyst_deals is
  'Every request for an analyst, an admin, or treasury. A written rate is success. A KAM or admin confirmation that the payment went through is success too. A KAM or admin mark as lost stays open until treasury approves it, then it is lost. treasury_comment is the optional note treasury or an admin wrote when approving a loss. deal_comment is the per-row note treasury or an admin writes on this list. An analyst can read both and cannot change them.';

revoke all on public.analyst_deals from public, anon;
grant select on public.analyst_deals to authenticated;
