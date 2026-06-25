-- Confirmed AFL lineups, scraped from footywire team selections, round-by-round.
-- Powers: (1) dropping props for players who aren't named, (2) the sponge factor
-- (a key mid OUT → beneficiaries boosted), (3) the "late mail" read.
-- Run this once in the Supabase SQL editor.
create table if not exists afl_lineups (
  season      int  not null,
  round       int  not null,
  name_key    text not null,
  player_name text not null,
  club        text,
  status      text not null default 'named',   -- 'named' | 'emergency'
  scraped_at  timestamptz not null default now(),
  primary key (season, round, name_key)
);
create index if not exists afl_lineups_round_idx on afl_lineups (season, round);
