#!/bin/bash
# Daily AFL stats refresh. Run by the macOS launchd job
# (~/Library/LaunchAgents/tech.bettracker.scrape-afl.plist) or by hand.
# Scrapes afltables (needs a residential/AU IP) and upserts into Supabase.

cd "$(dirname "$0")/.." || exit 1

# Load env (SUPABASE_URL / VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
set -a
[ -f .env ] && . ./.env
set +a

echo "[$(date '+%Y-%m-%d %H:%M:%S')] AFL refresh starting"
node scripts/scrape-afl-stats.mjs
status=$?
echo "[$(date '+%Y-%m-%d %H:%M:%S')] AFL refresh finished (exit ${status})"
exit ${status}
