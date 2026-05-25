// Per-team defensive factors for the current AFL season: how much each team
// concedes in each stat vs the league average. Opponent is derived from the two
// teams present in every game_code (no opponent column needed). Used to adjust a
// player's hit-rate for the specific opponent they're about to face.
//
// factor[team][metric] = (avg metric by players FACING team) / (league avg).
//   > 1  => team concedes more than average on that stat (good for an "over")
//   < 1  => team is stingy on that stat
// Fails open (returns no factors) so the build still works if stats are missing.

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const METRIC_COLUMNS = [
  "kicks", "marks", "handballs", "disposals", "goals",
  "behinds", "hitouts", "tackles", "clearances", "fantasy_points",
];

const MIN_GAMES = 3;        // need a few games vs a team before trusting its factor
const CLAMP = 0.15;         // cap adjustment at +/-15% to tame small samples
const CACHE_MS = 1000 * 60 * 30;

// Warm-invocation cache (per serverless instance)
let cache = { season: null, at: 0, payload: null };

async function latestSeason() {
  const { data } = await supabase
    .from("afl_player_games")
    .select("season")
    .order("season", { ascending: false })
    .limit(1);
  return data?.[0]?.season || new Date().getFullYear();
}

async function fetchSeasonRows(season) {
  const cols = `game_code,team,${METRIC_COLUMNS.join(",")}`;
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("afl_player_games")
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

function computeFactors(rows) {
  // Distinct teams per game so we can read off each player's opponent
  const gameTeams = new Map();
  for (const r of rows) {
    if (!gameTeams.has(r.game_code)) gameTeams.set(r.game_code, new Set());
    gameTeams.get(r.game_code).add(r.team);
  }

  const leagueSum = {}, leagueCount = {};
  for (const m of METRIC_COLUMNS) { leagueSum[m] = 0; leagueCount[m] = 0; }
  const conceded = {}; // team -> metric -> { sum, count, games:Set }

  for (const r of rows) {
    const teams = [...(gameTeams.get(r.game_code) || [])];
    const opp = teams.length === 2 ? teams.find((t) => t !== r.team) : null;
    for (const m of METRIC_COLUMNS) {
      const v = r[m];
      if (v == null) continue;
      leagueSum[m] += v; leagueCount[m] += 1;
      if (opp) {
        conceded[opp] = conceded[opp] || {};
        conceded[opp][m] = conceded[opp][m] || { sum: 0, count: 0, games: new Set() };
        conceded[opp][m].sum += v;
        conceded[opp][m].count += 1;
        conceded[opp][m].games.add(r.game_code);
      }
    }
  }

  const leagueAvg = {};
  for (const m of METRIC_COLUMNS) leagueAvg[m] = leagueCount[m] ? leagueSum[m] / leagueCount[m] : null;

  const factors = {};
  for (const [team, byMetric] of Object.entries(conceded)) {
    factors[team] = {};
    for (const m of METRIC_COLUMNS) {
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
    leagueAvg: Object.fromEntries(METRIC_COLUMNS.map((m) => [m, leagueAvg[m] != null ? Number(leagueAvg[m].toFixed(1)) : null])),
    gamesAnalysed: gameTeams.size,
    teams: Object.keys(factors).length,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!supabase) return res.status(200).json({ available: false, factors: {} });

  try {
    const season = await latestSeason();
    if (cache.payload && cache.season === season && Date.now() - cache.at < CACHE_MS) {
      return res.status(200).json({ available: true, season, cached: true, ...cache.payload });
    }

    const rows = await fetchSeasonRows(season);
    if (!rows.length) return res.status(200).json({ available: false, season, factors: {} });

    const payload = computeFactors(rows);
    cache = { season, at: Date.now(), payload };
    return res.status(200).json({ available: true, season, ...payload });
  } catch (error) {
    console.error("afl-defense error:", error);
    return res.status(200).json({ available: false, factors: {}, error: error.message });
  }
}
