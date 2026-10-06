-- Paste this once in the Supabase SQL editor.
-- After this, typing a company name or ID searches the whole directory.
-- An empty box still shows only that KAM's recent clients.
-- A company saved on a new rate request is in the directory for everyone.

create or replace function public.search_my_clients(p_query text default '', p_limit int default 8)
returns table (
  client_id            text,
  name                 text,
  kind                 text,
  last_request_date    date,
  last_sells_currency  text,
  last_gets_currency   text
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
    select c.client_id, c.name, c.kind
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
  select p.client_id, p.name, p.kind, lr.request_date, lr.sells_currency, lr.gets_currency
  from pool p
  left join last_req lr on lr.client_id = p.client_id
  where v_q = ''
     or (v_digits and (p.client_id like v_like || '%' or p.client_id like '0' || v_like || '%'))
     or (not v_digits and p.name ilike '%' || v_like || '%')
  order by lr.requested_at desc nulls last, p.name
  limit v_limit;
end;
$$;

revoke execute on function public.search_my_clients(text, int) from public, anon;
grant execute on function public.search_my_clients(text, int) to authenticated;
