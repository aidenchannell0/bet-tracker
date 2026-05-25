-- Calibration log: every leg Grid Build rates when a multi is produced, so we can
-- later compare our predicted probabilities against what actually happened.
-- Outcomes are resolved on read (api/calibration.js) by joining to afl_player_games
-- (the player's next game after the prediction), so no separate resolver job is needed.
-- Run once in the Supabase SQL editor.

create table if not exists public.grid_build_predictions (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  user_id uuid,
  player_name text not null,
  name_key text not null,           -- "firstinitial_surname" to match afl_player_games
  metric text not null,             -- disposals, goals, ...
  line numeric not null,            -- the over line
  predicted_prob numeric not null,  -- our confidence (0-1) at build time
  odds numeric,                     -- offered decimal odds at build time
  game_label text,
  season int,
  -- One row per leg per round: collapses the same leg predicted across many builds
  dedupe_key text not null unique
);

create index if not exists idx_gbp_name_key on public.grid_build_predictions (name_key);
create index if not exists idx_gbp_created on public.grid_build_predictions (created_at desc);

-- Writes happen only via the service-role key (bypasses RLS). Keep the table private
-- (no public read policy): calibration is computed server-side and returned aggregated.
alter table public.grid_build_predictions enable row level security;
