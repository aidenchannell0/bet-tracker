# Bet Grid — project handoff

A Vite + React + Supabase app on Vercel (**bettracker.tech**): an AFL bet **tracker**
plus an AI **multi builder ("Grid Build")** and a data-backed **Game Analysis**.
This note lets a new session pick up cold.

## Stack & deploy
- **Frontend:** single big file `src/App.jsx` (React 19, Tailwind v4, recharts). Vite build.
- **Backend:** Vercel serverless functions in `api/` (ESM). They only run on Vercel, **not** in `vite dev`.
- **DB/Auth:** Supabase. **Odds:** The Odds API. **AI:** OpenAI (gpt-4.1-mini). **Payments:** Stripe.
- **Deploy:** push to `main` → Vercel auto-deploys. `npm run build` to check locally.
  Always `node --check api/edge.js` + `npm run build` before pushing — the Vite build doesn't validate API files.

## Key files
### Grid Build & analysis
- `api/edge.js` — Grid Build brain + Game Analysis brain. Big file (~2800 lines). Branches by intent
  (multi build, multi edit, game analysis, market stats, event markets, player stats, available games).
  Pulls odds (`/api/event-odds`) + AFL stats (`/api/afl-stats`) + defence factors (`/api/afl-defense`),
  computes implied/edge/correlation-adjusted prob, builds legs, GPT only narrates.
- `api/odds.js`, `api/event-odds.js` — The Odds API wrappers (sport key map, market lists per sport).
- `api/afl-stats.js`, `api/afl-defense.js` — read scraped AFL data from Supabase.
- `api/nba-stats.js` — **NEW (Phase 1 WIP)**, mirrors afl-stats shape; reads from `nba_player_games`.
  Not yet consumed by edge.js — that's the remaining NBA work.
- `scripts/scrape-afl-stats.mjs` — afltables → `afl_player_games` (residential Mac via launchd; see below).
- `scripts/scrape-nba-stats.mjs` — **NEW (Phase 1 WIP)**, balldontlie.io → `nba_player_games`.
  Not IP-blocked, so can run from Vercel cron / GitHub Action (no Mac dependency).
- `api/calibration.js` — leg-level "predicted vs actual" scoreboard (logs every rated leg on build,
  joins to `afl_player_games` to compute hit rates per confidence bucket).
- `api/create-checkout-session.js`, `api/create-portal-session.js`, `api/stripe-webhook.js`,
  `api/entitlement.js` — Stripe subscription billing + portal + entitlement.
- `db/*.sql` — schemas (run once in Supabase SQL editor): `afl_player_games.sql`, `nba_player_games.sql`
  (NEW), `billing.sql`, and the calibration table SQL (the user has run all of these except
  possibly `nba_player_games.sql`).

### Frontend (`src/App.jsx`)
Single file, but key components: `EdgePage` (the build/analysis UI), `EdgeMessage` (sectioned chat
cards), `EdgeDetailToggle` (per-leg detailed form), `MobileBottomNav` (wired across all logged-in
pages with `pb-24 md:pb-0` to clear it), `TeamCrest` (SVG guernsey-style club badges),
`GameAnalysisOutput` (the analysis output cards), `SettingsPage`, `LandingPage`,
`PendingBetsCard`. Theme toggle in Settings; **dark is the default** (see Theme below).

## Supabase tables
- `bets` — user bets (`bookmaker`, `bet_type`, `source` ('manual'|'grid_build'), `status` ('settled'|
  'pending'), `legs` (jsonb)).
- `afl_player_games` — scraped AFL player game logs (~14k rows).
- `nba_player_games` — **NEW**, NBA player game logs from balldontlie. *User must run
  `db/nba_player_games.sql` in Supabase.*
- `profiles` — `subscription_status`, stripe ids, period end (stripe-webhook writes).
- `grid_build_usage` — one row per build, for the weekly free-tier count.
- `grid_build_predictions` — every rated leg logged on build (player, line, predicted prob, etc.),
  joined to `afl_player_games` on read for calibration buckets.

## Env vars (Vercel)
`ODDS_API_KEY` (20K paid plan), `OPENAI_API_KEY`, `SUPABASE_URL`/`VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`,
`STRIPE_WEBHOOK_SECRET`. **For NBA (when ready):** `BALLDONTLIE_API_KEY` (free from balldontlie.io).
Local `.env` (gitignored) holds the same.

## AFL data refresh
afltables.com **blocks datacenter IPs** (Vercel AND GitHub Actions fail), so the scrape runs on the
**owner's Mac** via launchd:
- Plist: `~/Library/LaunchAgents/tech.bettracker.scrape-afl.plist` (6×/day: 8/11/14/17/20/23h).
  Logs to `~/Library/Logs/bettracker-scrape-afl.log`. Reload: `launchctl unload <plist> && launchctl load <plist>`.
- Self-contained copy at `~/.bettracker-cron/` (outside `~/Desktop`, which macOS TCC blocks for
  launchd). **The repo `scripts/scrape-afl-stats.mjs` is the source of truth — re-copy it to
  `~/.bettracker-cron/` if you change it.**
- Data freshness is bounded by *afltables' own posting lag*. Each leg shows "Form as of [date]"
  and turns amber if 10+ days old, so any lag is visible rather than silent.

## What's live (major features shipped)
- **Multi builder**: real form + odds; combo search hits target odds within tolerance; balanced leg
  prices preferred (avoids one-long-leg + filler near-locks); respects requested leg count.
- **Conversational edit-in-place**: chat understands "swap leg 2", "remove the Gawn leg", "make it
  safer", "longer odds", "around $3", "make it 4 legs" — refines the current build via `editAFLMulti`
  rather than rebuilding. Quick-action chips when a build exists.
- **+EV / value signal**: per-leg `edge` (form chance − implied) and a multi-level "Value vs market"
  banner. Inflated value is automatically tempered for same-game multis (see SGM below).
- **Correlation-aware odds**: Gaussian-copula MC (`correlationAdjustedProb`) with a structural
  per-pair matrix (same game + possession-family → +0.28; same game otherwise → +0.10; different
  game → 0). Seeded, deterministic. UI shows "Correlation-adjusted (vs X% if independent)".
- **Matchup adjustment**: per-team defence factors (`/api/afl-defense`) scale historical values.
  For binary/low lines (e.g. "Over 0.5 goals") where value-scaling can't move the number, it falls
  back to a clamped probability-space adjustment so the displayed matchup is truthful.
- **Same-Game Multi (SGM) honesty**: when 2+ legs share a game, a note flags it and the EV uses a
  conservative haircut (0.85^extra legs) on the combined odds — bookmakers SGM-discount these and
  The Odds API only exposes single-leg prices, so the naive product overstates both odds and value.
- **Bookmaker selector**: pin to Sportsbet / TAB / Ladbrokes / Neds / PointsBet / Unibet (default
  Best available). Filters extraction to the chosen book; book-aware "no markets" message and a
  "fewer legs than requested at <book>" note when the choice limits the pool.
- **Form freshness**: every leg shows "Form as of [date]"; turns amber after 10 days.
- **Recent-trend chips**: last-5 values in the detailed form, with the latest game boxed in gold.
- **Lines display as `ceil(line)+`**: "Over 22.5 disposals" → "23+ disposals" everywhere.
- **Odds always 2dp**: `formatOdds` helper applied to every odds display (tiles, combined,
  payout, saved bets, GPT data block).
- **Calibration scoreboard** (`/api/calibration` + UI): logs every leg's predicted prob on build,
  joins to actuals to show "legs we rate 75%+ have hit X%". Honesty lever for trust.
- **Game Analysis** (NEW): switch to the Game Analysis tab, pick a game, get a full structured read:
  market read (favourite + implied %, total line, spread), key players per team (with form, hit rate,
  matchup), standout +edge value plays, matchup angles (top-conceded + best-defended per team), and a
  GPT narrative summary. **AFL only** for now — NBA path will reuse the same flow in Phase 2.
- **Landing page Grid Build showcase**: hero leads with Grid Build, a static example output card
  with team crests + form chips + correlation tag + free-tier CTA. Compliant framing throughout
  (placeholder players, "illustrative example", "informational only").
- **Mobile UI**: bottom tab nav (Home / Add / Build / Settings) wired on all logged-in pages with
  consistent `pb-24` clearance. Recent bets is a tap-to-expand dropdown; Account & feedback sits
  at the very bottom; logout button uses the muted danger palette (no blinding red in dark mode).
  Touch-target sizing on the punch list.
- **Stripe billing portal**: `api/create-portal-session.js` + "Manage subscription" link in the
  Grid Build header for subscribers. Built and deployed — only the go-live activation in the Stripe
  dashboard + env-var swap is pending.

## Theme
**Dark mode is the default.** The toggle in Settings is the only thing that persists a theme — we
write `localStorage["bg-theme"]` *only* on an explicit click. The pre-paint script in `index.html`
mirrors the same check. The legacy key `"theme"` is intentionally ignored — early visitors had
`"light"` auto-written before the default was flipped, which silently stuck them on light. The
fresh key resets everyone to dark except explicit Light choosers.

## Gotchas / decisions
- The Odds API exposes only **headline AFL lines** (~$1.30+), no deep/alternate lines — so a 5-leg
  ~$2 multi often isn't reachable; the builder gets as close as it can and notes it.
- Gating **fails open** on any error; counts only when a real multi is produced; week resets **Monday UTC**.
- Stripe webhook uses raw body (`bodyParser:false`) for signature verification.
- `editAFLMulti` excludes the swapped-out player from the candidate pool (early bug: it was deleting
  the old player from the used set, so the engine swapped a player for himself).
- Empty/unparseable target odds (e.g. "Custom" with a blank field) default to `$2.00` server-side
  so the balanced combo search runs (the no-target fallback used to produce lopsided builds).
- The chat in analysis mode no longer hijacks normal messages — the analysis branch is gated on an
  explicit `context.analysisRequest` flag, not on `mode === "analysis"`.

## Status

### Open #1 — Stripe go-LIVE (manual)
Code is ready. Steps below — all in the Stripe dashboard + Vercel env vars + a redeploy.

### Open #2 — NBA Phase 1 (CODE WIP — pick up here)
The schema, scraper and stats endpoint are committed. **Not yet wired into edge.js.** See the NBA
pickup section below.

### Pending / next
1. **Stripe go-LIVE** — see checklist below.
2. **NBA Phase 1** — finish wiring `edge.js` (see pickup section).
3. **NBA Phase 2** — defence factors + Game Analysis (deferred until Phase 1 is solid).
4. Touch-target sizing pass on mobile.
5. Optional: bet-volume context on charts, rolling win-rate/ROI line, prop-drop alerts.

## NBA pickup (next session — start here for the NBA work)

**Committed (Phase 1, ~half done):**
- `db/nba_player_games.sql` — schema, mirrors `afl_player_games`.
- `scripts/scrape-nba-stats.mjs` — balldontlie → Supabase scraper.
- `api/nba-stats.js` — last-5/last-10 hit rates endpoint (accepts metric *names* like "points",
  translates to columns "pts" internally).

**Pickup work to do in `edge.js` (the meaty part):**
1. **Drop the `sport === "AFL"` gate** on the multi/edit branch (currently around line 2691).
2. **Extend `overMarketKeys` + `metricFromMarket`** in `extractPlayerPropsFromEvent` to include NBA:
   `player_points`, `player_points_over`, `player_rebounds`, `player_rebounds_over`,
   `player_assists`, `player_assists_over`, `player_threes`, `player_threes_over`,
   `player_blocks`, `player_steals` → metrics `points`/`rebounds`/`assists`/`threes`/`blocks`/`steals`.
3. **Extend `METRIC_LABELS`** with the NBA metrics (points/rebounds/assists/threes/blocks/steals).
4. **Extend `POSSESSION_METRICS`** for correlation (NBA pace correlates everything; add the NBA
   metrics so same-game NBA correlation kicks in).
5. **Sport-aware player markets list** for the multi-branch fetch: define
   `PLAYER_MARKETS_BY_SPORT = { AFL: {...}, NBA: {...} }` and use it instead of the hardcoded
   `allAFLPlayerMarkets`. If the sport isn't supported yet, return a clear "sport not supported"
   message.
6. **Sport-aware stats fetch**: add `fetchPlayerStatsContext(req, sport, team1, team2, players, metrics)`
   that picks `/api/nba-stats` for NBA and `/api/afl-stats` for AFL, then use it in place of the
   direct `fetchAFLStatsContext` call in the multi branch.
7. **Only fetch defence factors for AFL** (NBA has no factors yet) — `enrichProps` already accepts
   `factors = null` (neutral matchup).
8. **NBA Game Analysis** — leave the AFL-only guard for now; Phase 2.

**User actions for NBA (must do before NBA actually works):**
1. **Run** `db/nba_player_games.sql` in the Supabase SQL editor.
2. **Get** a free balldontlie API key (sign up at balldontlie.io).
3. **Add** `BALLDONTLIE_API_KEY` to Vercel env vars (and to local `.env` for the scraper).
4. **First backfill**: `set -a; source .env; set +a; node scripts/scrape-nba-stats.mjs`
   (takes ~13 min on free tier, ~1 min on paid). Configure `NBA_DAYS` to control window.
5. **Schedule** the scraper — either a Vercel cron (preferred — no Mac dependency) or a GitHub
   Action (also fine since balldontlie isn't IP-blocked). Daily is plenty.

## Stripe go-live checklist
Run in order. Code is already deployed; only env vars + Stripe dashboard steps remain.

**In the Stripe dashboard:**
1. Activate account: business details (category *Sports forecasting or prediction services*), bank
   account, identity verification.
2. Switch to **Live mode** (toggle top-left).
3. Products → Create product → "Grid Build Pro" → Add price → Recurring, Weekly, A$4.99. Copy the
   new live `price_xxx` ID.
4. Developers → Webhooks → Add endpoint:
   - URL: `https://bettracker.tech/api/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`. Copy the live `whsec_xxx` signing secret.
5. Settings → Billing → **Customer portal** → Activate portal (cancel + update card). Required for
   the "Manage subscription" link to work.

**In Vercel (bettracker.tech project → Settings → Environment Variables):**
6. `STRIPE_SECRET_KEY` → `sk_live_xxx`
7. `STRIPE_PRICE_ID` → live `price_xxx`
8. `STRIPE_WEBHOOK_SECRET` → live `whsec_xxx`
9. **Redeploy** (Vercel doesn't auto-redeploy on env-var change).

**Verify:**
10. Subscribe with a real card → confirm webhook fires → `subscription_status = 'active'`.
11. Click "Manage subscription" → portal opens → cancel → status reverts.
12. Refund the test charge in Stripe (Payments → Refund).

## Pricing
Free tier = 3 Grid Build builds/week. Subscription = weekly (test product set at A$4.99/wk).
Edits don't consume a build credit (refining an existing build is free even for free-tier users).

## Style/voice
- Compliant framing throughout: "structured example multis", "informational analysis only", "not
  betting advice or a tips service", "18+ · Gamble responsibly". Important both ethically and for
  ad-platform policies (Snapchat/Google traffic — gambling-ad rules are strict).
- AI narration must never invent: no injuries, no scores, no head-to-head history, no venue/weather.
  The "What I would check" section is where un-modellable stuff (team news, late mail, line moves)
  gets flagged honestly.
