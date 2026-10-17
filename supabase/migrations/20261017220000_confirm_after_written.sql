-- A written rate is not desk success. confirm_request_payment still sets
-- payment_confirmed_at. It no longer refuses because rate_written_at is set.
-- Display class and analytics still treat a written rate as won.
-- Does not change request_display_class. Does not add a column.
-- Does not add or remove a private.emit. The existing inbox trigger
-- already notifies the owning KAM when rate_written_at is set.

create or replace function public.confirm_request_payment(p_request_id bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me           uuid := private.my_profile_id();
  v_kam          uuid;
  v_confirmed    timestamptz;
  v_rate_written timestamptz;
  v_import_key   text;
  v_legacy       text;
  v_client       text;
  v_date         date;
  v_source       text;
  v_requested    timestamptz;
begin
  if v_me is null then
    raise exception 'Not signed in, or the account is inactive' using errcode = '42501';
  end if;
  if private.my_role() is distinct from 'admin' and private.my_role() is distinct from 'kam' then
    raise exception 'მხოლოდ KAM-ს ან ადმინს შეუძლია თქვას, რომ ტრანზაქცია გავიდა' using errcode = '42501';
  end if;
  if not private.can_write() then
    raise exception 'Your account cannot change requests' using errcode = '42501';
  end if;

  select
    r.kam_id,
    r.payment_confirmed_at,
    r.rate_written_at,
    r.import_key,
    r.legacy_status,
    r.client_id,
    r.request_date,
    r.source,
    r.requested_at
    into
    v_kam,
    v_confirmed,
    v_rate_written,
    v_import_key,
    v_legacy,
    v_client,
    v_date,
    v_source,
    v_requested
  from public.requests r
  where r.id = p_request_id
  for update;

  if not found then
    raise exception 'მოთხოვნა ვერ მოიძებნა' using errcode = 'P0002';
  end if;
  if v_kam is distinct from v_me and not private.is_admin() then
    raise exception 'ეს მოთხოვნა სხვა KAM-ისაა' using errcode = '42501';
  end if;
  if v_confirmed is not null then
    return;
  end if;
  if v_rate_written is null
     and (
       (v_import_key like 'agreement:%' and v_legacy = 'შესრულდა')
       or exists (
         select 1
         from public.transactions t
         where t.payment_status = 'SUCCESS'
           and (
             (
               t.tx_id is not null
               and t.client_id = v_client
               and t.tx_date = v_date
               and (v_source = 'import' or t.tx_time >= v_requested - interval '1 minute')
             )
             or t.matched_request_id = p_request_id
           )
       )
     )
  then
    raise exception 'ეს მოთხოვნა უკვე გავიდა' using errcode = '22023';
  end if;

  update public.requests r
     set payment_confirmed_at = now(),
         payment_confirmed_by = v_me
   where r.id = p_request_id;
end;
$$;

comment on function public.confirm_request_payment(bigint) is
  'Owning KAM or an admin sets payment_confirmed_at. A written rate does not block this. A second call does nothing. Does not change rate_written_at, display class, or private.emit.';

revoke all on function public.confirm_request_payment(bigint) from public, anon;
grant execute on function public.confirm_request_payment(bigint) to authenticated;
