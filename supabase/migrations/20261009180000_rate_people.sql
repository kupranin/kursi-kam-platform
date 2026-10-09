-- Who gave the rate and who wrote it, for people allowed to see the request.

create or replace view public.request_rate_names
with (security_invoker = false, security_barrier = true)
as
select
  r.id,
  nullif(btrim(qb.full_name), '') as quoted_by_name,
  nullif(btrim(wb.full_name), '') as written_by_name
from public.requests r
left join public.profiles qb on qb.id = r.quoted_by
left join public.profiles wb on wb.id = r.rate_written_by
where r.kam_id = (select private.my_profile_id())
   or (select private.can_see_all())
   or (select private.is_treasury())
   or (select private.my_role()) = 'analyst';

revoke all on public.request_rate_names from public, anon;
grant select on public.request_rate_names to authenticated;

comment on view public.request_rate_names is
  'Who gave the rate and who wrote it, for a request the signed-in person is allowed to see.';
