import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : null;

function getSafeString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function splitPlayers(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  if (!supabase) {
    return res.status(500).json({
      error: "Supabase is not configured for player stats.",
    });
  }

  try {
    const sport = getSafeString(req.query.sport, "AFL");
    const metric = getSafeString(req.query.metric, "fantasy_points");
    const players = splitPlayers(req.query.players);

    let query = supabase
      .from("player_stats")
      .select("*")
      .eq("sport", sport)
      .eq("metric", metric)
      .order("created_at", { ascending: false });

    if (players.length) {
      query = query.in("player_name", players);
    }

    const { data, error } = await query.limit(30);

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    return res.status(200).json({
      sport,
      metric,
      requestedPlayers: players,
      available: Boolean(data?.length),
      source: "Supabase player_stats table",
      players: data || [],
    });
  } catch (error) {
    return res.status(500).json({
      error: "Could not load player stats.",
      detail: error.message,
    });
  }
}