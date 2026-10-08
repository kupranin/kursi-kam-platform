-- Paste this once in the Supabase SQL editor. Do not re-run 1_platform.sql.
--
-- On 8 Oct 2026 treasury entered 2.6021 for client 202268928 (სს დიგი ელექტრონიქსი).
-- The open quote was saved as 2.6030, which is what the KAM card and the copy line show.
-- Put the typed rate back. Only that quote is touched.

update public.quotes q
   set rate = 2.6021
  from public.requests r
 where q.request_id = r.id
   and q.action = 'quoted'
   and q.rate = 2.6030
   and r.client_id = '202268928'
   and r.request_date = date '2026-10-08';

update public.requests r
   set rate = 2.6021
 where r.client_id = '202268928'
   and r.request_date = date '2026-10-08'
   and r.quote_status = 'quoted'
   and r.rate = 2.6030;
