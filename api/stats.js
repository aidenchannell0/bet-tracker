// Sport-aware player game-stats endpoint. Replaces the per-sport endpoints —
// dispatches AFL vs NBA off the `sport` query param, queries the matching
// Supabase table, and returns a uniform { available, players, gamesAnalysed,
// source } shape so edge.js can consume both without branching.
//
// AFL columns are stored under their metric names (disposals, kicks, ...) so
// the lookup is identity. NBA columns are short (pts, reb, ast, ...), so we
// translate metric → column on query and present results back under the
// metric name.

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const SPORT_CONFIG = {
  AFL: {
    table: "afl_player_games",
    source: "AFL Tables (cached in Supabase)",
    defaultMetric: "disposals",
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
    source: "balldontlie.io (cached in Supabase)",
    defaultMetric: "points",
    metrics: {
      points: "pts",
      rebounds: "reb",
      assists: "ast",
      threes: "fg3m",
      steals: "stl",
      blocks: "blk",
    },
  },
};

function nameKey(full) {
  const words = String(full || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  return `${words[0][0]}_${words[words.length - 1]}`;
}

function avg(arr) {
  if (!arr.length) return null;
  return Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!supabase) {
    return res.status(500).json({ error: "Supabase is not configured for stats." });
  }

  const sport = String(req.query.sport || "AFL").toUpperCase();
  const config = SPORT_CONFIG[sport];
  if (!config) {
    return res.status(400).json({ error: `Unsupported sport: ${sport}` });
  }

  try {
    const players = String(req.query.players || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 40);

    const metrics = String(req.query.metrics || config.defaultMetric)
      .split(",")
      .map((m) => m.trim())
      .filter((m) => config.metrics[m])
      .slice(0, 10);

    if (!players.length) {
      return res.status(400).json({ error: "At least one player name is required" });
    }
    if (!metrics.length) {
      return res.status(400).json({ error: "No valid metrics provided" });
    }

    const keys = [...new Set(players.map(nameKey).filter(Boolean))];
    const columns = metrics.map((m) => config.metrics[m]);

    const { data, error } = await supabase
      .from(config.table)
      .select(`name_key,player_name,team,game_date,${columns.join(",")}`)
      .in("name_key", keys)
      .order("game_date", { ascending: false })
      .limit(40 * keys.length);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const byKey = new Map();
    for (const row of data || []) {
      if (!byKey.has(row.name_key)) byKey.set(row.name_key, []);
      byKey.get(row.name_key).push(row);
    }

    let maxGames = 0;
    const playerSummaries = players.map((player) => {
      const rows = byKey.get(nameKey(player)) || [];
      maxGames = Math.max(maxGames, rows.length);

      const metricsOut = {};
      for (const metric of metrics) {
        const col = config.metrics[metric];
        const values = rows
          .map((r) => r[col])
          .filter((v) => v !== null && v !== undefined);

        if (!values.length) {
          metricsOut[metric] = { available: false };
          continue;
        }

        const last5 = values.slice(0, 5);
        const last10 = values.slice(0, 10);
        metricsOut[metric] = {
          available: true,
          gamesAnalysed: values.length,
          recentAvg: avg(last5),
          avg10: avg(last10),
          seasonAvg: avg(values),
          last5Values: last5,
          last10Values: last10,
        };
      }

      return {
        player,
        team: rows[0]?.team || null,
        lastGameDate: rows[0]?.game_date || null,
        metrics: metricsOut,
      };
    });

    const anyAvailable = playerSummaries.some((p) =>
      Object.values(p.metrics).some((m) => m.available)
    );

    return res.status(200).json({
      sport,
      available: anyAvailable,
      players: playerSummaries,
      gamesAnalysed: maxGames,
      source: config.source,
    });
  } catch (error) {
    console.error(`${sport} stats error:`, error);
    return res.status(500).json({
      error: `Could not load ${sport} stats.`,
      detail: error.message,
    });
  }
}
