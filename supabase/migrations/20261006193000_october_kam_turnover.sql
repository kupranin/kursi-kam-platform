-- October 2026 KAM turnover actual, from the agreement workbook
-- (Main file, dates 1–6 Oct 2026).
--
-- 76 deals marked completed, summed in lari only: 9,640,945.87 GEL.
-- Where the lari amount was blank, it is the other amount times the
-- agreed rate (USD, EUR, or RUB against lari). Dollar-to-euro deals
-- are not included. Plans are left as they were. The update runs only
-- while October KAM turnover actual is still empty (null or 0).

insert into public.kpi_plans (year, month, segment, metric, plan_value, planned_pct, actual_value)
values (2026, 10, 'kam', 'turnover', 144000000, 0, 9640945.87)
on conflict (year, month, segment, metric) do update
  set actual_value = excluded.actual_value,
      updated_at = now()
  where public.kpi_plans.actual_value is null
     or public.kpi_plans.actual_value = 0;
