-- AFL player game-by-game stats, populated by scripts/scrape-afl-stats.mjs
-- (run on a schedule via .github/workflows/scrape-afl.yml).
-- Run this once in the Supabase SQL editor.

create table if not exists public.afl_player_games (
  id bigint generated always as identity primary key,
  game_code text not null,
  game_date date not null,
  season int not null,
  player_name text not null,
  name_key text not null,          -- "firstinitial_surname", e.g. p_dangerfield (fuzzy match)
  team text,
  kicks int default 0,
  marks int default 0,
  handballs int default 0,
  disposals int default 0,
  goals int default 0,
  behinds int default 0,
  hitouts int default 0,
  tackles int default 0,
  clearances int default 0,
  fantasy_points int default 0,
  created_at timestamptz default now(),
  unique (game_code, player_name)
);

create index if not exists idx_afl_player_games_name_key on public.afl_player_games (name_key);
create index if not exists idx_afl_player_games_date on public.afl_player_games (game_date desc);

-- Public stats: allow read access; writes happen only via the service-role key (bypasses RLS).
alter table public.afl_player_games enable row level security;

drop policy if exists "public read afl_player_games" on public.afl_player_games;
create policy "public read afl_player_games"
  on public.afl_player_games
  for select
  using (true);
