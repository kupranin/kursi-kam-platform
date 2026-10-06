-- Paste this once in the Supabase SQL editor.
-- KPIs: the monthly plan (Business, KAM, Retail) and the 2026 vs 2025
-- turnover sheet. Margin % is entered here; the workbook does not calculate it.
-- Planned, actual % and planned vs actual are calculated on the page.
-- Market rates are filled by the fetch-market-rates function.

create table public.kpi_plans (
  year         int not null check (year between 2020 and 2100),
  month        int not null check (month between 1 and 12),
  segment      text not null check (segment in ('business', 'kam', 'retail')),
  metric       text not null check (metric in ('turnover', 'active_users', 'new_users', 'registrations')),
  plan_value   numeric,
  planned_pct  numeric,
  actual_value numeric,
  margin_pct   numeric,
  updated_at   timestamptz not null default now(),
  primary key (year, month, segment, metric)
);

create table public.kpi_history (
  segment    text not null check (segment in ('retail', 'business')),
  year       int not null check (year between 2020 and 2100),
  month      int not null check (month between 1 and 12),
  amount     numeric,
  updated_at timestamptz not null default now(),
  primary key (segment, year, month)
);

alter table public.kpi_plans enable row level security;
alter table public.kpi_history enable row level security;
revoke all on public.kpi_plans, public.kpi_history from anon, authenticated;
grant select, insert, update on public.kpi_plans, public.kpi_history to authenticated;

create policy kpi_plans_read on public.kpi_plans for select to authenticated
  using ((select private.can_see_all()));
create policy kpi_plans_insert on public.kpi_plans for insert to authenticated
  with check ((select private.can_see_all()));
create policy kpi_plans_update on public.kpi_plans for update to authenticated
  using ((select private.can_see_all())) with check ((select private.can_see_all()));

create policy kpi_history_read on public.kpi_history for select to authenticated
  using ((select private.can_see_all()));
create policy kpi_history_insert on public.kpi_history for insert to authenticated
  with check ((select private.can_see_all()));
create policy kpi_history_update on public.kpi_history for update to authenticated
  using ((select private.can_see_all())) with check ((select private.can_see_all()));

-- planned_pct and margin_pct are fractions: 1 = 100%.
insert into public.kpi_plans (year, month, segment, metric, plan_value, planned_pct, actual_value)
values
  (2026, 7, 'business', 'turnover', 178000000, 1, 177696914.34040761),
  (2026, 7, 'business', 'active_users', 2020, 1, 1856),
  (2026, 7, 'business', 'new_users', 278, 1, 226),
  (2026, 7, 'business', 'registrations', 225, 1, 188),
  (2026, 7, 'kam', 'turnover', 147000000, 1, 145475523.71714994),
  (2026, 7, 'retail', 'turnover', 366000000, 1, 354065065.69345003),
  (2026, 7, 'retail', 'active_users', 50204, 1, 49650),
  (2026, 7, 'retail', 'new_users', 5561, 1, 5876),
  (2026, 7, 'retail', 'registrations', 8261, 1, 8696),
  (2026, 8, 'business', 'turnover', 190000000, 1, 156710636.22535291),
  (2026, 8, 'business', 'active_users', 1984.5026646, 1, 1778),
  (2026, 8, 'business', 'new_users', 241.64741498, 1, 204),
  (2026, 8, 'business', 'registrations', 201.0164337, 1, 169),
  (2026, 8, 'kam', 'turnover', 155000000, 1, 125864215.09106496),
  (2026, 8, 'retail', 'turnover', 360000000, 1, 330931397.05085933),
  (2026, 8, 'retail', 'active_users', 50482.24671641, 1, 48876),
  (2026, 8, 'retail', 'new_users', 5974.49509981, 1, 5230),
  (2026, 8, 'retail', 'registrations', 8841.76470183, 1, 9070),
  (2026, 9, 'business', 'turnover', 197000000, 1, 168989540.48356354),
  (2026, 9, 'business', 'active_users', 2235.11312593, 1, 1816),
  (2026, 9, 'business', 'new_users', 256.4471753, 1, 226),
  (2026, 9, 'business', 'registrations', 212.44888542, 1, 192),
  (2026, 9, 'kam', 'turnover', 154000000, 1, 142103155.29955694),
  (2026, 9, 'retail', 'turnover', 375000000, 1, 345329041.69961965),
  (2026, 9, 'retail', 'active_users', 55384.59077421, 1, 49627),
  (2026, 9, 'retail', 'new_users', 5926.45490116, 1, 5046),
  (2026, 9, 'retail', 'registrations', 10277.80993375, 1, 8061),
  (2026, 10, 'business', 'turnover', 180000000, 0, 0),
  (2026, 10, 'business', 'active_users', 1934.32089977, 0, 0),
  (2026, 10, 'business', 'new_users', 240.72495779, 0, 0),
  (2026, 10, 'business', 'registrations', 204.50969865, 0, 0),
  (2026, 10, 'kam', 'turnover', 144000000, 0, 0),
  (2026, 10, 'retail', 'turnover', 376000000, 0, 0),
  (2026, 10, 'retail', 'active_users', 54034.70240488, 0, 0),
  (2026, 10, 'retail', 'new_users', 5494.16866494, 0, 0),
  (2026, 10, 'retail', 'registrations', 9776.95077449, 0, 0)
on conflict (year, month, segment, metric) do nothing;

insert into public.kpi_history (segment, year, month, amount)
values
  ('retail', 2025, 1, 43492380.09456032),
  ('retail', 2026, 1, 257397919.18817505),
  ('business', 2025, 1, 51253920.27805497),
  ('business', 2026, 1, 155508239.14632997),
  ('retail', 2025, 2, 60493778.01718006),
  ('retail', 2026, 2, 283156463.77445018),
  ('business', 2025, 2, 73770912.67317003),
  ('business', 2026, 2, 146541201.33518878),
  ('retail', 2025, 3, 81814266.63081209),
  ('retail', 2026, 3, 296064668.13911498),
  ('business', 2025, 3, 87356296.1664),
  ('business', 2026, 3, 174421795.93762705),
  ('retail', 2025, 4, 101260188.19849651),
  ('retail', 2026, 4, 293446667.81177354),
  ('business', 2025, 4, 104688177.88614),
  ('business', 2026, 4, 170104134.57061416),
  ('retail', 2025, 5, 139758760.6295872),
  ('retail', 2026, 5, 334422313.44639909),
  ('business', 2025, 5, 144345548.85613409),
  ('business', 2026, 5, 199893045.84396639),
  ('retail', 2025, 6, 179047430.68435299),
  ('retail', 2026, 6, 357285024.26036644),
  ('business', 2025, 6, 157901134.60624009),
  ('business', 2026, 6, 187578385.03116509),
  ('retail', 2025, 7, 232001941.58665916),
  ('retail', 2026, 7, 354065065.69345003),
  ('business', 2025, 7, 220133343.22085574),
  ('business', 2026, 7, 177696914.34040761),
  ('retail', 2025, 8, 235382422.44171867),
  ('retail', 2026, 8, 330931397.05085933),
  ('business', 2025, 8, 183455555.26755396),
  ('business', 2026, 8, 156710636.22535291),
  ('retail', 2025, 9, 288341812.77678418),
  ('retail', 2026, 9, 375000000),
  ('business', 2025, 9, 233213314.63085014),
  ('business', 2026, 9, 197000000)
on conflict (segment, year, month) do nothing;

create table public.market_rates (
  source          text not null check (source in ('kursi', 'rico', 'myvaluta', 'valuto', 'expresslombard')),
  venue           text not null check (char_length(venue) between 1 and 80),
  venue_kind      text not null check (venue_kind in ('board', 'bank', 'kiosk')),
  currency        text not null check (currency ~ '^[A-Z]{3}$'),
  quote_currency  text not null default 'GEL' check (quote_currency ~ '^[A-Z]{3}$'),
  buy             numeric,
  sell            numeric,
  official        numeric,
  fetched_at      timestamptz not null default now(),
  primary key (source, venue, currency, quote_currency),
  constraint market_rates_has_price check (buy is not null or sell is not null or official is not null)
);

alter table public.market_rates enable row level security;
revoke all on public.market_rates from anon, authenticated;
grant select on public.market_rates to authenticated;

create policy market_rates_read on public.market_rates for select to authenticated
  using ((select private.my_role()) in ('admin', 'manager', 'treasury', 'kam'));

-- Rates also refresh on their own. Paste 6_market_rates_schedule.sql next
-- (safe to run more than once) so that happens every 30 minutes.
