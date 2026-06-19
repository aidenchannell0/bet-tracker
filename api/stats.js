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

function nameWords(full) {
  return String(full || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function nameKey(full) {
  const words = nameWords(full);
  if (!words.length) return "";
  return `${words[0][0]}_${words[words.length - 1]}`;
}

// Whether two names refer to the same player: last name identical, first name
// equal or one a prefix of the other ("Matt"/"Matthew", abbreviated feeds).
// Used to disambiguate players that collapse to the same coarse name_key.
function sameFullName(a, b) {
  const wa = nameWords(a);
  const wb = nameWords(b);
  if (!wa.length || !wb.length) return false;
  if (wa[wa.length - 1] !== wb[wb.length - 1]) return false; // last name must match
  const fa = wa[0];
  const fb = wb[0];
  return fa === fb || fa.startsWith(fb) || fb.startsWith(fa);
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
      .slice(0, 500); // was 40 (one game); the value board sends a whole slate's players

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

    // Supabase caps a single response at 1000 rows. With a whole slate's players that
    // truncates most of them (only the first ~40 ever came back). Paginate in 1000-row
    // pages, newest-first, up to ~40 games per player (capped) so every player is covered.
    const maxRows = Math.min(40 * keys.length, 9000);
    const data = [];
    const PAGE = 1000;
    for (let from = 0; from < maxRows; from += PAGE) {
      const { data: page, error } = await supabase
        .from(config.table)
        .select(`name_key,player_name,team,game_date,${columns.join(",")}`)
        .in("name_key", keys)
        .order("game_date", { ascending: false })
        .range(from, Math.min(from + PAGE, maxRows) - 1);
      if (error) {
        return res.status(500).json({ error: error.message });
      }
      if (!page?.length) break;
      data.push(...page);
      if (page.length < PAGE) break;
    }

    const byKey = new Map();
    for (const row of data || []) {
      if (!byKey.has(row.name_key)) byKey.set(row.name_key, []);
      byKey.get(row.name_key).push(row);
    }

    let maxGames = 0;
    const playerSummaries = players.map((player) => {
      // name_key is coarse (firstInitial_lastname), so distinct players such as
      // "Joe Berry" and "Jarrod Berry" share a key. Using the whole pool would
      // blend their game logs — the team becomes whoever played most recently
      // and the last-5/10 form is a contaminated mix. Disambiguate by full name:
      // prefer an exact match, then a first-name-prefix match ("Matt"/"Matthew",
      // abbreviated feeds); only fall back to the whole pool when it holds a
      // single player (covers nickname spellings like "Nick"/"Nicholas" that
      // share the coarse key but have no teammate-of-a-name to be confused with).
      const pooled = byKey.get(nameKey(player)) || [];
      const want = nameWords(player).join(" ");
      let rows = pooled.filter((r) => nameWords(r.player_name).join(" ") === want);
      if (!rows.length) {
        const prefix = pooled.filter((r) => sameFullName(player, r.player_name));
        const distinct = new Set(pooled.map((r) => (r.player_name || "").toLowerCase()));
        rows = prefix.length ? prefix : distinct.size <= 1 ? pooled : [];
      }
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
