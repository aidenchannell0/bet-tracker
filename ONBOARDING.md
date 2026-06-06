# MultiPick — project handoff

A Vite + React + Supabase app on Vercel (**bettracker.tech**): an AFL + NBA bet
**tracker** plus an AI **multi builder ("MultiPick")** and a data-backed
**Game Analysis** (AFL only — NBA Game Analysis is Phase 2). This note lets a
new session pick up cold.

## Stack & deploy
- **Frontend:** single big file `src/App.jsx` (React 19, Tailwind v4, recharts). Vite build.
- **Backend:** Vercel serverless functions in `api/` (ESM). They only run on Vercel, **not** in `vite dev`.
- **DB/Auth:** Supabase. **Odds:** The Odds API. **AI:** OpenAI (gpt-4.1-mini). **Payments:** Stripe.
- **Deploy:** push to `main` → Vercel auto-deploys. `npm run build` to check locally.
  Always `node --check api/edge.js` + `npm run build` before pushing — the Vite build doesn't validate API files.

## Key files
### MultiPick & analysis
- `api/edge.js` — MultiPick brain + Game Analysis brain. Big file (~2900 lines). Branches by intent
  (multi build, multi edit, game analysis, market stats, event markets, player stats, available games).
  Sport-aware: pulls odds (`/api/event-odds`) + player stats (`/api/stats?sport=...`) + defence
  factors (`/api/defense?sport=...`), computes implied/edge/correlation-adjusted prob, builds legs,
  GPT only narrates. `PLAYER_MARKETS_BY_SPORT` + `TEAM_ALIAS_MAP` cover AFL, NRL (teams only), NBA.
- `api/odds.js`, `api/event-odds.js` — The Odds API wrappers (sport key map, market lists per sport).
- `api/stats.js` — sport-aware player game-stats endpoint. Dispatches AFL vs NBA via `?sport=` to
  the matching Supabase table (`afl_player_games` / `nba_player_games`). Returns uniform last-5 /
  last-10 hit rates + averages. Replaced the per-sport `afl-stats.js` + `nba-stats.js`.
- `api/defense.js` — sport-aware per-team defensive factors (how much each team concedes per stat
  vs league avg). Dispatches via `?sport=`. Opponent derived from the two teams in each game key
  (`game_code` for AFL, `game_id` for NBA). Replaces `afl-defense.js`.
- `scripts/scrape-afl-stats.mjs` — afltables → `afl_player_games` (residential Mac via launchd; see below).
- `scripts/scrape-nba-stats.mjs` — balldontlie.io → `nba_player_games`. Runs daily via
  `.github/workflows/scrape-nba.yml` (also `workflow_dispatch` for manual runs). balldontlie isn't
  IP-blocked, so GHA is reliable — no Mac dependency. Workflow needs three repo secrets:
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BALLDONTLIE_API_KEY`. Note: the workflow file
  currently exists as `main.yml` on `main` (named via GitHub web UI when the PAT lacked workflow
  scope) — content is identical to the committed `scrape-nba.yml`; rename later when convenient.
- `api/calibration.js` — leg-level "predicted vs actual" scoreboard (logs every rated leg on build,
  joins to `afl_player_games` to compute hit rates per confidence bucket — NBA calibration is on
  the punch-list, not wired yet).
- `api/create-checkout-session.js`, `api/create-portal-session.js`, `api/stripe-webhook.js`,
  `api/entitlement.js` — Stripe subscription billing + portal + entitlement.
- `db/*.sql` — schemas (run once in Supabase SQL editor): `afl_player_games.sql`,
  `nba_player_games.sql`, `billing.sql`, `grid_build_predictions.sql`. **Vercel Hobby plan caps
  serverless functions at 12 per deploy** — the sport-aware merges above are what keeps us under
  that limit. Adding a 13th `api/*.js` will fail the build.

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
- `nba_player_games` — NBA player game logs from balldontlie (~36k rows, 180-day window). Backfill
  is a manual one-shot (`NBA_DAYS=180 node scripts/scrape-nba-stats.mjs`); daily incremental top-ups
  are handled by the GitHub Action.
- `profiles` — `subscription_status`, stripe ids, period end (stripe-webhook writes).
- `grid_build_usage` — one row per build, for the weekly free-tier count.
- `grid_build_predictions` — every rated leg logged on build (player, line, predicted prob, etc.),
  joined to `afl_player_games` on read for calibration buckets.

## Env vars (Vercel)
`ODDS_API_KEY` (The Odds API, **$30/mo / 20K credits** — note the free tier is 500 credits and
gets blown through fast once player-prop builds run), `OPENAI_API_KEY`, `SUPABASE_URL`/`VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`,
`STRIPE_WEBHOOK_SECRET`, `BALLDONTLIE_API_KEY` (balldontlie.io **ALL-STAR plan**, $9.99 USD/mo — the
free tier does NOT include `/stats` despite earlier docs suggesting it does). Local `.env`
(gitignored) holds the same. GitHub Actions needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`BALLDONTLIE_API_KEY` as repo secrets (same values).

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
- **Matchup adjustment**: per-team defence factors (`/api/defense?sport=...`) scale historical
  values. Sport-aware — AFL factors derived from `afl_player_games`, NBA from `nba_player_games`,
  both clamped to ±15% to tame small samples. For binary/low lines (e.g. "Over 0.5 goals") where
  value-scaling can't move the number, it falls back to a clamped probability-space adjustment so
  the displayed matchup is truthful.
- **Sport-aware MultiPick**: AFL and NBA both flow through the same extract → enrich → select
  pipeline. NBA player markets fetched via `PLAYER_MARKETS_BY_SPORT.NBA` (single-key markets like
  `player_points` — Over/Under live as outcomes within each, no `_over` variants). NBA team aliases
  in `TEAM_ALIAS_MAP` ("spurs", "okc", "phoenix") so edit-in-place works for NBA too.
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
- **Game Analysis**: switch to the Game Analysis tab, pick a game, get a full structured read:
  market read (favourite + implied %, total line, spread), key players per team (with form, hit rate,
  matchup), standout +edge value plays, matchup angles (top-conceded + best-defended per team), and a
  GPT narrative summary. **AFL only** — NBA path will reuse the same flow in Phase 2.
- **Landing page MultiPick showcase**: hero leads with MultiPick, a static example output card
  with team crests + form chips + correlation tag + free-tier CTA. Compliant framing throughout
  (placeholder players, "illustrative example", "informational only").
- **Mobile UI**: bottom tab nav (Home / Add / Build / Settings) wired on all logged-in pages with
  consistent `pb-24` clearance. Recent bets is a tap-to-expand dropdown; Account & feedback sits
  at the very bottom; logout button uses the muted danger palette (no blinding red in dark mode).
  Touch-target sizing on the punch list.
- **Stripe billing portal**: `api/create-portal-session.js` + "Manage subscription" link in the
  MultiPick header for subscribers. Built and deployed — only the go-live activation in the Stripe
  dashboard + env-var swap is pending.

## Theme
**Dark mode is the default.** The toggle in Settings is the only thing that persists a theme — we
write `localStorage["bg-theme"]` *only* on an explicit click. The pre-paint script in `index.html`
mirrors the same check. The legacy key `"theme"` is intentionally ignored — early visitors had
`"light"` auto-written before the default was flipped, which silently stuck them on light. The
fresh key resets everyone to dark except explicit Light choosers.

## Gotchas / decisions
- The Odds API exposes only **headline lines** (~$1.30+ for AFL, ~$1.59+ for NBA via PointsBet —
  same constraint, different floor). No deep/alternate lines. So a 3-leg NBA multi targeting $2.00
  can't reach the target (cheapest 3-leg combo on PointsBet via API is ~$4.12); the builder gets
  as close as it can and notes the overshoot. `selectOptimalLegs` was tuned to prefer
  closeness-to-target over `prob` once the tight tolerance band falls through (bucketed $0.50
  `diff` ranks above `balance`/`prob`).
- **NBA player markets are single-key** in The Odds API (`player_points` etc. with Over/Under as
  outcomes inside each market — no `player_points_over`). Sending an unknown key rejects the whole
  request with `INVALID_MARKET`. AFL has both forms legitimately.
- **Vercel Hobby plan caps serverless functions at 12 per deploy.** That's why we merged
  `afl-stats.js` + `nba-stats.js` → `stats.js` and `afl-defense.js` → `defense.js`. Adding a 13th
  `api/*.js` will fail the build.
- Gating **fails open** on any error; counts only when a real multi is produced; week resets **Monday UTC**.
- Stripe webhook uses raw body (`bodyParser:false`) for signature verification.
- `editAFLMulti` (sport-agnostic despite the name — works for NBA too) excludes the swapped-out
  player from the candidate pool (early bug: it was deleting the old player from the used set,
  so the engine swapped a player for himself).
- Empty/unparseable target odds (e.g. "Custom" with a blank field) default to `$2.00` server-side
  so the balanced combo search runs (the no-target fallback used to produce lopsided builds).
- The chat in analysis mode no longer hijacks normal messages — the analysis branch is gated on an
  explicit `context.analysisRequest` flag, not on `mode === "analysis"`.

## Status

### Open #1 — Stripe go-LIVE (manual)
Code is ready. Steps below — all in the Stripe dashboard + Vercel env vars + a redeploy.

### Pending / next
1. **Stripe go-LIVE** — see checklist below.
2. **NBA Phase 2** — NBA Game Analysis (mirror the AFL analysis branch but feed it sport-aware
   stats + defence factors that already exist). Probably ~2–4 hours.
3. **NBA calibration** — `grid_build_predictions` joins to `afl_player_games` on read; should
   also join to `nba_player_games` when `sport='NBA'` so NBA legs show up in the scoreboard.
4. Touch-target sizing pass on mobile.
5. Optional: bet-volume context on charts, rolling win-rate/ROI line, prop-drop alerts,
   wider AFL alternate-line source (premium odds provider).

## NBA Phase 1 — what's live (reference, no action needed)

NBA MultiPick is shipped end-to-end. Same flow as AFL: extract player props from The Odds API,
enrich with form (last-5/last-10 hit rates from `nba_player_games`) and matchup factors
(per-team conceded-vs-league via `/api/defense?sport=NBA`), select balanced combo near target,
return with correlation-adjusted prob and SGM haircut. Notes:

- **Data window**: 180 days backfilled (~36k rows / ~1042 games / all 30 teams). Daily
  incremental refresh via `.github/workflows/scrape-nba.yml` at 06:00 UTC keeps it fresh.
- **Cheap-line floor**: The Odds API doesn't expose PointsBet's deep alternates (sub-$1.50 lines
  like "SGA 1+ assist") — only one line per player per market. Floor for a 3-leg NBA combo is
  ~$4.12 on PointsBet right now. Targeting $2.00 isn't achievable in 3 legs; the builder lands
  closest available and flags the overshoot.
- **Defence factors**: NBA factors compute from the same `game_id`-trick as AFL — derive the
  opponent from the two distinct teams in each game. ±15% clamp prevents small-sample noise.
- **Edit-in-place**: works for NBA. `editAFLMulti` is sport-agnostic despite the name. NBA
  team aliases added to `TEAM_ALIAS_MAP` so "remove the Spurs leg" / "swap the OKC leg" resolve.

If NBA data ever needs to be re-bootstrapped from scratch (new prod, new Supabase project,
etc.):

1. `db/nba_player_games.sql` in Supabase SQL editor.
2. `BALLDONTLIE_API_KEY` in Vercel + local `.env` + GitHub repo secrets (must be on the ALL-STAR
   $9.99/mo tier or higher — `/stats` is paid-only).
3. One-shot backfill: `set -a; source .env; set +a; BALLDONTLIE_GAP_MS=1100 NBA_DAYS=180 node
   scripts/scrape-nba-stats.mjs` (~5 min on ALL-STAR).
4. Confirm the GitHub Action has its three repo secrets (SUPABASE_URL,
   SUPABASE_SERVICE_ROLE_KEY, BALLDONTLIE_API_KEY) and the daily cron is enabled.

## Stripe go-live checklist
Run in order. Code is already deployed; only env vars + Stripe dashboard steps remain.

**In the Stripe dashboard:**
1. Activate account: business details (category *Sports forecasting or prediction services*), bank
   account, identity verification.
2. Switch to **Live mode** (toggle top-left).
3. Products → Create product → "MultiPick Pro" → Add price → Recurring, Weekly, A$4.99. Copy the
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
Free tier = 3 MultiPick builds/week. Subscription = weekly (test product set at A$4.99/wk).
Edits don't consume a build credit (refining an existing build is free even for free-tier users).

## Style/voice
- Compliant framing throughout: "structured example multis", "informational analysis only", "not
  betting advice or a tips service", "18+ · Gamble responsibly". Important both ethically and for
  ad-platform policies (Snapchat/Google traffic — gambling-ad rules are strict).
- AI narration must never invent: no injuries, no scores, no head-to-head history, no venue/weather.
  The "What I would check" section is where un-modellable stuff (team news, late mail, line moves)
  gets flagged honestly.

---

## 2026-06-01 session (huge — read this first)

Big chunky session. ~30 commits. Three sweeping themes:

### 1. Brand + payments locked in
- **Pickd. wordmark** is the canonical brand (`brand-wordmark` CSS class, Inter Tight,
  lime accent dot). Live everywhere — TopNav, AuthScreen, favicon, landing hero.
  Reference designs in `logo-concepts.html`.
- **Stripe live** — Pickd Pro product live, end-to-end test purchase succeeded, webhook
  verified. Env vars in Vercel + Supabase tables (`profiles`, `grid_build_usage`) ready.
  `api/create-checkout-session.js`, `api/stripe-webhook.js`, `api/create-portal-session.js`,
  `api/entitlement.js` all wired.
- **Promo codes**: `allow_promotion_codes: true` is already on Checkout. Create codes in
  Stripe dashboard → automatically work.

### 2. UI overhaul (desktop AND mobile)
- **Landing page** fully rebuilt in editorial dark style (`LandingPage` in App.jsx).
  Hero / dashboard mock / MultiPick showcase / "What's inside" / pricing / FAQ /
  final CTA. References in `mobile-concepts.html`, `calibration-simple.html`.
- **Mobile Dashboard**: hero stat + horizontal carousel + quick add + recent feed
  (`md:hidden` block at the top of the dashboard, hides desktop stat strip on small).
- **Mobile Tracker**: tappable cards expanding to full leg detail (achievement pills,
  WON/LOST placeholders, real game stats fetched from `*_player_games`). Shared
  `renderBetExpansion(bet, isOpen)` helper inside the tracker IIFE — both mobile
  cards and desktop table use the same render path.
- **Mobile Settings**: editorial divided sections with 44px tap targets, danger zone
  uses brand tokens.
- **Stat detail modal**: clicking P/L / Win rate / ROI / In flight opens a portal-rendered
  full-screen modal with the relevant chart. Hover sparklines on each cell.
- **Leg achievement pills**: lime bars ending in a rounded pill showing actual game
  stat from `*_player_games`. Falls back to "Won/Lost" placeholder when actuals
  haven't been scraped yet. Per-game chronological dots with glow on most-recent.
- **AFL team crests**: refreshed all 18 guernsey patterns. MultiPick now uses
  `TeamCrest` (circular) not `TeamTile` (square). NBA teams fall through to a
  tile-palette rendered in a circle.
- **Form freshness badge**: AFL legs show "Form this round / last round / N rounds
  ago" instead of days. NBA stays in days.

### 3. Model improvements
- **Calibration block** simplified to a 3-cell strip (Actual / Predicted / Gap) + lime
  Well-calibrated pill + "View calibration detail →" link → portal modal with full
  bucket-by-bucket table. Plain-English explainer for casual users.
- **Recalibration loop** (#99 ✅): `scripts/recalibrate.mjs` fits per-sport AND
  per-market isotonic curves (PAV) from `grid_build_predictions` joined with
  `*_player_games`. Stored in new `model_calibration` table (run
  `db/model_calibration.sql` in Supabase). `.github/workflows/recalibrate.yml`
  runs Sundays 18:00 UTC. `api/edge.js` `loadCalibrationCurve(sport)` → bundle of
  global + markets → `pickCurveForMetric` per leg → applied in `enrichProps`.
  Falls through to raw empirical when no curve loaded yet (cold start safety).
- **Per-market calibration** (#100 ✅): each market (disposals, goals, points, etc.)
  gets its own curve when it has ≥50 resolved samples. Falls back to global per-sport.
- **Rest-days feature** (#103 ✅): `restDays` computed from `matched.lastGameDate`,
  multiplier ±4% on empirical (≤4d short rest 0.96, 7-9d fresh 1.02, ≥14d stale 0.96).
  Exposed on leg payload as `restDays` + `restFactor`.

### 🚨 URGENT BUG (Task #106) — investigate first
**MultiPick was selecting absurd legs and rating them at 67% confidence with 0/10
hit rate.** Example: Joel Amartey 6+ goals at $31 with 0/10 hits → 67% confidence.
Combined odds rendered at $27,869 for a $2.00 target. Value % showed +598,222%.

**Shipped interim safeguard** (commit `1b01204`): `selectOptimalLegs` now filters
out any leg where `hr10.hits === 0 && hr10.total >= 5`. Hard floor, NOT a real fix.

**Real bug is somewhere in `enrichProps`'s empirical math** — most likely
`fairProbFromOverUnder` returning weird values when `underOdds` is missing for
high-odds niche markets, or the EB prior collapsing. To debug:
1. Pick a specific broken leg (Joel Amartey 6+ goals, $31 PointsBet)
2. Log `hr5`, `hr10`, `impliedRaw`, `implied`, `empBase`, `empScaled`, `matchupFactor`,
   final `empirical` for that leg
3. Trace which step blows it up
4. The bug is pre-existing — NOT caused by today's recalibration work (those changes
   are no-ops when no curve is loaded, which is currently the case)

### Setup steps user still needs to do
- **`db/model_calibration.sql`** — run the SQL in Supabase to create the
  `model_calibration` table
- **Manually trigger first recalibrate** at
  `https://github.com/aidenchannell0/bet-tracker/actions/workflows/recalibrate.yml`
- **Verify AFL cron caught the every-6h schedule** (was once-daily before
  the recent web-UI edit; check Actions runs page in 24h)

### Pinned for next sessions
- **#106** URGENT — broken confidence on 0/10 legs (real fix, not just the safeguard)
- **#76-#81** Marketing prep — UTM, promo codes, launch posts, public calibration page,
  shareable multi cards, referral codes, weekly newsletter
- **#63-#68** Betslip OCR upgrades — gpt-4o, bonus bet detection, review step,
  mobile camera, settled-slip detection, leg-to-player matching
- **#102** Drop poorly-calibrated markets (data-dependent — wait until recalibrate
  has run a few times to see which markets have high error)
- **#104** Home/away splits (needs venue scraping)
- **#105** Real ML model (only after ~500 resolved predictions)

---

## 2026-06-03 session (large — marketing + model + onboarding)

### ✅ #106 RESOLVED — the real root cause
The 0/10-leg "67% confidence" bug was **`applyCalibrationCurve` clamping out-of-range
inputs to the boundary y**. The fitted AFL curve starts ~(0.63, 0.67), so every leg with
raw empirical < 0.63 got mapped to 67%+ (disposals curve started ~0.80 → 80%). The math
was honest; the calibration layer was the liar. Fix: return `x` unchanged outside the
fitted domain (commit `d44a4d6`). Plus 3 defensive layers in `enrichProps`: isOver
extraction rejects `outcome.name==="Under"`; prior fallback chain implied→impliedRaw→0.5;
15% evidence ceiling on `hr10.hits===0 && total>=5`. Verified Amartey 67%→1.8%.
Root cause follow-up still open: `grid_build_predictions` only logs *selected* legs
(empirical ≥ minHit), so curve domain is narrow — log ALL rated legs to widen it (chip
was spawned).

### MultiPick model tuning (all in `api/edge.js` `selectOptimalLegs`/`selectLegsForProfile`)
- **Raw hit-rate floors** by profile: Safer ≥9/10, Balanced ≥7/10, Aggressive none (was
  confidence-only).
- **Team diversity**: soft penalty for pure single-team stacks (`teamCapAllowed = max(2, legs-1)`)
  + per-team shortlist quota (≥4 candidates/team) so the combo search has cross-team options.
- **% tolerance bands** (5/10/15/20/30/50% of target) + % diff buckets — fixes builds
  landing far from target at higher odds.
- **Safer/Aggressive prefer balance, Balanced prefers prob**; **min combined-prob floor**
  (Safer 0.80, Balanced 0.50) drives the relax chain.
- **"Best Chance" 4th profile** — pure max-prob, no floors/penalties (frontend dropdown too).
- **SGM haircut 0.85→0.92** per extra same-game leg (0.85 wiped real edge → negative EV).
- Sport selector limited to **AFL/NBA** only.

### UX / app
- **Build animation**: canvas hybrid sphere (`BuildingAnimation`) in EdgePage output while
  building; traveling lime beam border; fires on every Build (`buildingMulti` flag);
  Mode-B stagger-cascade reveal; rAF cleanup + reduced-motion. `bare`/`minimal` props for a
  decorative version used in the dashboard empty state ("Build your first multi").
- **Compact tap-to-expand legs** (`EdgeLegRow`) — replaced always-expanded rows + the old
  `EdgeDetailToggle` (removed).
- **Onboarding tour** (`OnboardingTour`) — 5-step, real feature mockups, captures first name;
  only auto-shows for accounts created <24h ago + not seen (localStorage per-user). Replay in
  Settings.
- **First name** via `user_metadata.first_name` (signup field + tour); dashboard greets
  "Welcome back, {name}."
- **"I used Pickd" checkbox** on add-bet forms → tags manual bets `source:'grid_build'` so
  they count in MultiPick performance.
- **Login bug fix**: `activePage` stuck on "auth" left the dashboard half-rendered → reset to
  "app" on login.
- **Dashboard login fix** + calibration block title ("MultiPick. hit rate").

### 💰 Paywall + founding promo (revenue)
- **Paywall modal** (`Paywall`) — free users hit it at the weekly limit (`previewMulti`
  blocks when `gatedNow`; server `gated:true` also opens it). Gating was correct server-side
  but the frontend never blocked.
- **Founding promo — LIVE**: first **20 subscribers** lock in **A$4.99/wk forever** (then
  A$6.99). Stripe coupon **`rxLndYx4`** (A$2.00 off AUD, duration forever, max 20 redemptions),
  env var **`STRIPE_FOUNDING_COUPON=rxLndYx4`** is set in Vercel. `create-checkout-session`
  applies it when active subs < 20; `entitlement` returns `foundingSpotsLeft` (gated on the
  coupon env so the UI never over-promises). Paywall + landing show $4.99 ~~$6.99~~ + spots +
  "🔒 Locked in forever".
- Price corrected $4.99→$6.99 earlier (landing already had $6.99).

### 🤖 pickd-content skill (`.claude/skills/pickd-content/`)
On-brand social content generator: SKILL.md + references/brand-kit.md (tokens, AFL crest
SVGs, component snippets) + references/formats.md (reel/carousel/story scaffolds, captions).
Invoke `/pickd-content <request>`. **Compliance baked in: analysis tool not tips, 18+/helpline,
no winnings claims. TikTok extra rule: NO money ladder/odds/$ — use a form "streak" instead;
"leg"/"slip" OK.**

### 🎬 Marketing assets (root .html, screen-record targets)
`tiktok-launch-video.html` (promo reel, has odds — IG only), `instagram-launch-post.html`
(4-slide carousel), `tiktok-formcheck-video.html`, `tiktok-form-ladder-w1.html`,
`tiktok-form-streak.html` (TikTok-safe — form streak ladder, Crows v Cats real multi,
head-to-head stats, AI-analytics intro, TikTok safe-zone layout, 🎬 record mode).
Launch reel + IG carousel posted; TikTok promo was removed (gambling promo) then restored on
appeal — pivoted TikTok content to **stats/form framing** (no odds/$/bet/multi).

### Marketing learnings (important)
- **TikTok bans gambling promotion** — money ladders ($10→$10k), odds, "build a multi" CTAs
  get removed/banned. Frame as **sports stats / player form**; product is a "form tool",
  betting lives behind the bio link.
- **Paid ads are closed** (TikTok/Meta/Google need gambling-advertiser authorization/licence;
  rejected on landing-page review; ban risk for the Stripe-linked business). **Creator/influencer
  partnerships are the real paid lever.**
- IG tolerated the betting-explicit reel; TikTok did not.

### Pending / next
- **Marketing grind**: shorter (12–18s) cuts, consistency, creator-page outreach (DM template
  was the next ask), seed early engagement. New posts ~54 views/0 likes (cold-start + possible
  post-strike throttle).
- **Log all rated legs** to `grid_build_predictions` (widen calibration domain — the proper
  #106 follow-up).
- NBA Game Analysis (Phase 2); NBA calibration join; touch-targets.
- `db/model_calibration.sql` + first recalibrate run still pending from 2026-06-01.

---

## 2026-06-06 session (large — builder UX overhaul, billing fix, ML data, infra)

Big UX + plumbing session. All shipped to `main`. Git now pushes over **SSH** (see Infra).

### Dashboard mini-builder (the new front door to MultiPick)
- **`multipickBuilderCard`** (const in App, rendered in two spots: mobile hero under the stat
  row + desktop left column) — eyebrow + "Build a multi." + a horizontal **games scroller**
  (`TeamCrest` + VS + tip-off + countdown from `/api/odds`, **multi-select** with a lime ✓) +
  a compact **Sport / Legs / Odds / Risk** row + **Bookmaker** + "Make the multi".
- **Smooth deep-link handoff**: `goBuildMulti` stashes `edgePrefill` ({sport, gameIds, legs,
  targetOdds, riskProfile, bookmaker, autoBuild}), fades the dashboard out (`page-leaving`),
  flips to EdgePage which lazy-inits from the prefill and **auto-fires the build** once games
  load (ref-guarded, 4.5s fallback). `BuildingAnimation` sphere shows while building.
- **DEV-only `devSampleGames(sport)`** seeds the scroller in `vite dev` (no `/api/odds` locally);
  dead-code-eliminated from prod via `import.meta.env.DEV`.
- Defaults now **Legs = Any, Odds = $2.00, Risk = Best Chance**. Odds has a **Custom** option →
  free-type number input (`mpOddsCustom`).

### MultiPick page (EdgePage) — now uses the same card
- The old stacked `EdgeSelectField` form was **replaced by the dashboard-style card on all
  breakpoints** (controls column widened to `lg:grid-cols-[460px_1fr]`, card `max-w-[460px]`,
  `grid-cols-2 sm:grid-cols-4`). Custom odds + Optional request preserved inside the card.
  `selectedGameIds` (multi-select) drives it; `previewMulti({gameIds})`.

### Multi-game builds (api/edge.js)
- Build spreads across **multiple chosen games**: `context.gameIds` resolved to `specificGames`
  (up to 4), `gamesUsed` cap scales with the count. Single-game + "all slate" unchanged.

### "Best Chance" = max combined chance (api/edge.js `selectLegsForProfile`)
- Within the **target-odds tolerance band + chosen leg count**, sorts **prob-first** (highest
  combined chance) instead of closest-to-target. (First tried ignoring odds entirely — reverted;
  user wants best chance *for the odds/legs you pick*.)

### Add-bet UX (src/App.jsx)
- Betslip upload made **prominent** (lime card, camera icon, Upload button); manual entry
  collapsed into an **"Or add manually"** expander (auto-opens on edit / after a slip parses).
- **"I used MultiPick for this bet"** (was "Pickd."). **Betslip-uploaded bets now store legs**
  (OCR `{player,line,odds,game}` → MultiPick leg shape w/ combined `name`), so pending bets show
  the leg breakdown. Betslip cleared on `resetBetForm` so legs don't leak.
- **"Bet saved · tap to see" toast** (portal, auto-dismiss 5s) → opens the bet in Tracker.
- **Edit from Tracker** now `setActivePage("app")` first → jumps to the dashboard edit form.

### Display / correctness
- Wrong-team legs fixed: `matchStatsForProp` now needs **full first name** (not just initial —
  was binding "Luke McDonald" to another "L. McDonald"); plus `EdgeLegRow` **crest guard** (only
  render a club that's actually in the leg's game, else neutral).
- Leg **line coloured lime** ("12+ disposals") and split from the player name so it isn't
  truncated on mobile. Chance pill uses an accurate reduced ratio (`chanceRatio`: 87% → ~9 in 10).
- Mobile: lifted builder card under the stat row, **deleted the Quick-add panel**, moved Recent
  activity below Add-bet. `min-w-0` on builder grid columns fixed mobile horizontal-overflow zoom.

### 💰 Billing / Pro upsells
- **Stripe checkout was broken** ("No such customer: cus_…") — a **test-mode customer id** stored
  in `profiles` from earlier testing 404'd under live keys. `create-checkout-session` now
  **verifies the stored customer and recreates it** if missing/deleted; founding-coupon failure
  **falls back** to a no-coupon session; real Stripe error is surfaced to the client.
- **Dismissible "Go Pro" strip** on the dashboard (free users; `localStorage proStripDismissed`)
  + MultiPick header **"Go Pro" pill** (was the plain "Upgrade" link). App-level `startUpgrade`.
- **`1WEEKFREE` Stripe coupon** created (100% off, once, hand-out code for friends).

### 🤖 ML data — log ALL rated legs (#105 / #106 follow-up — DONE)
- Each build now logs the **full enriched pool** to `grid_build_predictions`, not just selected
  legs — covers the model's low-confidence ratings, widening the calibration curve domain (was
  only 60–100%, the cause of the old #106 clamping). Rows tagged **`selected`**.
- **Display** (`/api/calibration`, the "picks hit rate") filters **`selected = true`** so the
  headline stays about real picks; **recalibrate uses all rows**. Both have back-compat
  fallbacks if the column is missing. **Migration run:** `db/grid_build_predictions_add_selected.sql`.
- As of this session: **120 resolved / 325 logged** (selected). #105 ML model fires at ~500
  *resolved*; full pool now accrues ~30–40 legs/build so it'll climb fast. To watch the full
  set: `select count(*) total, count(*) filter (where selected) picks from grid_build_predictions;`

### 🔧 Infra
- **Git switched to SSH** (`git@github.com:aidenchannell0/bet-tracker.git`) — the classic PAT
  `bet-tracker-token` was expiring. Key at `~/.ssh/id_ed25519` (no passphrase). PAT can lapse;
  Actions + scrapers use repo secrets, not it.

### Pending / next (carried + new)
- Social posts (was wrapping up the session to do these fresh). Marketing grind continues.
- NBA Game Analysis (Phase 2); NBA calibration join; touch-targets.
- `db/model_calibration.sql` + first recalibrate run still pending from 2026-06-01.
- Possible: friendlier "couldn't start checkout" copy (currently surfaces raw Stripe text);
  add custom odds to wherever still preset-only; tune builder column width if 460px feels wide.
