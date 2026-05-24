# Bet Grid — project handoff

A Vite + React + Supabase app on Vercel (**bettracker.tech**): an AFL bet **tracker**
plus an AI **multi builder ("Grid Build")**. This note lets a new session pick up cold.

## Stack & deploy
- **Frontend:** single big file `src/App.jsx` (React 19, Tailwind v4, recharts). Vite build.
- **Backend:** Vercel serverless functions in `api/` (ESM). They only run on Vercel, **not** in `vite dev`.
- **DB/Auth:** Supabase. **Odds:** The Odds API. **AI:** OpenAI (gpt-4.1-mini). **Payments:** Stripe.
- **Deploy:** push to `main` → Vercel auto-deploys. `npm run build` to check locally.

## Key files
- `api/edge.js` — Grid Build brain. Detects intent; pulls upcoming games (`/api/odds`) + player props
  (`/api/event-odds`, best price across bookmakers) + AFL stats (`/api/afl-stats`); a **math engine**
  computes implied prob, recent-form hit rate (Laplace-smoothed), edge, and selects legs to hit the
  **target odds within ±$0.20** by flexing leg count; GPT only narrates. Honours a market filter
  ("disposals only"), a chosen game, and leg/odds/risk parsed from the message. **Usage-gated**
  (3 free builds/week; subscribers unlimited).
- `api/odds.js`, `api/event-odds.js` — The Odds API wrappers (sport key map, AFL player markets).
- `api/afl-stats.js` — reads player game logs from Supabase `afl_player_games`, computes last5/last10
  hit-rate values per metric. Matches players by `name_key` (first-initial + surname).
- `scripts/scrape-afl-stats.mjs` — scrapes afltables.com → Supabase (cheerio). Skips stored games
  (paginated), dedupes players per game.
- `api/create-checkout-session.js`, `api/stripe-webhook.js`, `api/entitlement.js` — Stripe subscription
  billing + entitlement.
- `db/*.sql` — schema (run in Supabase SQL editor): `afl_player_games.sql`, `billing.sql`.

## Supabase tables
- `bets` — user bets. Added cols: `bookmaker`, `bet_type`, `source` ('manual'|'grid_build'),
  `status` ('settled'|'pending'), `legs` (jsonb).
- `afl_player_games` — per-player per-game stat lines (the scraped AFL data; ~14k rows).
- `profiles` — `subscription_status` ('free'|'active'|…), stripe ids, period end. (Stripe webhook writes.)
- `grid_build_usage` — one row per build, for the weekly free-tier count.

## Env vars (Vercel)
`ODDS_API_KEY` (20K paid plan), `OPENAI_API_KEY`, `SUPABASE_URL`/`VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`,
`STRIPE_WEBHOOK_SECRET`. Local `.env` (gitignored) holds the same for the scraper.

## AFL data refresh (important)
afltables.com **blocks datacenter IPs** (Vercel AND GitHub Actions fail). So the scrape runs from a
**residential/AU IP — the owner's Mac** via macOS **launchd**:
- Plist: `~/Library/LaunchAgents/tech.bettracker.scrape-afl.plist` (daily 9am + 6pm).
- Runs a **self-contained copy** at `~/.bettracker-cron/` (outside `~/Desktop`, which macOS TCC blocks
  for launchd). **The repo `scripts/scrape-afl-stats.mjs` is the source of truth — re-copy it to
  `~/.bettracker-cron/` if you change it.**
- The Supabase cache means afltables downtime only delays the refresh; users always see last-good data.
- The GitHub Action `.github/workflows/scrape-afl.yml` exists but **does not work** (datacenter block);
  kept for reference. Manual local run: `set -a; source .env; set +a; node scripts/scrape-afl-stats.mjs`.

## Gotchas / decisions
- The Odds API exposes only **headline AFL lines** (~$1.30+), no deep/alternate lines — so a 5-leg
  ~$2 multi often isn't reachable; the builder gets as close as it can and notes it.
- Gating **fails open** on any error; counts only when a real multi is produced; week resets **Monday UTC**.
- Stripe webhook uses raw body (`bodyParser:false`) for signature verification.

## Status
**Live & working:** data pipeline, Grid Build math, tracker loop (save multi → pending → settle →
scoreboard), dashboard (cumulative profit + drawdown, breakdowns by sport/odds/bet-type, polished
charts), free-tier gating, Stripe subscription **in TEST mode** (full checkout→webhook→unlock verified).

Billing portal endpoint (`api/create-portal-session.js`) and "Manage subscription" link (shown to
subscribers in the Grid Build header bar) are built — need Stripe Customer Portal enabled in the
Stripe dashboard and live keys deployed to go live.

## Pending / next
1. **Stripe go-LIVE** — see checklist below. Code is ready; only env vars + Stripe dashboard steps needed.
2. Optional polish: bet-volume context on charts, rolling win-rate/ROI line; other dashboard ideas.
3. Consider an always-on AU box for the scrape if Mac-uptime becomes an issue.

## Stripe go-live checklist
Run these steps in order. All code is already deployed once env vars are swapped.

**In the Stripe dashboard:**
1. Activate account: fill in business details (category: *Sports forecasting or prediction services*),
   bank account, identity verification.
2. Switch to **Live mode** (toggle top-left).
3. Products → Create product → "Grid Build Pro" → Add price → Recurring, Weekly, A$4.99.
   Copy the new live `price_xxx` ID.
4. Developers → Webhooks → Add endpoint:
   - URL: `https://bettracker.tech/api/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
   Copy the live `whsec_xxx` signing secret.
5. Settings → Billing → **Customer portal** → Activate portal (enable cancellation + update payment method).
   *(Required for the "Manage subscription" link to work.)*

**In Vercel (bettracker.tech project → Settings → Environment Variables):**
6. Update `STRIPE_SECRET_KEY` → `sk_live_xxx`
7. Update `STRIPE_PRICE_ID` → live `price_xxx` from step 3
8. Update `STRIPE_WEBHOOK_SECRET` → live `whsec_xxx` from step 4
9. **Redeploy**: Vercel doesn't auto-redeploy on env var change — go to Deployments → Redeploy latest.

**Verify:**
10. Subscribe with a real card → confirm webhook fires → profiles.subscription_status = 'active'.
11. Click "Manage subscription" → portal opens → cancel → confirm status reverts to 'canceled'.
12. Refund the test charge via Stripe dashboard (Payments → find charge → Refund).

## Pricing
Free tier = 3 Grid Build builds/week. Subscription = weekly (test product set at A$4.99/wk; revisit —
earlier analysis leaned ~$3–4/wk + freemium).
