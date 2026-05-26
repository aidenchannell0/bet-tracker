// Per-team defensive factors for the current season: how much each team concedes
// in each stat vs the league average. Sport-aware — dispatches AFL vs NBA off the
// `sport` query param. Opponent is derived from the two teams present in every
// game key (game_code for AFL, game_id for NBA) so no opponent column is needed.
// Used to adjust a player's hit-rate for the specific opponent they're about to
// face. Fails open (returns no factors) so the build still works if stats are
// missing.
//
// factor[team][metric] = (avg metric by players FACING team) / (league avg).
//   > 1  => team concedes more than average on that stat (good for an "over")
//   < 1  => team is stingy on that stat

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const SPORT_CONFIG = {
  AFL: {
    table: "afl_player_games",
    gameKey: "game_code",
    // metric name → DB column (identity for AFL)
    metrics: {
      kicks: "kicks",
      marks: "marks",
      handballs: "handballs",
      disposals: "disposals",
      goals: "goals",
      behinds: "behinds",
      hitouts: "hitouts",
      tackles: "tackles",
      clearances: "clearances",
      fantasy_points: "fantasy_points",
    },
  },
  NBA: {
    table: "nba_player_games",
    gameKey: "game_id",
    metrics: {
      points: "pts",
      rebounds: "reb",
      assists: "ast",
      threes: "fg3m",
      blocks: "blk",
      steals: "stl",
    },
  },
};

const MIN_GAMES = 3;        // need a few games vs a team before trusting its factor
const CLAMP = 0.15;         // cap adjustment at +/-15% to tame small samples
const CACHE_MS = 1000 * 60 * 30;

// Warm-invocation cache keyed by sport (per serverless instance)
const cache = new Map(); // sport -> { season, at, payload }

async function latestSeason(config) {
  const { data } = await supabase
    .from(config.table)
    .select("season")
    .order("season", { ascending: false })
    .limit(1);
  return data?.[0]?.season || new Date().getFullYear();
}

async function fetchSeasonRows(config, season) {
  const metricCols = Object.values(config.metrics);
  const cols = `${config.gameKey},team,${metricCols.join(",")}`;
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(config.table)
      .select(cols)
      .eq("season", season)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

function computeFactors(config, rows) {
  const metricNames = Object.keys(config.metrics);
  const colByMetric = config.metrics;

  // Distinct teams per game so we can read off each player's opponent
  const gameTeams = new Map();
  for (const r of rows) {
    const key = r[config.gameKey];
    if (!gameTeams.has(key)) gameTeams.set(key, new Set());
    gameTeams.get(key).add(r.team);
  }

  const leagueSum = {}, leagueCount = {};
  for (const m of metricNames) { leagueSum[m] = 0; leagueCount[m] = 0; }
  const conceded = {}; // team -> metric -> { sum, count, games:Set }

  for (const r of rows) {
    const teams = [...(gameTeams.get(r[config.gameKey]) || [])];
    const opp = teams.length === 2 ? teams.find((t) => t !== r.team) : null;
    for (const m of metricNames) {
      const v = r[colByMetric[m]];
      if (v == null) continue;
      leagueSum[m] += v; leagueCount[m] += 1;
      if (opp) {
        conceded[opp] = conceded[opp] || {};
        conceded[opp][m] = conceded[opp][m] || { sum: 0, count: 0, games: new Set() };
        conceded[opp][m].sum += v;
        conceded[opp][m].count += 1;
        conceded[opp][m].games.add(r[config.gameKey]);
      }
    }
  }

  const leagueAvg = {};
  for (const m of metricNames) {
    leagueAvg[m] = leagueCount[m] ? leagueSum[m] / leagueCount[m] : null;
  }

  const factors = {};
  for (const [team, byMetric] of Object.entries(conceded)) {
    factors[team] = {};
    for (const m of metricNames) {
      const c = byMetric[m];
      const la = leagueAvg[m];
      if (!c || c.games.size < MIN_GAMES || !la) { factors[team][m] = 1; continue; }
      let f = c.sum / c.count / la;
      f = Math.max(1 - CLAMP, Math.min(1 + CLAMP, f));
      factors[team][m] = Number(f.toFixed(3));
    }
  }

  return {
    factors,
    leagueAvg: Object.fromEntries(
      metricNames.map((m) => [m, leagueAvg[m] != null ? Number(leagueAvg[m].toFixed(1)) : null])
    ),
    gamesAnalysed: gameTeams.size,
    teams: Object.keys(factors).length,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!supabase) return res.status(200).json({ available: false, factors: {} });

  const sport = String(req.query.sport || "AFL").toUpperCase();
  const config = SPORT_CONFIG[sport];
  if (!config) {
    return res.status(400).json({ error: `Unsupported sport: ${sport}`, available: false, factors: {} });
  }

  try {
    const season = await latestSeason(config);
    const cached = cache.get(sport);
    if (cached && cached.season === season && Date.now() - cached.at < CACHE_MS) {
      return res.status(200).json({ sport, available: true, season, cached: true, ...cached.payload });
    }

    const rows = await fetchSeasonRows(config, season);
    if (!rows.length) return res.status(200).json({ sport, available: false, season, factors: {} });

    const payload = computeFactors(config, rows);
    cache.set(sport, { season, at: Date.now(), payload });
    return res.status(200).json({ sport, available: true, season, ...payload });
  } catch (error) {
    console.error(`${sport} defense error:`, error);
    return res.status(200).json({ sport, available: false, factors: {}, error: error.message });
  }
}
