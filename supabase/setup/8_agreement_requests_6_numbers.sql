-- Paste this last (file 6 of 6), after file 5. Safe to paste again.
--
-- KAM turnover actuals from completed deals in the agreement file, in lari.
-- A foreign amount is converted with that row's agreed lari rate.
-- Dollar-to-euro (and other) deals with no lari leg are not included.
-- Partial deals are not included.
-- Plans, margins, business, and retail are not changed.
-- July, August, and September KAM actuals already hold the company KAM
-- turnover (about 126 to 145 million) and are not replaced by this file.
--   2026-07 agreement completed lari 114480393.77 (556 deals) — not written
--   2026-08 agreement completed lari 97306909.12 (622 deals) — not written
--   2026-09 agreement completed lari 86119418.95 (475 deals) — not written

insert into public.kpi_plans (year, month, segment, metric, actual_value)
values
  (2026, 2, 'kam', 'turnover', 40189620.31),
  (2026, 3, 'kam', 'turnover', 67872565.50),
  (2026, 4, 'kam', 'turnover', 91792194.87),
  (2026, 5, 'kam', 'turnover', 101115317.64),
  (2026, 6, 'kam', 'turnover', 93479757.08),
  (2026, 10, 'kam', 'turnover', 9640945.87)
on conflict (year, month, segment, metric) do update
  set actual_value = excluded.actual_value,
      updated_at = now()
  where public.kpi_plans.segment = 'kam'
    and public.kpi_plans.metric = 'turnover'
    and (
      public.kpi_plans.actual_value is null
      or public.kpi_plans.actual_value = 0
      or (
        public.kpi_plans.year = 2026
        and public.kpi_plans.month = 10
        and public.kpi_plans.actual_value = 9640945.87
      )
    );

-- Check, after all six files. Requests loaded from the file:
select coalesce(legacy_status, '(blank)') as file_status, count(*) as requests
from public.requests
where import_key like 'agreement:%'
group by 1
order by 2 desc;
