-- NBA player game-by-game stats, populated by scripts/scrape-nba-stats.mjs
-- (sourced from balldontlie.io — not IP-blocked, so the scraper can run from a
-- Vercel cron OR a GitHub Action, no Mac uptime dependency like AFL).
-- Run this once in the Supabase SQL editor.

create table if not exists public.nba_player_games (
  id bigint generated always as identity primary key,
  game_id bigint not null,           -- balldontlie game id
  player_id bigint not null,         -- balldontlie player id
  game_date date not null,
  season int not null,
  player_name text not null,
  name_key text not null,            -- "firstinitial_surname", e.g. l_james
  team text,
  pts int default 0,                 -- points
  reb int default 0,                 -- total rebounds
  ast int default 0,                 -- assists
  fg3m int default 0,                -- three-pointers made
  stl int default 0,                 -- steals
  blk int default 0,                 -- blocks
  min text,                          -- balldontlie returns minutes as "32:14"
  created_at timestamptz default now(),
  unique (game_id, player_id)
);

create index if not exists idx_nba_player_games_name_key on public.nba_player_games (name_key);
create index if not exists idx_nba_player_games_date on public.nba_player_games (game_date desc);

-- Public stats: allow read access; writes happen only via the service-role key (bypasses RLS).
alter table public.nba_player_games enable row level security;

drop policy if exists "public read nba_player_games" on public.nba_player_games;
create policy "public read nba_player_games"
  on public.nba_player_games
  for select
  using (true);
