-- AFL role / positional matchup notes, populated by scripts/ingest-matchups.mjs
-- (run weekly via .github/workflows/matchup-intel.yml). Each note is grounded in a
-- REAL preview article (source_url, enforced in code) and round-stamped so it
-- auto-expires once the round passes. Soft, cited context — the builder applies it
-- as a small capped nudge, never as hard math.
-- Run this once in the Supabase SQL editor.

create table if not exists public.afl_matchup_notes (
  id bigint generated always as identity primary key,
  season int not null,
  round int not null,
  game text,                         -- "Home vs Away"
  player_name text not null,
  name_key text not null,            -- "firstinitial_surname" (matches afl_player_games)
  team text,
  metric text default 'general',     -- disposals | marks | goals | tackles | general
  direction text default 'neutral',  -- up | down | neutral  (effect on that metric)
  summary text not null,             -- one factual line, e.g. "Drawing the run-with tag from Hewett"
  source_url text not null,          -- the preview the note came from (required)
  confidence text default 'low',     -- high | medium | low
  created_at timestamptz default now(),
  unique (season, round, name_key, summary)
);

create index if not exists idx_afl_matchup_round on public.afl_matchup_notes (season, round);
create index if not exists idx_afl_matchup_namekey on public.afl_matchup_notes (name_key);

-- Public read; writes only via the service-role key (bypasses RLS).
alter table public.afl_matchup_notes enable row level security;

drop policy if exists "public read afl_matchup_notes" on public.afl_matchup_notes;
create policy "public read afl_matchup_notes"
  on public.afl_matchup_notes
  for select
  using (true);
