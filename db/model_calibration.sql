-- Self-improvement loop: fitted isotonic recalibration curves.
-- The recalibrate cron job (.github/workflows/recalibrate.yml) writes a new
-- row weekly per sport. api/edge.js reads the MOST RECENT row per
-- (sport, market) and applies it to every new prediction before returning.
--
-- "Isotonic regression" finds the best monotonic mapping from raw model
-- confidence -> actual hit rate, fitted from historical predictions.
-- It corrects systematic over- or under-confidence (e.g. "we said 95% but
-- the 95% bucket actually hit at 87% -> recalibrate down to ~90%").
--
-- Run once in the Supabase SQL editor.

create table if not exists public.model_calibration (
  id bigint generated always as identity primary key,
  fit_date timestamptz default now(),
  sport text not null,                  -- "AFL" or "NBA"
  market text,                          -- per-market curve in future (Task #100); NULL = global per-sport
  n_samples int not null,
  curve_points jsonb not null,          -- [{x: 0.55, y: 0.58}, {x: 0.65, y: 0.62}, ...]
  rmse numeric                          -- root mean square calibration error (0-1, lower = better)
);

create index if not exists idx_model_cal_sport_market_date
  on public.model_calibration (sport, market, fit_date desc);

alter table public.model_calibration enable row level security;

-- Public read access — the curves aren't sensitive and can be cached
-- aggressively. Writes happen only via the service-role key from the cron.
drop policy if exists "public read model_calibration" on public.model_calibration;
create policy "public read model_calibration"
  on public.model_calibration
  for select
  using (true);
