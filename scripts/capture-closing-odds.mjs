// Closing-odds capture for CLV. Near kickoff, re-fetches the market price for
// every logged prediction whose game is about to start and writes it into
// grid_build_predictions.closing_odds (refreshed each run until the game begins,
// so the final value ≈ the true closing line).
//
// Strategy: "near-kickoff sweep" — only touches games commencing within the next
// CLV_WINDOW_HOURS (default 4), and only fetches the markets actually needed for
// that game's logged legs, so Odds API credit use stays small.
//
//   1. Load recently-logged predictions (last LOOKBACK_DAYS) → group by sport + game.
//   2. Pull the free events list per sport, keep games starting within the window.
//   3. For each window game that has logged legs, fetch ONLY the needed player
//      markets, parse the best Over price per (name_key, metric, line).
//   4. Match to logged legs and write closing_odds + closing_captured_at.
//
// Env: SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY, ODDS_API_KEY
//      CLV_WINDOW_HOURS (default 4), CLV_DRY_RUN=1 (fetch + match, don't write)
// Run: node scripts/capture-closing-odds.mjs

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const oddsKey = process.env.ODDS_API_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!oddsKey) {
  console.error("Missing ODDS_API_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const BASE = "https://api.the-odds-api.com/v4";
const WINDOW_HOURS = Number(process.env.CLV_WINDOW_HOURS) || 4;
const LOOKBACK_DAYS = 12; // only recent legs — their games are the ones still upcoming
const DRY_RUN = process.env.CLV_DRY_RUN === "1";

const SPORT_KEY = { AFL: "aussierules_afl", NBA: "basketball_nba" };

const AFL_METRICS = new Set([
  "disposals", "goals", "marks", "kicks", "handballs",
  "tackles", "hitouts", "clearances", "behinds", "fantasy_points",
]);
const NBA_METRIC_MAP = {
  pts: "pts", points: "pts", reb: "reb", rebounds: "reb", ast: "ast", assists: "ast",
  fg3m: "fg3m", threes: "fg3m", stl: "stl", steals: "stl", blk: "blk", blocks: "blk",
};
function metricSport(metric) {
  if (AFL_METRICS.has(metric)) return "AFL";
  if (NBA_METRIC_MAP[metric]) return "NBA";
  return null;
}

// metric → the Odds API market key(s) to request for it (mirrors edge.js).
const METRIC_MARKETS = {
  AFL: {
    disposals: ["player_disposals_over"],
    goals: ["player_goals_scored_over"],
    marks: ["player_marks_over"],
    tackles: ["player_tackles_over"],
    fantasy_points: ["player_afl_fantasy_points_over"],
    clearances: ["player_clearances_over"],
    kicks: ["player_kicks_over"],
    handballs: ["player_handballs_over"],
  },
  NBA: {
    points: ["player_points", "player_points_alternate"],
    rebounds: ["player_rebounds", "player_rebounds_alternate"],
    assists: ["player_assists", "player_assists_alternate"],
    threes: ["player_threes", "player_threes_alternate"],
    blocks: ["player_blocks", "player_blocks_alternate"],
    steals: ["player_steals", "player_steals_alternate"],
  },
};
// market key → metric (mirrors edge.js extractPlayerPropsFromEvent)
const metricFromMarket = {
  player_disposals_over: "disposals", player_goals_scored_over: "goals",
  player_marks_over: "marks", player_tackles_over: "tackles",
  player_afl_fantasy_points_over: "fantasy_points", player_clearances_over: "clearances",
  player_kicks_over: "kicks", player_handballs_over: "handballs",
  player_points: "points", player_rebounds: "rebounds", player_assists: "assists",
  player_threes: "threes", player_blocks: "blocks", player_steals: "steals",
  player_points_alternate: "points", player_rebounds_alternate: "rebounds",
  player_assists_alternate: "assists", player_threes_alternate: "threes",
  player_blocks_alternate: "blocks", player_steals_alternate: "steals",
};

// Same firstInitial_surname key edge.js logs with — so live players match logged legs.
function nameKey(full) {
  const words = String(full || "").toLowerCase().replace(/[^a-z\s]/g, "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return `${words[0][0]}_${words[words.length - 1]}`;
}

async function getEvents(sport) {
  const r = await fetch(`${BASE}/sports/${SPORT_KEY[sport]}/events?apiKey=${oddsKey}`);
  if (!r.ok) { console.warn(`  events fetch failed for ${sport}: ${r.status}`); return []; }
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

async function getEventOdds(sport, eventId, markets) {
  const url = new URL(`${BASE}/sports/${SPORT_KEY[sport]}/events/${eventId}/odds`);
  url.searchParams.set("apiKey", oddsKey);
  url.searchParams.set("regions", "au");
  url.searchParams.set("markets", markets.join(","));
  url.searchParams.set("oddsFormat", "decimal");
  url.searchParams.set("dateFormat", "iso");
  const r = await fetch(url.toString());
  const remaining = r.headers.get("x-requests-remaining");
  const data = await r.json();
  return { ok: r.ok, data, remaining, status: r.status };
}

// Best (highest) Over price per `${name_key}|${metric}|${line}` across all books.
function parseBestOver(event) {
  const best = new Map();
  for (const bm of event?.bookmakers || []) {
    for (const m of bm.markets || []) {
      const metric = metricFromMarket[m.key];
      if (!metric) continue;
      for (const o of m.outcomes || []) {
        const player = o.description || o.name;
        if (!player || player === "Over" || player === "Under") continue;
        const price = Number(o.price);
        if (!price || price <= 1) continue;
        if (o.point == null) continue;
        const isUnder = o.name === "Under";
        const isOver = o.name === "Over" || (!isUnder && m.key.includes("_over"));
        if (!isOver) continue;
        const k = `${nameKey(player)}|${metric}|${Number(o.point)}`;
        const cur = best.get(k);
        if (cur == null || price > cur) best.set(k, price);
      }
    }
  }
  return best;
}

async function fetchRecentPredictions(sinceIso) {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("grid_build_predictions")
      .select("id,name_key,metric,line,game_label,odds")
      .eq("selected", true) // CLV is about actual picks, not the full rated pool
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Closing-odds capture${DRY_RUN ? " (DRY RUN)" : ""} · window ${WINDOW_HOURS}h`);
  // The closing_odds columns are a manual migration — bail cleanly (not a hard
  // failure) if they're not there yet, so the cron isn't noisy before setup.
  const probe = await supabase.from("grid_build_predictions").select("closing_odds").limit(1);
  if (probe.error && !DRY_RUN) {
    console.warn("closing_odds column not found — run db/grid_build_predictions_add_closing.sql in Supabase first. Skipping.");
    return;
  }

  const now = Date.now();
  const windowEnd = now + WINDOW_HOURS * 3600 * 1000;
  const sinceIso = new Date(now - LOOKBACK_DAYS * 86400000).toISOString();

  const preds = await fetchRecentPredictions(sinceIso);
  console.log(`Loaded ${preds.length} predictions from the last ${LOOKBACK_DAYS} days.`);
  if (!preds.length) return;

  let totalCaptured = 0;
  let gamesProcessed = 0;

  for (const sport of ["AFL", "NBA"]) {
    const sportPreds = preds.filter((p) => metricSport(p.metric) === sport && METRIC_MARKETS[sport][p.metric]);
    if (!sportPreds.length) continue;

    const events = await getEvents(sport);
    const inWindow = events.filter((e) => {
      const t = Date.parse(e.commence_time);
      return Number.isFinite(t) && t > now && t <= windowEnd;
    });
    if (!inWindow.length) {
      console.log(`${sport}: no games starting in the next ${WINDOW_HOURS}h.`);
      continue;
    }
    const byLabel = new Map(inWindow.map((e) => [`${e.home_team} vs ${e.away_team}`, e]));

    // Group this sport's legs by game, keeping only games that are in the window.
    const games = new Map();
    for (const p of sportPreds) {
      if (!byLabel.has(p.game_label)) continue;
      if (!games.has(p.game_label)) games.set(p.game_label, []);
      games.get(p.game_label).push(p);
    }
    if (!games.size) {
      console.log(`${sport}: ${inWindow.length} game(s) in window, none with logged legs.`);
      continue;
    }

    for (const [label, legs] of games) {
      const ev = byLabel.get(label);
      const metrics = [...new Set(legs.map((p) => p.metric))];
      const markets = [...new Set(metrics.flatMap((m) => METRIC_MARKETS[sport][m] || []))];
      if (!markets.length) continue;

      const { ok, data, remaining, status } = await getEventOdds(sport, ev.id, markets);
      gamesProcessed += 1;
      if (!ok) {
        console.warn(`  ${sport} · ${label}: odds fetch failed (${status}: ${data?.message || "?"})`);
        continue;
      }
      const best = parseBestOver(data);

      let captured = 0;
      for (const p of legs) {
        const price = best.get(`${p.name_key}|${p.metric}|${Number(p.line)}`);
        if (price == null) continue;
        if (!DRY_RUN) {
          const { error } = await supabase
            .from("grid_build_predictions")
            .update({ closing_odds: price, closing_captured_at: new Date().toISOString() })
            .eq("id", p.id);
          if (error) { console.warn(`    update failed (id ${p.id}): ${error.message}`); continue; }
        }
        captured += 1;
      }
      totalCaptured += captured;
      console.log(`  ${sport} · ${label}: ${captured}/${legs.length} legs captured  (credits left ${remaining ?? "?"})`);
    }
  }

  console.log(`\nDone. ${gamesProcessed} game(s) processed · ${totalCaptured} closing prices ${DRY_RUN ? "matched (not written)" : "written"}.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Capture failed:", error);
    process.exit(1);
  });
