// Reads AFL player game-by-game stats from the Supabase `afl_player_games` table
// (populated out-of-band by scripts/scrape-afl-stats.mjs via a scheduled GitHub Action).
// Computes recent hit-rate values per metric. Fast and reliable — no live scraping.

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const METRIC_COLUMNS = [
  "kicks",
  "marks",
  "handballs",
  "disposals",
  "goals",
  "behinds",
  "hitouts",
  "tackles",
  "clearances",
  "fantasy_points",
];

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
    return res.status(500).json({ error: "Supabase is not configured for AFL stats." });
  }

  try {
    const players = String(req.query.players || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 40);

    const metrics = String(req.query.metrics || "disposals")
      .split(",")
      .map((m) => m.trim())
      .filter((m) => METRIC_COLUMNS.includes(m))
      .slice(0, 10);

    if (!players.length) {
      return res.status(400).json({ error: "At least one player name is required" });
    }
    if (!metrics.length) {
      return res.status(400).json({ error: "No valid metrics provided" });
    }

    const keys = [...new Set(players.map(nameKey).filter(Boolean))];

    const { data, error } = await supabase
      .from("afl_player_games")
      .select(`name_key,player_name,team,game_date,${metrics.join(",")}`)
      .in("name_key", keys)
      .order("game_date", { ascending: false })
      .limit(40 * keys.length);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Group rows by name_key (already ordered most-recent first)
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
        const values = rows
          .map((r) => r[metric])
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
      available: anyAvailable,
      players: playerSummaries,
      gamesAnalysed: maxGames,
      source: "AFL Tables (cached in Supabase)",
    });
  } catch (error) {
    console.error("AFL stats error:", error);
    return res.status(500).json({
      error: "Could not load AFL stats.",
      detail: error.message,
    });
  }
}
