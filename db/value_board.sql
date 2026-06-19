-- Value board cache: the top value player props across the slate, precomputed so the
-- feed never re-rates the whole slate on a page view (player-prop odds cost API credits).
-- One row per sport; the board JSON is the ranked list of cards. Refreshed on read when
-- older than the TTL (see getValueBoard in api/edge.js). Run once in the Supabase SQL editor.

create table if not exists public.value_board (
  sport text primary key,            -- 'AFL' (NBA later)
  board jsonb not null default '[]',  -- [{player,label,confidence,edgePct,line,last5Values,odds,bookmaker,analysis,...}]
  computed_at timestamptz default now()
);

-- Writes only via the service-role key (bypasses RLS). No public read policy — the feed is
-- served (and gated free/Pro) through the edge endpoint, not read directly by the client.
alter table public.value_board enable row level security;
