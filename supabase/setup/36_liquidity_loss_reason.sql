-- Paste this in the Supabase SQL editor when you want the change.
-- Copy it from disk. Paste it after 35_rate_hour_snapshots.sql.
-- Do not re-run 1_platform.sql.
-- Safe to paste again. It adds one KAM loss reason. It does not
-- change who can mark a request lost, and it does not change approval.
-- Only other still needs a written comment.

insert into public.loss_reasons (code, label_en, label_ka, sort_order) values
  ('liquidity', 'Liquidity problem', 'ლიკვიდობის პრობლემა', 40)
on conflict (code) do nothing;
