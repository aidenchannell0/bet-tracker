-- Per-multi log: one row for every multi a user actually builds with MultiPick.
-- Unlike grid_build_predictions (which dedupes legs across users/builds for calibration),
-- this is NOT deduped — it keeps each user's each build intact, so the private founder
-- view can compute real per-multi, per-user win/loss. Player-prop legs only (those are
-- the legs we can resolve against game logs).
--
-- Outcomes are resolved on read (api/founder-stats.js) by joining each leg to the
-- player's next game in afl_player_games / nba_player_games — no resolver job needed.
-- A multi WON iff every leg hit its line; LOST if any resolved leg missed; PENDING until
-- all legs have a game to resolve against.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.grid_build_multis (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  user_id uuid,                      -- who built it (null if unauthenticated)
  sport text,                        -- 'afl', 'nba', etc. (best-effort)
  leg_count int not null,
  combined_odds numeric,             -- total decimal odds of the built multi
  predicted_prob numeric,            -- our combined (shrunk) probability 0-1 at build time
  profile text,                      -- tier: 'Best Chance' | 'Balanced' | 'Aggressive'
  target_odds numeric,               -- the user's target odds, if any
  legs jsonb not null                -- [{player_name,name_key,metric,line,predicted_prob,odds,game_label}]
);

create index if not exists idx_gbm_user on public.grid_build_multis (user_id);
create index if not exists idx_gbm_created on public.grid_build_multis (created_at desc);

-- Writes happen only via the service-role key (bypasses RLS). Keep the table private
-- (no public/select policy): the founder view is served server-side and gated to the
-- founder's account, and it aggregates everyone's results.
alter table public.grid_build_multis enable row level security;
