-- Billing / entitlement + Grid Build usage. Run once in the Supabase SQL editor.

-- One row per user: their subscription state (written by the Stripe webhook via service key).
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  subscription_status text not null default 'free',  -- 'free' | 'active' | 'past_due' | 'canceled'
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz default now()
);

alter table public.profiles enable row level security;
drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles for select using (auth.uid() = user_id);

-- One row per Grid Build generation, for counting the weekly free allowance.
create table if not exists public.grid_build_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists idx_gbu_user_created on public.grid_build_usage (user_id, created_at desc);

alter table public.grid_build_usage enable row level security;
drop policy if exists "own usage read" on public.grid_build_usage;
create policy "own usage read" on public.grid_build_usage for select using (auth.uid() = user_id);

-- Writes to both tables happen only via the service-role key (the API / Stripe webhook),
-- which bypasses RLS. Users can read their own rows for the in-app usage counter.
