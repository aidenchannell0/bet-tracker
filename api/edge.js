import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabaseAdmin =
  (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
    : null;

// In-memory cache for the latest isotonic recalibration curves per sport.
// scripts/recalibrate.mjs writes new rows to model_calibration weekly — one
// global per sport (≥120 resolved samples) plus one per market (≥150). This
// loader returns a { global, markets } bundle so enrichProps can prefer the
// per-market curve and fall back to the global when a market doesn't have
// enough data yet. Lambda cold starts naturally pick up new curves; if you
// ever need a faster refresh, clear the cache after curve writes.
//
// Trust floor: even a stored curve is ignored below CAL_MIN_TRUST_SAMPLES.
// A curve fitted on too few resolved samples is noise — its top isotonic bins
// flatten toward 1.0 (a few high-prob legs all happened to hit) and inflate
// every high-confidence leg. Below the floor we drop it and fall back to the
// raw model probability, which is strictly safer than a bad curve.
const CAL_MIN_TRUST_SAMPLES = 120;
const calibrationCache = new Map();
async function loadCalibrationCurve(sport) {
  if (!supabaseAdmin || !sport) return null;
  const key = String(sport).toUpperCase();
  if (calibrationCache.has(key)) return calibrationCache.get(key);
  try {
    // Pull every curve for this sport — global + per-market. Order by fit_date
    // desc so the first row per (market) is the latest.
    const { data, error } = await supabaseAdmin
      .from("model_calibration")
      .select("market,curve_points,fit_date,n_samples,rmse")
      .eq("sport", key)
      .order("fit_date", { ascending: false });
    if (error || !data || !data.length) {
      calibrationCache.set(key, null);
      return null;
    }
    // Keep only the most recent row per market key (null = global)
    const seen = new Set();
    const bundle = { global: null, markets: {} };
    for (const row of data) {
      const k = row.market || "__global__";
      if (seen.has(k)) continue; // only the latest fit per market
      seen.add(k);
      const curve = Array.isArray(row.curve_points) ? row.curve_points : null;
      if (!curve) continue;
      // Trust floor — a curve fitted on too few resolved samples is noise.
      // Drop it (data only grows, so the latest fit has the most samples; if
      // it's below the floor, older fits are too) and fall back to raw.
      if ((row.n_samples ?? 0) < CAL_MIN_TRUST_SAMPLES) continue;
      if (row.market) bundle.markets[row.market] = curve;
      else bundle.global = curve;
    }
    calibrationCache.set(key, bundle);
    return bundle;
  } catch (error) {
    calibrationCache.set(key, null);
    return null;
  }
}
// Pick the right curve for a leg's market: per-market if a curve exists,
// global otherwise. Returns null if no curves loaded — enrichProps then falls
// through to the raw empirical, preserving current behaviour.
function pickCurveForMetric(bundle, metric) {
  if (!bundle) return null;
  if (metric && bundle.markets && bundle.markets[metric]) return bundle.markets[metric];
  return bundle.global || null;
}
// Above this confidence, calibration may only pull a probability DOWN, never
// up. Small-sample isotonic curves flatten their top bins toward 1.0 (a handful
// of high-prob legs all happen to hit), which inflates an 85% leg into a "99%
// lock". In a safety-first product that's the worst failure mode — it makes
// Best Chance legs look like certainties. So at the top end we still let
// calibration correct overconfidence (down) but never manufacture it (up).
const CAL_NO_INFLATE_ABOVE = 0.80;

// Linear interpolation between adjacent isotonic curve points. Returns the
// raw value when no curve is loaded (model_calibration empty until the first
// recalibrate run lands). Two safety rails are baked in:
//
//   1. Out-of-range → return x unchanged. The recalibrate script only sees
//      predictions the selection layer logged (empirical ≥ minHit ≈ 0.58), so
//      the curve's x domain is narrow — typically [~0.6, ~0.97]. Clamping
//      out-of-range inputs to the boundary y (the old behavior) was the Task
//      #106 bug: a 0/10-hit $31 long-shot (raw 0.02–0.6) got clamped up to
//      curve[0].y ≈ 0.7 and displayed at 67%. No data out there → trust x.
//   2. Above CAL_NO_INFLATE_ABOVE, never return y > x (see the constant above).
function applyCalibrationCurve(curve, x) {
  if (!curve || !curve.length || x == null) return x;
  if (x < curve[0].x) return x;
  if (x > curve[curve.length - 1].x) return x;
  let y = x;
  for (let i = 0; i < curve.length - 1; i += 1) {
    if (x >= curve[i].x && x <= curve[i + 1].x) {
      const span = curve[i + 1].x - curve[i].x;
      y = span <= 0
        ? curve[i].y
        : curve[i].y + ((x - curve[i].x) / span) * (curve[i + 1].y - curve[i].y);
      break;
    }
  }
  // Rail 2: high-confidence legs can be corrected down, never inflated up.
  if (x >= CAL_NO_INFLATE_ABOVE && y > x) return x;
  return y;
}

const FREE_BUILDS_PER_WEEK = 3;

function startOfWeekIso() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

// Check whether the caller can build a multi (subscribed = unlimited; free = 3/week).
// Fails open (allows) if anything is misconfigured, so the feature never hard-breaks.
async function checkGridBuildAccess(req) {
  const open = { gated: false, usage: 0, limit: FREE_BUILDS_PER_WEEK, subscribed: false, userId: null };
  try {
    if (!supabaseAdmin) return open;
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return open;

    const { data: userData } = await supabaseAdmin.auth.getUser(token);
    const user = userData?.user;
    if (!user) return open;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("subscription_status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profile?.subscription_status === "active") {
      return { gated: false, usage: 0, limit: FREE_BUILDS_PER_WEEK, subscribed: true, userId: user.id };
    }

    const { count } = await supabaseAdmin
      .from("grid_build_usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", startOfWeekIso());

    const used = count || 0;
    return {
      gated: used >= FREE_BUILDS_PER_WEEK,
      usage: used,
      limit: FREE_BUILDS_PER_WEEK,
      subscribed: false,
      userId: user.id,
    };
  } catch (error) {
    console.error("Grid Build access check error:", error);
    return open;
  }
}

async function recordGridBuildUsage(userId) {
  if (!supabaseAdmin || !userId) return;
  try {
    await supabaseAdmin.from("grid_build_usage").insert({ user_id: userId });
  } catch (error) {
    console.error("Grid Build usage record error:", error);
  }
}

function nameKeyFromName(full) {
  const words = String(full || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  return `${words[0][0]}_${words[words.length - 1]}`;
}

function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Log each rated leg (deduped to one per leg per round) for later calibration.
async function recordPredictions(rated, selectedSet, season, userId) {
  if (!supabaseAdmin || !rated?.length) return;
  try {
    const week = isoWeekKey();
    const rows = rated
      .filter((p) => p && p.playerName && p.metric && p.line != null && p.empirical != null)
      .map((p) => {
        const nk = nameKeyFromName(p.playerName);
        return {
          user_id: userId || null,
          player_name: p.playerName,
          name_key: nk,
          metric: p.metric,
          line: p.line,
          predicted_prob: Number((p.empirical ?? 0).toFixed(4)),
          odds: Number(p.odds) || null,
          game_label: p.gameLabel || null,
          season: season || null,
          // Did this leg make it into the built multi? The calibration block shows
          // selected-only ("picks hit rate"); recalibrate uses the whole pool so
          // the fitted curve spans the full probability domain.
          selected: selectedSet ? selectedSet.has(`${nk}|${p.metric}|${p.line}`) : true,
          dedupe_key: `${nk}|${p.metric}|${p.line}|${week}`,
        };
      });
    if (rows.length) {
      const { error: upsertErr } = await supabaseAdmin.from("grid_build_predictions").upsert(rows, { onConflict: "dedupe_key" });
      // Back-compat: if the `selected` column isn't migrated yet, fall back to the
      // old behaviour — log only the selected legs, without the flag — so nothing
      // breaks (and the display stays selected-only) until the migration runs.
      if (upsertErr && /selected/i.test(upsertErr.message || "")) {
        const legacyRows = rows.filter((r) => r.selected).map(({ selected, ...rest }) => rest);
        if (legacyRows.length) await supabaseAdmin.from("grid_build_predictions").upsert(legacyRows, { onConflict: "dedupe_key" });
      }
    }
  } catch (error) {
    console.error("record predictions error:", error);
  }
}

const EDGE_SYSTEM_PROMPT = `
You are Grid Build, Bet Grid's AI-powered multi builder and sports market analysis assistant.

Your role:
- Help users understand sports markets in a simple way.
- Help users build and refine structured informational example multis.
- Explain risk clearly.
- Explain what data should be checked before making any decision.
- Use available odds data when it is provided.

Tone:
- 75% professional, 25% friendly.
- Clear, calm, direct, and easy to understand.
- Sound like a helpful professional multi builder, not a hype betting tipster.
- Avoid slang, overconfidence, reckless language, or pressure.

Very important safety rules:
- You do not provide betting advice.
- You do not provide financial advice.
- You do not guarantee results.
- You do not instruct users to place a bet.
- Never say a bet is safe, guaranteed, locked, certain, risk-free, or a sure thing.
- Always make clear that any multi or selection is an informational example only.
- Always remind the user that outcomes are uncertain and they are responsible for their own decisions.
- Encourage responsible gambling.

Current data status:
- Real match odds data may be available when included in the prompt.
- Real event-level market data may be available when included in the prompt.
- Historical player statistics may be available when player stats data is provided in the prompt.
- Current injuries, team news, lineups and live player form are not connected yet.
- Do not invent player stats, injuries, lineups, or player hit rates.
- If player stats are provided, use the exact averages, hit rates, source and freshness labels.
- If player stats are missing, say that clearly.

Odds and market data rules:
- If odds data is provided, use it to mention real upcoming games and approximate available prices.
- If event market data is provided, use it to mention available market lines.
- Keep odds and market summaries simple.
- Do not list every bookmaker unless the user asks.
- Do not claim the best pick from odds alone.
- Do not say a team, player or market is value unless the user provides enough supporting data.
- Say that odds and markets can change.
- If no odds or markets are available for the requested sport, league, team, date window or market type, say that clearly.
- Do not show odds from another sport unless the user specifically asks.

Intent rules:
- If the user only asks what games or odds are available, only list the available games and sample odds. Do not build a multi.
- If the user asks for player markets, list available market lines only. Do not pretend they are recommendations.
- Only provide an example multi if the user asks for a multi, bet build, legs, selections, or example structure.
- Only provide a risk score if the user asks about risk, a multi, or a build.
- Only provide the full section structure when it fits the user request.
- Do not force every response into every section if the user asked a simple question.

Formatting rules:
- Keep responses simple and easy for everyday users to understand.
- Do not show equations, formulas, or odds multiplication unless the user specifically asks.
- Do not over-explain the maths.
- Do not use Markdown headings like ###.
- Use **bold** markers for important player names, team names, markets, stats, odds, disposals, goals, hit rates, and risk scores.
- Never put the whole answer in one paragraph.
- Use blank lines between each section.
- Keep most responses under 260 words.
- Prioritise clarity over detail.
`;

const TEAM_ALIAS_MAP = [
  { aliases: ["pies", "magpies", "collingwood", "collingwood magpies"], sport: "AFL", team: "Collingwood Magpies" },
  { aliases: ["swans", "sydney swans"], sport: "AFL", team: "Sydney Swans" },
  { aliases: ["cats", "geelong", "geelong cats"], sport: "AFL", team: "Geelong Cats" },
  { aliases: ["lions", "brisbane lions"], sport: "AFL", team: "Brisbane Lions" },
  { aliases: ["blues", "carlton", "carlton blues"], sport: "AFL", team: "Carlton Blues" },
  { aliases: ["bombers", "essendon", "essendon bombers"], sport: "AFL", team: "Essendon Bombers" },
  { aliases: ["tigers", "richmond", "richmond tigers"], sport: "AFL", team: "Richmond Tigers" },
  { aliases: ["hawks", "hawthorn", "hawthorn hawks"], sport: "AFL", team: "Hawthorn Hawks" },
  { aliases: ["demons", "melbourne demons"], sport: "AFL", team: "Melbourne Demons" },
  { aliases: ["bulldogs", "western bulldogs"], sport: "AFL", team: "Western Bulldogs" },
  { aliases: ["crows", "adelaide crows"], sport: "AFL", team: "Adelaide Crows" },
  { aliases: ["port", "port adelaide", "power", "port adelaide power"], sport: "AFL", team: "Port Adelaide Power" },
  { aliases: ["dockers", "fremantle", "fremantle dockers"], sport: "AFL", team: "Fremantle Dockers" },
  { aliases: ["eagles", "west coast", "west coast eagles"], sport: "AFL", team: "West Coast Eagles" },
  { aliases: ["suns", "gold coast suns"], sport: "AFL", team: "Gold Coast Suns" },
  { aliases: ["giants", "gws", "gws giants"], sport: "AFL", team: "GWS Giants" },
  { aliases: ["saints", "st kilda", "st kilda saints"], sport: "AFL", team: "St Kilda Saints" },
  { aliases: ["kangaroos", "north melbourne"], sport: "AFL", team: "North Melbourne Kangaroos" },

  { aliases: ["dragons", "st george", "st george illawarra"], sport: "NRL", team: "St George Illawarra Dragons" },
  { aliases: ["broncos", "brisbane broncos"], sport: "NRL", team: "Brisbane Broncos" },
  { aliases: ["storm", "melbourne storm"], sport: "NRL", team: "Melbourne Storm" },
  { aliases: ["panthers", "penrith", "penrith panthers"], sport: "NRL", team: "Penrith Panthers" },
  { aliases: ["roosters", "sydney roosters"], sport: "NRL", team: "Sydney Roosters" },
  { aliases: ["rabbitohs", "souths", "south sydney"], sport: "NRL", team: "South Sydney Rabbitohs" },
  { aliases: ["eels", "parramatta"], sport: "NRL", team: "Parramatta Eels" },
  { aliases: ["bulldogs", "canterbury", "canterbury bulldogs"], sport: "NRL", team: "Canterbury-Bankstown Bulldogs" },
  { aliases: ["sharks", "cronulla", "cronulla sharks"], sport: "NRL", team: "Cronulla Sharks" },
  { aliases: ["sea eagles", "manly", "manly sea eagles"], sport: "NRL", team: "Manly Sea Eagles" },
  { aliases: ["cowboys", "north queensland"], sport: "NRL", team: "North Queensland Cowboys" },
  { aliases: ["dolphins"], sport: "NRL", team: "Dolphins" },
  { aliases: ["titans", "gold coast titans"], sport: "NRL", team: "Gold Coast Titans" },
  { aliases: ["raiders", "canberra raiders"], sport: "NRL", team: "Canberra Raiders" },
  { aliases: ["knights", "newcastle knights"], sport: "NRL", team: "Newcastle Knights" },
  { aliases: ["warriors", "nz warriors", "new zealand warriors"], sport: "NRL", team: "New Zealand Warriors" },
  { aliases: ["tigers", "wests tigers"], sport: "NRL", team: "Wests Tigers" },

  { aliases: ["hawks", "atlanta hawks"], sport: "NBA", team: "Atlanta Hawks" },
  { aliases: ["celtics", "boston celtics"], sport: "NBA", team: "Boston Celtics" },
  { aliases: ["nets", "brooklyn nets"], sport: "NBA", team: "Brooklyn Nets" },
  { aliases: ["hornets", "charlotte hornets"], sport: "NBA", team: "Charlotte Hornets" },
  { aliases: ["bulls", "chicago bulls"], sport: "NBA", team: "Chicago Bulls" },
  { aliases: ["cavs", "cavaliers", "cleveland cavaliers"], sport: "NBA", team: "Cleveland Cavaliers" },
  { aliases: ["mavs", "mavericks", "dallas mavericks"], sport: "NBA", team: "Dallas Mavericks" },
  { aliases: ["nuggets", "denver nuggets"], sport: "NBA", team: "Denver Nuggets" },
  { aliases: ["pistons", "detroit pistons"], sport: "NBA", team: "Detroit Pistons" },
  { aliases: ["warriors", "golden state", "golden state warriors", "gsw"], sport: "NBA", team: "Golden State Warriors" },
  { aliases: ["rockets", "houston rockets"], sport: "NBA", team: "Houston Rockets" },
  { aliases: ["pacers", "indiana pacers"], sport: "NBA", team: "Indiana Pacers" },
  { aliases: ["clippers", "la clippers", "los angeles clippers"], sport: "NBA", team: "LA Clippers" },
  { aliases: ["lakers", "la lakers", "los angeles lakers"], sport: "NBA", team: "Los Angeles Lakers" },
  { aliases: ["grizzlies", "memphis grizzlies"], sport: "NBA", team: "Memphis Grizzlies" },
  { aliases: ["heat", "miami heat"], sport: "NBA", team: "Miami Heat" },
  { aliases: ["bucks", "milwaukee bucks"], sport: "NBA", team: "Milwaukee Bucks" },
  { aliases: ["timberwolves", "wolves", "minnesota timberwolves"], sport: "NBA", team: "Minnesota Timberwolves" },
  { aliases: ["pelicans", "pels", "new orleans pelicans"], sport: "NBA", team: "New Orleans Pelicans" },
  { aliases: ["knicks", "ny knicks", "new york knicks"], sport: "NBA", team: "New York Knicks" },
  { aliases: ["thunder", "okc", "oklahoma city", "oklahoma city thunder"], sport: "NBA", team: "Oklahoma City Thunder" },
  { aliases: ["magic", "orlando magic"], sport: "NBA", team: "Orlando Magic" },
  { aliases: ["sixers", "76ers", "philadelphia 76ers", "philly"], sport: "NBA", team: "Philadelphia 76ers" },
  { aliases: ["phoenix suns", "phoenix"], sport: "NBA", team: "Phoenix Suns" },
  { aliases: ["trail blazers", "blazers", "portland trail blazers"], sport: "NBA", team: "Portland Trail Blazers" },
  { aliases: ["kings", "sacramento kings"], sport: "NBA", team: "Sacramento Kings" },
  { aliases: ["spurs", "san antonio spurs", "sas"], sport: "NBA", team: "San Antonio Spurs" },
  { aliases: ["raptors", "toronto raptors"], sport: "NBA", team: "Toronto Raptors" },
  { aliases: ["jazz", "utah jazz"], sport: "NBA", team: "Utah Jazz" },
  { aliases: ["wizards", "washington wizards"], sport: "NBA", team: "Washington Wizards" },
];

function buildBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return `${protocol}://${host}`;
}

function getSafeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normaliseText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectAllTeamAliases(message) {
  const lowerMessage = String(message || "").toLowerCase();
  const matches = [];

  for (const entry of TEAM_ALIAS_MAP) {
    for (const alias of entry.aliases) {
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const aliasPattern = new RegExp(`\\b${escapedAlias}\\b`, "i");

      if (aliasPattern.test(lowerMessage)) {
        matches.push(entry);
        break;
      }
    }
  }

  return matches;
}

function detectExplicitSportFromMessage(message) {
  const lowerMessage = String(message || "").toLowerCase();
  const teams = detectAllTeamAliases(message);

  if (teams[0]) return teams[0].sport;
  if (lowerMessage.includes("nrl") || lowerMessage.includes("rugby league")) return "NRL";
  if (lowerMessage.includes("afl") || lowerMessage.includes("aussie rules")) return "AFL";
  if (lowerMessage.includes("nba") || lowerMessage.includes("basketball")) return "NBA";
  if (lowerMessage.includes("soccer") || lowerMessage.includes("football")) return "Soccer";

  return null;
}

function getDateWindowFromMessage(message) {
  const lowerMessage = String(message || "").toLowerCase();
  const now = new Date();

  const startOfDay = (date) => {
    const copiedDate = new Date(date);
    copiedDate.setHours(0, 0, 0, 0);
    return copiedDate;
  };

  const addDays = (date, days) => {
    const copiedDate = new Date(date);
    copiedDate.setDate(copiedDate.getDate() + days);
    return copiedDate;
  };

  const toIso = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

  if (lowerMessage.includes("tomorrow")) {
    return {
      label: "tomorrow",
      commenceTimeFrom: toIso(startOfDay(addDays(now, 1))),
      commenceTimeTo: toIso(startOfDay(addDays(now, 2))),
    };
  }

  if (lowerMessage.includes("next week") || lowerMessage.includes("week after")) {
    return {
      label: "next week",
      commenceTimeFrom: toIso(startOfDay(addDays(now, 7))),
      commenceTimeTo: toIso(startOfDay(addDays(now, 14))),
    };
  }

  if (lowerMessage.includes("this week")) {
    return {
      label: "this week",
      commenceTimeFrom: toIso(now),
      commenceTimeTo: toIso(startOfDay(addDays(now, 7))),
    };
  }

  return {
    label: "upcoming games",
    commenceTimeFrom: null,
    commenceTimeTo: null,
  };
}

function detectRequestedMarket(message, sport) {
  const lowerMessage = String(message || "").toLowerCase();

  if (sport === "AFL") {
    if (lowerMessage.includes("fantasy")) {
      return {
        label: "fantasy points",
        metric: "fantasy_points",
        markets: [
          "player_afl_fantasy_points_over",
          "player_afl_fantasy_points",
          "player_afl_fantasy_points_most",
        ],
      };
    }

    if (lowerMessage.includes("disposal")) {
      return {
        label: "disposals",
        metric: "disposals",
        markets: ["player_disposals_over", "player_disposals"],
      };
    }

    if (lowerMessage.includes("clearance")) {
      return {
        label: "clearances",
        metric: "clearances",
        markets: ["player_clearances_over"],
      };
    }

    if (lowerMessage.includes("tackle")) {
      return {
        label: "tackles",
        metric: "tackles",
        markets: ["player_tackles_over", "player_tackles_most"],
      };
    }

    if (lowerMessage.includes("kick")) {
      return {
        label: "kicks",
        metric: "kicks",
        markets: ["player_kicks_over"],
      };
    }

    if (lowerMessage.includes("handball")) {
      return {
        label: "handballs",
        metric: "handballs",
        markets: ["player_handballs_over"],
      };
    }

    if (lowerMessage.includes("goal")) {
      return {
        label: "goals",
        metric: "goals",
        markets: [
          "player_goals_scored_over",
          "player_goal_scorer_anytime",
          "player_goal_scorer_first",
          "player_goal_scorer_last",
        ],
      };
    }

    const asksForMarks =
      /\bmarks?\b/.test(lowerMessage) ||
      lowerMessage.includes("mark line") ||
      lowerMessage.includes("mark markets");

    if (asksForMarks) {
      return {
        label: "marks",
        metric: "marks",
        markets: ["player_marks_over", "player_marks_most"],
      };
    }
  }

  if (lowerMessage.includes("handicap") || lowerMessage.includes("line") || lowerMessage.includes("spread")) {
    return {
      label: "handicap",
      metric: null,
      markets: ["spreads"],
    };
  }

  if (lowerMessage.includes("total") || lowerMessage.includes("over under") || lowerMessage.includes("over/under")) {
    return {
      label: "totals",
      metric: null,
      markets: ["totals"],
    };
  }

  return null;
}

function getUserIntent(message, requestedMarket) {
  const lowerMessage = String(message || "").toLowerCase();

  // A clear multi/build request takes priority. The multi builder picks its own
  // markets, so don't let an incidental word like "line" (in "market lines") route
  // it to a market lookup and then fall through to the generic reply.
  const asksForMulti =
    lowerMessage.includes("multi") ||
    /\blegs?\b/.test(lowerMessage) ||
    lowerMessage.includes("build") ||
    lowerMessage.includes("selection") ||
    lowerMessage.includes("example bet");

  if (asksForMulti) return "multi";

  const asksForStats =
    lowerMessage.includes("stats") ||
    lowerMessage.includes("average") ||
    lowerMessage.includes("averages") ||
    lowerMessage.includes("hit rate") ||
    lowerMessage.includes("hit rates") ||
    lowerMessage.includes("last 5") ||
    lowerMessage.includes("last 10") ||
    lowerMessage.includes("last 20") ||
    lowerMessage.includes("compare") ||
    lowerMessage.includes("comparison");

  if (requestedMarket && asksForStats) return "market_stats_comparison";
  if (requestedMarket) return "event_markets";

  const asksForGames =
    lowerMessage.includes("what games") ||
    lowerMessage.includes("which games") ||
    lowerMessage.includes("available games") ||
    lowerMessage.includes("upcoming games") ||
    lowerMessage.includes("show me odds") ||
    lowerMessage.includes("give me odds") ||
    lowerMessage.includes("what are the odds");

  if (asksForGames) return "available_games";
  if (asksForStats) return "player_stats";

  return "general";
}

function getPrimaryMarketOdds(event) {
  const bookmaker = event.bookmakers?.[0];
  const market =
    bookmaker?.markets?.find((item) => item.key === "h2h") ||
    bookmaker?.markets?.[0];

  if (!bookmaker || !market?.outcomes?.length) return null;

  return {
    bookmaker: bookmaker.title,
    outcomes: market.outcomes.map((outcome) => ({
      name: outcome.name,
      price: outcome.price,
    })),
  };
}

function filterEventsByDetectedTeam(events, detectedTeam) {
  if (!detectedTeam?.team) return events;

  const teamLower = detectedTeam.team.toLowerCase();

  return events.filter((event) => {
    const homeTeam = String(event.homeTeam || "").toLowerCase();
    const awayTeam = String(event.awayTeam || "").toLowerCase();

    return homeTeam.includes(teamLower) || awayTeam.includes(teamLower);
  });
}

function scoreEventMatch(event, message, detectedTeams) {
  const normalisedMessage = normaliseText(message);
  const home = normaliseText(event.homeTeam);
  const away = normaliseText(event.awayTeam);
  let score = 0;

  for (const detectedTeam of detectedTeams || []) {
    const team = normaliseText(detectedTeam.team);

    if (home.includes(team) || away.includes(team)) {
      score += 8;
    }
  }

  const teamWords = [...home.split(" "), ...away.split(" ")].filter(
    (word) => word.length >= 4 && !["football", "club"].includes(word)
  );

  for (const word of teamWords) {
    if (normalisedMessage.includes(word)) {
      score += 1;
    }
  }

  return score;
}

function findMatchingEvent(events, message, detectedTeams) {
  if (!events?.length) return null;

  const scored = events
    .map((event) => ({
      event,
      score: scoreEventMatch(event, message, detectedTeams),
    }))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.score > 0 ? scored[0].event : null;
}

function listAvailableEventOptions(events) {
  if (!events?.length) {
    return "No upcoming games were returned for this sport right now.";
  }

  return events
    .slice(0, 6)
    .map((event, index) => `${index + 1}. **${event.homeTeam} vs ${event.awayTeam}**`)
    .join("\n");
}

function summariseOddsForEdge(oddsData, requestedSport, detectedTeam, dateWindow) {
  const allEvents = oddsData?.events || [];
  const events = filterEventsByDetectedTeam(allEvents, detectedTeam);
  const dateLabel = dateWindow?.label || "upcoming games";

  if (!events.length) {
    if (detectedTeam?.team) {
      return `No odds were returned for **${detectedTeam.team}** in **${requestedSport}** for **${dateLabel}**.`;
    }

    return `No odds were returned for **${requestedSport}** for **${dateLabel}**.`;
  }

  return events
    .slice(0, 6)
    .map((event, index) => {
      const market = getPrimaryMarketOdds(event);
      const teams = `${event.homeTeam || "Home team"} vs ${event.awayTeam || "Away team"}`;

      if (!market) {
        return `${index + 1}. **${teams}**\nNo clear head-to-head odds returned.`;
      }

      const prices = market.outcomes
        .map((outcome) => `**${outcome.name}**: **$${outcome.price}**`)
        .join(", ");

      return `${index + 1}. **${teams}**\nBookmaker sample: **${market.bookmaker}**\nOdds: ${prices}`;
    })
    .join("\n\n");
}

async function fetchOddsContext(req, sport, detectedTeam, dateWindow) {
  try {
    const baseUrl = buildBaseUrl(req);
    const url = new URL("/api/odds", baseUrl);

    url.searchParams.set("sport", sport || "AFL");
    url.searchParams.set("markets", "h2h");

    if (dateWindow?.commenceTimeFrom) {
      url.searchParams.set("commenceTimeFrom", dateWindow.commenceTimeFrom);
    }

    if (dateWindow?.commenceTimeTo) {
      url.searchParams.set("commenceTimeTo", dateWindow.commenceTimeTo);
    }

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
      return {
        available: false,
        events: [],
        summary: `Odds data could not be loaded for **${sport}** right now. Error: ${data?.error || "Unknown error"}`,
      };
    }

    return {
      available: true,
      events: data.events || [],
      summary: summariseOddsForEdge(data, sport, detectedTeam, dateWindow),
      quota: data.quota,
    };
  } catch (error) {
    console.error("Edge odds context error:", error);

    return {
      available: false,
      events: [],
      summary: `Odds data could not be loaded for **${sport}** right now.`,
    };
  }
}

// Short in-memory cache for event odds — repeated builds/refines in a session reuse
// the same odds instead of spending Odds API credits each time (player props are costly).
const eventOddsCache = new Map();
const EVENT_ODDS_TTL_MS = 10 * 60 * 1000;

async function fetchEventOddsContext(req, sport, eventId, requestedMarket) {
  const cacheKey = `${sport}:${eventId}:${requestedMarket.markets.join(",")}`;
  const cached = eventOddsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EVENT_ODDS_TTL_MS) {
    return cached.value;
  }

  try {
    const baseUrl = buildBaseUrl(req);
    const url = new URL("/api/event-odds", baseUrl);

    url.searchParams.set("sport", sport || "AFL");
    url.searchParams.set("eventId", eventId);
    url.searchParams.set("markets", requestedMarket.markets.join(","));

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
      return {
        available: false,
        event: null,
        summary: `Event markets could not be loaded. Error: ${data?.error || "Unknown error"}`,
      };
    }

    const result = {
      available: true,
      event: data.event,
      summary: summariseEventMarkets(data.event, requestedMarket),
      quota: data.quota,
    };
    eventOddsCache.set(cacheKey, { at: Date.now(), value: result });
    return result;
  } catch (error) {
    console.error("Edge event markets error:", error);

    return {
      available: false,
      event: null,
      summary: "Event markets could not be loaded right now.",
    };
  }
}

function detectStatsMetric(message, requestedMarket) {
  const lowerMessage = String(message || "").toLowerCase();

  if (lowerMessage.includes("fantasy")) return "fantasy_points";
  if (lowerMessage.includes("disposal")) return "disposals";
  if (lowerMessage.includes("clearance")) return "clearances";
  if (lowerMessage.includes("tackle")) return "tackles";
  if (lowerMessage.includes("goal")) return "goals";
  if (lowerMessage.includes("kick")) return "kicks";
  if (lowerMessage.includes("handball")) return "handballs";
  if (/\bmarks?\b/.test(lowerMessage)) return "marks";

  return requestedMarket?.metric || "fantasy_points";
}

function extractRequestedPlayers(message) {
  const text = String(message || "");

  if (text.toLowerCase().includes("test player")) {
    return ["Test Player"];
  }

  return [];
}

// Sport-aware player stats fetch — calls the merged /api/stats endpoint and
// normalises the response shape. Both AFL and NBA return identical structure.
async function fetchStatsContext(req, sport, players, metrics) {
  try {
    const baseUrl = buildBaseUrl(req);
    const url = new URL("/api/stats", baseUrl);
    url.searchParams.set("sport", sport || "AFL");
    url.searchParams.set("players", players.join(","));
    url.searchParams.set("metrics", metrics.join(","));

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok || !data.available) {
      return { available: false, players: [], gamesAnalysed: 0 };
    }

    return {
      available: true,
      players: data.players || [],
      gamesAnalysed: data.gamesAnalysed || 0,
      source: data.source || "Stats source",
    };
  } catch (error) {
    console.error(`${sport} stats context error:`, error);
    return { available: false, players: [], gamesAnalysed: 0 };
  }
}

const PLAYER_MARKETS_BY_SPORT = {
  AFL: {
    label: "AFL player props",
    markets: [
      "player_disposals_over",
      "player_goals_scored_over",
      "player_marks_over",
      "player_tackles_over",
      "player_afl_fantasy_points_over",
      "player_clearances_over",
      "player_kicks_over",
      "player_handballs_over",
    ],
  },
  NBA: {
    label: "NBA player props",
    // The Odds API uses single-key markets for NBA — Over/Under live as outcomes
    // within each market (no `_over` variants like AFL has). Sending an unknown
    // key like `player_points_over` causes the API to reject the entire request
    // with INVALID_MARKET, so keep this list to the actual canonical keys.
    //
    // The `_alternate` variants are what unlock the $1.02 — $2.00 leg range that
    // AFL builds get natively (AFL `_over` markets already include all lines per
    // player). Standard NBA markets only return the headline line per player
    // (~$1.90 even-money pricing); alternates return ~40 lines per player at
    // every price tier, including the cheap "Wembanyama 14.5+ points @ $1.02"
    // style legs needed for low-target builds. Verified live against SportsBet,
    // TABtouch, Unibet — all post alternates via The Odds API.
    markets: [
      "player_points",
      "player_rebounds",
      "player_assists",
      "player_threes",
      "player_blocks",
      "player_steals",
      "player_points_alternate",
      "player_rebounds_alternate",
      "player_assists_alternate",
      "player_threes_alternate",
      "player_blocks_alternate",
      "player_steals_alternate",
    ],
  },
};

// Per-team defensive factors for the current season (cached server-side).
// Sport-aware — calls the merged /api/defense endpoint.
async function fetchDefenseContext(req, sport = "AFL") {
  try {
    const baseUrl = buildBaseUrl(req);
    const url = new URL("/api/defense", baseUrl);
    url.searchParams.set("sport", sport);
    const response = await fetch(url.toString());
    const data = await response.json();
    if (!response.ok || !data.available) return { available: false, factors: null };
    return { available: true, factors: data.factors || null, season: data.season };
  } catch (error) {
    console.error(`${sport} defense context error:`, error);
    return { available: false, factors: null };
  }
}

// Does a bookmaker match the user's chosen book? Matches on The Odds API key or a
// normalised title, so "pointsbetau"/"PointsBet (AU)" and "ladbrokes_au"/"Ladbrokes"
// both resolve. Empty/"best" => match everything (best price across books).
function bookmakerMatches(bookmaker, preferredBook) {
  if (!preferredBook || preferredBook === "best") return true;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(preferredBook);
  return norm(bookmaker.key) === want || norm(bookmaker.title) === want;
}

// Display name for a chosen bookmaker key (null/"" => no specific book chosen)
const BOOKMAKER_LABELS = {
  sportsbet: "Sportsbet",
  tab: "TAB",
  ladbrokes_au: "Ladbrokes",
  neds: "Neds",
  pointsbetau: "PointsBet",
  unibet: "Unibet",
};
function bookmakerLabel(preferredBook) {
  if (!preferredBook || preferredBook === "best") return null;
  return BOOKMAKER_LABELS[preferredBook] || preferredBook;
}

function extractPlayerPropsFromEvent(event, preferredBook = null) {
  const props = [];
  const overMarketKeys = [
    // AFL
    "player_disposals_over",
    "player_goals_scored_over",
    "player_marks_over",
    "player_tackles_over",
    "player_afl_fantasy_points_over",
    "player_clearances_over",
    "player_kicks_over",
    "player_handballs_over",
    // NBA — single-key markets; Over/Under live as outcomes within each.
    "player_points",
    "player_rebounds",
    "player_assists",
    "player_threes",
    "player_blocks",
    "player_steals",
    // NBA alternates — same shape but multiple lines per player. Unlocks the
    // $1.02 — $2.00 leg range; see PLAYER_MARKETS_BY_SPORT.NBA for context.
    "player_points_alternate",
    "player_rebounds_alternate",
    "player_assists_alternate",
    "player_threes_alternate",
    "player_blocks_alternate",
    "player_steals_alternate",
  ];

  const metricFromMarket = {
    // AFL
    player_disposals_over: "disposals",
    player_goals_scored_over: "goals",
    player_marks_over: "marks",
    player_tackles_over: "tackles",
    player_afl_fantasy_points_over: "fantasy_points",
    player_clearances_over: "clearances",
    player_kicks_over: "kicks",
    player_handballs_over: "handballs",
    // NBA — alternates map to the same metric as the standard so the
    // dedup below (keyed on metric, not market.key) collapses them and
    // we keep the highest-priced Over per player+line+price tier.
    player_points: "points",
    player_rebounds: "rebounds",
    player_assists: "assists",
    player_threes: "threes",
    player_blocks: "blocks",
    player_steals: "steals",
    player_points_alternate: "points",
    player_rebounds_alternate: "rebounds",
    player_assists_alternate: "assists",
    player_threes_alternate: "threes",
    player_blocks_alternate: "blocks",
    player_steals_alternate: "steals",
  };

  // For each unique player+market+line, keep the BEST (highest) Over price and
  // also remember the Under price from the SAME bookmaker so we can later de-vig
  // the implied probability. We need same-book pairing because Over/Under prices
  // across books don't form a single coherent market — they'd give a meaningless
  // "fair probability" if mixed.
  const bestByKey = new Map();
  // For Unders: indexed by player+market+line+book. Filled in pass 1, looked up in pass 2.
  const undersByKey = new Map();

  for (const bookmaker of event?.bookmakers || []) {
    if (!bookmakerMatches(bookmaker, preferredBook)) continue;
    for (const market of bookmaker.markets || []) {
      if (!overMarketKeys.includes(market.key)) continue;

      for (const outcome of market.outcomes || []) {
        const player = outcome.description || outcome.name;
        if (!player || player === "Over" || player === "Under") continue;

        const price = Number(outcome.price);
        if (!price || price <= 1) continue;

        // An outcome is an Over if either (a) its name explicitly says "Over",
        // or (b) the market key has "_over" AND the outcome wasn't explicitly
        // marked "Under". The explicit-Under check is what stops AFL `_over`
        // markets from accidentally absorbing the Under price as an Over: a
        // bookmaker that posts `{name:"Under", description:"Joel Amartey",
        // price:1.03, point:5.5}` in `player_goals_scored_over` used to slip
        // through here (player===description→not skipped, isOver→true via the
        // `_over` shortcut), and the $1.03 under price would replace the real
        // $31 over on first-write or fight it on update. Downstream that
        // poisoned the EB prior (priorProb ≈ 0.97), pushing 0/10-hit legs to
        // ~67% confidence — the Task #106 pathology.
        const isUnder = outcome.name === "Under";
        const isOver =
          outcome.name === "Over" ||
          (!isUnder && market.key.includes("_over"));
        const bookKey = `${player}-${market.key}-${outcome.point}-${bookmaker.key}`;

        if (!isOver) {
          // Stash the Under for same-book pairing
          undersByKey.set(bookKey, price);
          continue;
        }

        // Dedup on player+metric+line (NOT player+marketKey+line) so the NBA
        // standard market and its alternate variant for the same line collapse
        // into one prop. E.g. `Wembanyama 24.5+ points` at $1.55 via
        // player_points_alternate vs $1.50 via player_points → one prop kept,
        // best price wins. Without this collapse, the candidate pool would
        // double up and the combo search would see noise.
        const metric = metricFromMarket[market.key] || "disposals";
        const key = `${player}-${metric}-${outcome.point}`;
        const existing = bestByKey.get(key);
        if (existing && price <= existing.odds) continue;

        bestByKey.set(key, {
          playerName: player,
          metric,
          marketKey: market.key,
          line: outcome.point,
          odds: price,
          // Remember which book gave this best Over price + its bookKey so we can
          // pair it with the Under from that SAME book in a second pass.
          bookmaker: bookmaker.title,
          bookKey,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          gameLabel: `${event.homeTeam} vs ${event.awayTeam}`,
        });
      }
    }
  }

  // Pass 2: attach the Under price from the same book that's offering our best
  // Over. If that book didn't expose an Under (some books only post the Over),
  // leave it null — de-vig in enrichProps falls back to raw 1/odds.
  for (const prop of bestByKey.values()) {
    prop.underOdds = undersByKey.get(prop.bookKey) ?? null;
    delete prop.bookKey; // internal — not useful downstream
  }

  props.push(...bestByKey.values());
  return props;
}

// ── Game environment (pace + blowout) ──────────────────────────────────────
// Counting stats scale with how a game flows. Two signals from the team markets
// we already fetch:
//   • total (combined points line) → pace. A higher-total game means more
//     scoring/possessions, so more disposals/points to go round.
//   • spread → blowout risk. A heavy favourite/underdog raises the chance of
//     garbage time and star rest, which add downside + variance.
// Folded into ONE gentle, clamped multiplier on the empirical probability
// (±8% max) — a nudge like the matchup and rest factors, never a driver.
// Baselines/elasticities are deliberately conservative and tunable; validate
// the effect via scripts/backtest.mjs once it accrues data.
const GAME_ENV = {
  AFL: { baselineTotal: 165, paceElasticity: 0.25, blowoutSpread: 39, blowoutDamp: 0.97 },
  NBA: { baselineTotal: 225, paceElasticity: 0.5, blowoutSpread: 13, blowoutDamp: 0.97 },
};

// Pull the total (points line) + each team's spread from an event's team
// markets. Median across books for robustness.
function extractGameEnv(event) {
  const totals = [];
  const spreadsByTeam = {};
  for (const bm of event?.bookmakers || []) {
    for (const m of bm.markets || []) {
      if (m.key === "totals") {
        for (const o of m.outcomes || []) if (o.point != null) totals.push(Number(o.point));
      } else if (m.key === "spreads") {
        for (const o of m.outcomes || []) {
          if (o.name && o.point != null) (spreadsByTeam[o.name] ||= []).push(Number(o.point));
        }
      }
    }
  }
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const spreads = {};
  for (const [team, pts] of Object.entries(spreadsByTeam)) spreads[team] = median(pts);
  return { total: median(totals), spreads };
}

// The spread for the side a player is on. matchedTeam is the afltables name;
// the spreads map is keyed by Odds API names, so match loosely (one is usually
// a substring of the other: "West Coast" ⊂ "West Coast Eagles").
function sideSpread(env, prop, matchedTeam) {
  if (!env?.spreads || !matchedTeam) return null;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  const t = norm(matchedTeam);
  for (const side of [prop.homeTeam, prop.awayTeam]) {
    const ns = norm(side);
    if (ns && (ns.includes(t) || t.includes(ns))) return env.spreads[side] ?? null;
  }
  return null;
}

// Single clamped multiplier from pace (total) + blowout (spread). env carries
// the sport so we pick the right baseline. Returns 1 (no-op) when env is absent.
function computeGameEnvFactor(env, prop, matchedTeam) {
  const cfg = env && GAME_ENV[env.sport];
  if (!cfg || env.total == null) return 1;
  let f = 1 + cfg.paceElasticity * (env.total / cfg.baselineTotal - 1);
  const sp = sideSpread(env, prop, matchedTeam);
  if (sp != null && Math.abs(sp) >= cfg.blowoutSpread) f *= cfg.blowoutDamp;
  return Math.max(0.92, Math.min(1.08, f));
}

function impliedProbFromOdds(odds) {
  const value = Number(odds);
  return value > 1 ? 1 / value : null;
}

// De-vig the implied probability using the matching Under price from the same
// bookmaker. Raw 1/odds_over bakes in the book's margin (typically 3–8%), so
// our +EV calculation systematically understates edge. The fair probability is
// p_over / (p_over + p_under), which removes the vig assuming it's split
// proportionally between the two sides. Falls back to raw if Under not
// available (some books only post Over).
function fairProbFromOverUnder(oddsOver, oddsUnder) {
  const pOver = impliedProbFromOdds(oddsOver);
  if (pOver == null) return null;
  const pUnder = impliedProbFromOdds(oddsUnder);
  if (pUnder == null || pUnder <= 0) return pOver;
  return pOver / (pOver + pUnder);
}

function computeHitRate(values, line) {
  if (!values?.length || line == null) return null;
  const hits = values.filter((v) => v >= line).length;
  return { hits, total: values.length, prob: hits / values.length };
}

// Exponentially-weighted hit rate. `values` is most-recent first (game[0] is
// the latest game). Returns effective hits / effective total — both floats —
// so the empirical-Bayes shrinkage downstream still works without changes.
// A "hot streak" 4 games ago will count for less than the same streak now.
// Decay = 0.85 → game 0 weighs 1.0, game 4 weighs 0.52, game 9 weighs 0.23.
function weightedHitRate(values, line, decay = 0.85) {
  if (!values?.length || line == null) return null;
  let wHits = 0;
  let wTotal = 0;
  for (let i = 0; i < values.length; i++) {
    const w = Math.pow(decay, i);
    wTotal += w;
    if (values[i] >= line) wHits += w;
  }
  return { hits: wHits, total: wTotal, prob: wHits / wTotal };
}

// Clearance "z-score": how comfortably a player clears the line, accounting for
// BOTH margin and consistency — (mean − line) / stdev. A high value means the
// player sits well above the line with low game-to-game variance (a safe leg);
// near 0 means they scrape over and one quiet game tips them under. Hit rate
// alone can't tell a "10/10 by one disposal" leg from a "10/10 by eight" leg —
// this can. Roughly, Φ(−z) ≈ the chance of a down game (z≈1 → ~16%, z≈1.65 →
// ~5%). Used to prefer cushiony legs (Best Chance) and shown per-leg in the UI.
//
// Returns the MORE CONSERVATIVE of two views, so a leg only scores well if BOTH
// hold:
//   1. SPREAD view — recency-weighted (mean − line) / stdev (decay 0.85, the
//      same the hit-rate streak logic uses): a comfortable average with low
//      game-to-game variance.
//   2. RECENT-FLOOR view — how far the WORST of the last 3 games sits above the
//      line, relative to the line. This catches players who clear on average but
//      have been HUGGING THE LINE lately (e.g. 17,17,19 on a 17+ line): the
//      spread view looks fine because older big games prop it up, but the recent
//      downside is thin and one quiet game tips them under.
// Without the floor view, "Adam Cerra 17+ (recent 17,17,19)" graded the same as
// a player clearing by 5 every week — which is the false comfort this fixes.
// Clamped to ±5. Values are most-recent-first.
// Marks & tackles: spiky low-count event stats whose HIT RATE is unreliable (fat
// lower tails — a 6-mark player still drops the odd 1-2 mark game). Low keeps the
// cushion "bulletproof" bar for THESE because a high hit rate alone can lie. Goals
// are excluded — they gate on hit rate like disposals. Everything else in Low gates
// purely on hit rate (see selectLegsForProfile).
const VOLATILE_METRICS = new Set(["marks", "tackles"]);

function clearanceZ(values, line, decay = 0.85) {
  if (line == null || !Array.isArray(values)) return null;
  const nums = values.map(Number).filter((v) => Number.isFinite(v));
  if (nums.length < 2) return null;
  const clamp = (z) => Math.max(-5, Math.min(5, z));

  // Spread view (recency-weighted z).
  let wSum = 0;
  let wMean = 0;
  for (let i = 0; i < nums.length; i++) {
    const w = Math.pow(decay, i);
    wSum += w;
    wMean += w * nums[i];
  }
  const mean = wMean / wSum;
  let wVar = 0;
  for (let i = 0; i < nums.length; i++) wVar += Math.pow(decay, i) * (nums[i] - mean) ** 2;
  const sd = Math.sqrt(wVar / wSum);
  const spreadZ = sd === 0 ? clamp(mean > line ? 5 : mean < line ? -5 : 0) : clamp((mean - line) / sd);

  // Recent-floor view: the worst of the last 5 games vs the line. The user's rule
  // for a safe cushion is "the line should sit ~2 below the smallest hit in the
  // last 5" — an ABSOLUTE margin (2 disposals is safe whether the line is 15 or
  // 25). Expressed as a % of the line, a 2-unit margin is ~13% at line 15 but
  // only ~8% at line 25, while a thin 1-below margin tops out at ~7% (line 15).
  // So the Solid cut (the Best Chance floor) sits at 7%: that grades every
  // "2+ below" line Solid and every "1 below" line Slim across the normal 15–28
  // disposal range, instead of penalising high lines just for being big.
  //   ≥13% ≈ Comfortable (~3 below)
  //   ≥7%  ≈ Solid       (~2 below)  ← Best Chance floor
  //   ≥3%  ≈ Slim        (~1 below — e.g. line 19, last-5 low 20)
  //   ≥0   ≈ On the line; a recent game under the line goes negative.
  if (line > 0) {
    const recentLow = Math.min(...nums.slice(0, 5));
    const fm = (recentLow - line) / line;
    const floorZ = fm >= 0.13 ? 1.5 : fm >= 0.07 ? 1.0 : fm >= 0.03 ? 0.6 : fm >= 0 ? 0.3 : clamp(fm * 10);
    return Math.min(spreadZ, floorZ);
  }
  return spreadZ;
}

// Plain-English cushion grade for a clearance z. Thresholds map to roughly the
// chance of a "down game" (a game under the line): Comfortable ≲7%, Solid
// ~7–16%, Slim ~16–27%, On the line >27%. Tuned for headline lines, which
// bookmakers price near a player's average, so most legs land Slim–Solid.
function cushionGrade(z) {
  if (z == null) return null;
  if (z >= 1.5) return "Comfortable";
  if (z >= 1.0) return "Solid";
  if (z >= 0.6) return "Slim";
  return "On the line";
}

function parseOddsValue(targetOdds) {
  const value = parseFloat(String(targetOdds).replace(/[^0-9.]/g, ""));
  return isNaN(value) ? null : value;
}

function propKey(prop) {
  return `${prop.playerName}|${prop.metric}|${prop.line}`;
}

// Lightweight AFL position inference from the player's recent stat profile.
// Returns "MID" | "FWD" | "DEF" | "RUC" | "UTIL". Heuristic, not official —
// a forward currently playing through the midfield will tag MID (which is
// what we actually want for predicting his production tonight). The order
// of checks matters: rucks are unambiguous (only they rack hitouts), then
// volume mids, then forwards by goal output, then defenders by low-goal
// possession profiles. Anything that doesn't fit cleanly falls through to
// UTIL rather than being mis-tagged.
function inferAFLPosition(matched) {
  const m = matched?.metrics || {};
  const avg = (key) => m[key]?.avg10 ?? m[key]?.recentAvg ?? null;
  const disposals = avg("disposals") ?? 0;
  const hitouts = avg("hitouts") ?? 0;
  const marks = avg("marks") ?? 0;
  const goals = avg("goals") ?? 0;
  const tackles = avg("tackles") ?? 0;
  const clearances = avg("clearances") ?? 0;

  if (hitouts >= 10) return "RUC";
  // Volume mids (Berry, Dawson) or inside mids who clear more than they collect
  if (disposals >= 22 || (disposals >= 16 && clearances >= 3)) return "MID";
  // Forwards: goal-scorers OR mark-heavy targets, low possession volume
  if ((goals >= 0.5 || marks >= 3.5) && disposals < 18) return "FWD";
  // Defenders: rebound runners with low goal output and moderate tackles
  if (disposals >= 8 && disposals < 18 && goals < 0.4) return "DEF";
  return "UTIL";
}

function matchStatsForProp(prop, statsMap) {
  const normName = String(prop.playerName || "").toLowerCase();
  const propWords = normName.split(" ").filter(Boolean);
  const propLast = propWords[propWords.length - 1];
  const propFirst = propWords[0] || "";
  if (!propLast || !propFirst) return null;

  for (const [key, stats] of statsMap.entries()) {
    const keyWords = key.split(" ").filter(Boolean);
    const keyLast = keyWords[keyWords.length - 1];
    if (!keyLast || keyLast !== propLast) continue;
    const keyFirst = keyWords[0] || "";
    // Require the FULL first name to agree (or one to be a prefix of the other,
    // covering "Matt"/"Matthew" and abbreviated feed names). Matching on the
    // first initial alone wrongly tied e.g. Luke McDonald to another L. McDonald
    // from a different club — giving the wrong crest AND the wrong form stats.
    if (keyFirst === propFirst || keyFirst.startsWith(propFirst) || propFirst.startsWith(keyFirst)) {
      return stats;
    }
  }
  return null;
}

// Attach probability, edge and recent-form numbers to each prop
function enrichProps(props, aflStats, factors = null, calibrationCurve = null, gameEnv = null) {
  const statsMap = new Map();
  for (const ps of aflStats?.players || []) {
    statsMap.set(String(ps.player || "").toLowerCase(), ps);
  }

  // Pass 1: match each prop to its stats (gives the player's team) and map each
  // game to the teams in it, so a player's opponent is the other team in the game.
  const matchedList = props.map((prop) => matchStatsForProp(prop, statsMap));
  const gameTeams = new Map();
  props.forEach((prop, i) => {
    const team = matchedList[i]?.team;
    if (!team) return;
    if (!gameTeams.has(prop.gameLabel)) gameTeams.set(prop.gameLabel, new Set());
    gameTeams.get(prop.gameLabel).add(team);
  });

  // Pass 2: enrich. The displayed hit rates stay ACTUAL; only the confidence
  // (empirical probability) is matchup-adjusted for the opponent's defence.
  return props.map((prop, i) => {
    const matched = matchedList[i];
    const ms = matched?.metrics?.[prop.metric];

    if (!ms?.available) return { ...prop, statsAvailable: false };

    // Actual recent-form hit rates (shown in leg details as-is)
    const hr5 = computeHitRate(ms.last5Values, prop.line);
    const hr10 = computeHitRate(ms.last10Values, prop.line);
    // De-vigged implied probability when we have both sides from the same book.
    // Falls back to raw 1/odds when Under isn't available. Used both as the
    // headline "fair price" AND as the Bayesian prior for the empirical estimate
    // (see below).
    const impliedRaw = impliedProbFromOdds(prop.odds);
    const implied = fairProbFromOverUnder(prop.odds, prop.underOdds);

    // Opponent = the other team in this game; factor = how much they concede on
    // this metric vs league average (1 = neutral / unknown).
    let opponent = null;
    let matchupFactor = 1;
    if (matched?.team && gameTeams.has(prop.gameLabel)) {
      const teams = [...gameTeams.get(prop.gameLabel)];
      if (teams.length === 2) opponent = teams.find((t) => t !== matched.team) || null;
    }
    if (factors && opponent && factors[opponent] && factors[opponent][prop.metric] != null) {
      matchupFactor = factors[opponent][prop.metric];
    }

    // Empirical-Bayes shrinkage toward the bookmaker's de-vigged implied
    // probability. The book has more data than we do (injuries, lineup news,
    // sharp action), so their fair price is a strong Bayesian prior; our form
    // data updates that prior. Falls back to a 0.5 prior when implied isn't
    // available (very rare).
    //
    // Why this matters: a flat 0.5 prior is wrong for non-median lines. A
    // player who hit "4+ marks" in 10/10 recent games at a $1.04 line is a
    // ~95% chance, not the 78% that shrinking-to-0.5 would say. The book
    // already knows that — pricing it at 96% — and our form confirms it. So
    // confidence should land near 95-97%, edge near zero. Conversely a real
    // hot streak vs a typical headline line (book ~50/50) still surfaces as
    // edge because the prior is moderate.
    //
    // Prior weight 6 = "treat the book like 6 games of evidence". A 10-game
    // strong-vs-book signal still moves the estimate meaningfully (16-game
    // weighted blend); a 3-game streak barely shifts it.
    const PRIOR_WEIGHT = 6;
    // Prior fallback order: de-vigged implied (best), raw 1/odds (still
    // directional), then 0.5 (truly no information). The old fallback to 0.5
    // for ANY null implied was unsafe for long-shot markets — e.g. a $31 leg
    // where the de-vigging path returns null would borrow a 50% prior instead
    // of the obvious 3.2% from impliedRaw, inflating empirical for 0-hit legs.
    const priorProb =
      implied != null ? implied : impliedRaw != null ? impliedRaw : 0.5;
    const smoothed = (hr) =>
      hr ? (hr.hits + priorProb * PRIOR_WEIGHT) / (hr.total + PRIOR_WEIGHT) : null;
    const blend = (a, b) => (a != null && b != null ? a * 0.4 + b * 0.6 : b != null ? b : a);

    // Time-weighted hit rates feed the empirical calculation — last game weighs
    // more than five-games-ago. The raw hr5/hr10 above stay unweighted for
    // display ("Cleared this line in 7/10 recent games" reads cleanly).
    const whr5 = weightedHitRate(ms.last5Values, prop.line);
    const whr10 = weightedHitRate(ms.last10Values, prop.line);

    // Base (unadjusted) empirical from the weighted hit rates
    const empBase = blend(smoothed(whr5), smoothed(whr10));

    // Matchup-adjusted via value-scaling — accurate for continuous lines (e.g. ~25
    // disposals), where nudging the values flips some games across the line.
    const scaleVals = (vals) =>
      matchupFactor === 1 ? vals || [] : (vals || []).map((v) => v * matchupFactor);
    const empScaled = blend(
      smoothed(weightedHitRate(scaleVals(ms.last5Values), prop.line)),
      smoothed(weightedHitRate(scaleVals(ms.last10Values), prop.line))
    );

    let empirical = empScaled;
    // Value-scaling can't move binary/low lines (integer goals never cross a 0.5
    // line), which would show a matchup that does nothing. In that case apply the
    // factor in probability space so the matchup actually counts — and the displayed
    // "concedes ±X%" stays truthful.
    if (
      matchupFactor !== 1 &&
      empBase != null &&
      empScaled != null &&
      Math.abs(empScaled - empBase) < 1e-9
    ) {
      empirical = Math.max(0.02, Math.min(0.98, empBase * matchupFactor));
    }

    // Rest-days adjustment — AFL teams play on 5-day to 9-day cycles, and
    // short-rest games tend to underperform. We approximate by checking the
    // gap between the player's last logged game and today. The penalty is
    // gentle (max ±4%) so it nudges rather than dominates the model.
    //   ≤4 days = short rest:        ×0.96 (slightly worse)
    //    5-6 days = normal:          ×1.00 (unchanged)
    //    7-9 days = full week+:      ×1.02 (slightly fresher)
    //   ≥14 days = stale/returning:  ×0.96 (back from injury or layoff)
    const restDays = matched?.lastGameDate
      ? Math.floor((Date.now() - new Date(matched.lastGameDate + "T00:00:00").getTime()) / 86400000)
      : null;
    let restFactor = 1;
    if (restDays != null) {
      if (restDays <= 4) restFactor = 0.96;
      else if (restDays <= 6) restFactor = 1.00;
      else if (restDays <= 9) restFactor = 1.02;
      else if (restDays <= 13) restFactor = 1.00; // long week off, neutral
      else restFactor = 0.96;                     // returning from break/injury
    }
    if (restFactor !== 1 && empirical != null) {
      empirical = Math.max(0.02, Math.min(0.98, empirical * restFactor));
    }

    // Game environment: nudge for pace (game total) + blowout risk (spread).
    const env = gameEnv && typeof gameEnv.get === "function" ? gameEnv.get(prop.gameLabel) : null;
    const gameEnvFactor = computeGameEnvFactor(env, prop, matched?.team);
    if (gameEnvFactor !== 1 && empirical != null) {
      empirical = Math.max(0.02, Math.min(0.98, empirical * gameEnvFactor));
    }

    // Evidence ceiling: when the player has cleared the line in zero of the
    // last N games (N ≥ 5), the EB shrinkage shouldn't be allowed to keep
    // confidence high just because the prior says so. Hard-cap empirical at
    // 15% regardless of the book's headline price — if the book says 95%
    // but the player hasn't hit it in 10 games, *something* is off
    // (mispriced market, role change, wrong-metric match, prop.odds got the
    // under-side price) and we shouldn't pretend to be confident.
    //
    // Defense-in-depth alongside selectOptimalLegs' 0/10 reject and the
    // prior-fallback fix above. Bounded by hr10.hits — legitimate hot
    // streaks (any hit ≥ 1) keep their EB-shrunk confidence untouched.
    if (
      empirical != null &&
      hr10 != null &&
      hr10.hits === 0 &&
      hr10.total >= 5
    ) {
      empirical = Math.min(empirical, 0.15);
    }

    // Apply the fitted isotonic calibration curve if one's loaded. Prefers
    // the per-market curve when available (e.g. AFL disposals gets its own
    // curve separate from AFL goals), falls back to the global per-sport
    // curve, falls through to the raw empirical untouched when no curves
    // are loaded yet. scripts/recalibrate.mjs refits weekly.
    const curveForLeg = pickCurveForMetric(calibrationCurve, prop.metric);
    const rawEmpirical = empirical;
    const calibratedEmpirical = curveForLeg && empirical != null
      ? Math.max(0.02, Math.min(0.98, applyCalibrationCurve(curveForLeg, empirical)))
      : empirical;
    const calibratedKind = curveForLeg ? (calibrationCurve?.markets?.[prop.metric] ? "per-market" : "global") : null;

    const edge = calibratedEmpirical != null && implied != null ? calibratedEmpirical - implied : null;

    // Tag with inferred position (AFL only for now — NBA is a follow-up
    // once we pick a heuristic that holds up in modern position-less ball).
    // Computed from the player's broader stat profile, not the prop's own
    // metric. The presence of disposals data is the AFL signal (NBA stats
    // never include a `disposals` key); the multi-build call site adds the
    // indicator metrics to the stats fetch for AFL automatically.
    const position = matched?.metrics?.disposals?.available
      ? inferAFLPosition(matched)
      : null;

    return {
      ...prop,
      statsAvailable: true,
      team: matched?.team || null,
      position,
      formAsOf: matched?.lastGameDate || null,
      opponent,
      matchupFactor,
      recentAvg: ms.recentAvg,
      avg10: ms.avg10,
      last5Values: ms.last5Values || [],
      // Sent to the frontend so the leg row can render one dot per game in
      // chronological order (rightmost = most recent). Most-recent-first.
      last10Values: ms.last10Values || [],
      sampleSize: (ms.last10Values || []).length,
      hr5,
      hr10,
      implied,        // fair (de-vigged) probability used for edge calc
      impliedRaw,     // raw 1/odds — kept for transparency/diagnostics
      empirical: calibratedEmpirical,
      rawEmpirical,   // pre-calibration value, kept for diagnostics
      calibrated: calibratedKind,  // "per-market" | "global" | null
      restDays,       // days since the player's last logged game
      restFactor,     // multiplier applied to empirical for rest adjustment
      gameEnvFactor,  // pace (total) + blowout (spread) multiplier on empirical
      gameTotal: env?.total ?? null,
      edge,
      margin: ms.recentAvg != null ? Number((ms.recentAvg - prop.line).toFixed(1)) : null,
      // Recency-weighted clearance z — how comfortably (margin + consistency)
      // the player clears this line. Drives the Best Chance cushion preference
      // and is surfaced per-leg in the UI. Computed once here so every consumer
      // (selection AND display) reads the same number.
      //
      // prop.line is the bookmaker's POINT (e.g. 1.5 for an "Over 1.5" = "2+"
      // market). To CLEAR it the player must reach the next integer (2), and the
      // cushion measures margin — so it must use that integer threshold. Using the
      // raw .5 point overstated the cushion badly on low-count stats: a 2+ tackles
      // line (point 1.5) with a worst game of 2 read as "0.5 above 1.5 = 33% =
      // Comfortable" when it's really ON the line (2 vs a threshold of 2). On
      // disposals the half-point is noise (~2.5% of 20), which is why only the
      // low-count props (marks/tackles/goals) were grading wrong. Hit rates are
      // unaffected — >=1.5 and >=2 count identically for integer stats.
      cushionZ: clearanceZ(ms.last10Values, Math.floor(prop.line) + 1),
      // Absolute units of room: the WORST of the last 5 over the integer threshold.
      // The teeth of the Best Chance "bulletproof" bar for volatile stats — a low
      // line can fake a big % cushion, this measures real margin (e.g. worst-of-5 = 6
      // on a 4+ line -> +2).
      floorMargin: (() => {
        const r5 = (ms.last10Values || []).map(Number).filter(Number.isFinite).slice(0, 5);
        return r5.length ? Math.min(...r5) - (Math.floor(prop.line) + 1) : null;
      })(),
    };
  });
}

// === Best Chance: greedy "anchor deep, climb one line at a time" builder ===
// Follows the agreed workflow exactly (see best-chance-workflow.html):
//   ① pick the lineup = the players with the most cushion HEADROOM (room to climb
//      while staying Solid+);  ② anchor each at his deepest line (max cushion);
//   ③ within ±20c of target? → done;  ④ under → bump the highest-headroom player
//   up ONE line (stays Solid), repeat — at his Solid ceiling, move to the next;
//   ⑤ all maxed & still short → swap the lowest-odds leg for a fresh bench player;
//   ⑥ bench exhausted → return the safest build (the caller flags "add a game").
// Deterministic and traceable by hand — replaces the old combinatorial search.
function selectBestChanceGreedy(enriched, targetOddsValue, wantCount) {
  const T = targetOddsValue;
  if (!(T > 1)) return [];
  const WINDOW = 0.20; // ±20c target window

  // Eligible Solid+ lines grouped by player (same floors as the Best Chance tier:
  // 8/10 form, ≥60% confidence, Solid cushion, ≥5 games of sample).
  const byPlayer = new Map();
  for (const p of enriched) {
    if (!p.statsAvailable || p.empirical == null) continue;
    if (!(Number(p.odds) > 1)) continue;
    if (!p.hr10 || p.hr10.total < 5 || p.hr10.hits === 0) continue;
    if (p.hr10.hits / p.hr10.total < 0.8) continue; // 8/10 form
    if ((p.empirical ?? 0) < 0.6) continue;          // confidence
    if ((p.cushionZ ?? -99) < 1.0) continue;         // Solid+ cushion (consistency floor)
    // The "line ~2 below the worst of the last 5" rule, as an ABSOLUTE buffer so a low
    // line can't fake safety with a big % (12+ off a worst-of-5 of 13 is only +1 — "on
    // the line" — so it's dropped, and the builder picks a deeper line for that player).
    if ((p.floorMargin ?? -99) < 2) continue;
    // Volatile event stats (marks/tackles/goals) are extra spiky — on top of the +2
    // buffer, hold them to a Comfortable cushion, 9/10 form and 75% empirical.
    if (VOLATILE_METRICS.has(p.metric)) {
      if ((p.cushionZ ?? -99) < 1.5) continue;
      if (!p.hr10 || p.hr10.hits / p.hr10.total < 0.9) continue;
      if ((p.empirical ?? 0) < 0.75) continue;
    }
    const arr = byPlayer.get(p.playerName) || [];
    arr.push(p);
    byPlayer.set(p.playerName, arr);
  }

  // Per player: lines shortest→longest (deepest cushion first). The longest is his
  // Solid ceiling (~2 below worst-of-5); headroom = how far he can climb in log-odds.
  const players = [];
  for (const [name, lines] of byPlayer) {
    lines.sort((a, b) => Number(a.odds) - Number(b.odds));
    const headroom = Math.log(Number(lines[lines.length - 1].odds)) - Math.log(Number(lines[0].odds));
    players.push({ name, lines, idx: 0, headroom, deep: lines[0].cushionZ ?? 0 });
  }
  if (players.length < 2) return [];
  // Lineup order: most headroom first (safest to climb), then deepest cushion.
  players.sort((a, b) => b.headroom - a.headroom || b.deep - a.deep);

  // ① Starting leg count: enough deep legs that the target sits in the bumpable
  // range (log base ~1.14 ≈ a moderately-deep leg → $2≈5, $3≈8). A pinned leg
  // count overrides. Bounded [2..min(players,12)].
  let N = wantCount && wantCount >= 2 ? wantCount : Math.round(Math.log(T) / Math.log(1.14));
  N = Math.max(2, Math.min(N, players.length, 12));
  let active = players.slice(0, N);
  const bench = players.slice(N);
  const combined = () => active.reduce((a, pl) => a * Number(pl.lines[pl.idx].odds), 1);

  // Guard: deepest anchor already OVER target (a low target) → drop the leg adding
  // the most odds until back inside the window (skip if a leg count was pinned).
  while (!wantCount && active.length > 2 && combined() > T + WINDOW) {
    let hi = 0;
    for (let i = 1; i < active.length; i++) {
      if (Number(active[i].lines[active[i].idx].odds) > Number(active[hi].lines[active[hi].idx].odds)) hi = i;
    }
    active.splice(hi, 1);
  }

  // ④/⑤ Bump (climb lines) then swap (change players) until in the window or exhausted.
  let guard = 0;
  while (combined() < T - WINDOW && guard++ < 1000) {
    // Highest-headroom player not yet at his Solid ceiling → climb him one line.
    let best = -1, bestRoom = -1;
    for (let i = 0; i < active.length; i++) {
      const pl = active[i];
      if (pl.idx < pl.lines.length - 1) {
        const room = Math.log(Number(pl.lines[pl.lines.length - 1].odds)) - Math.log(Number(pl.lines[pl.idx].odds));
        if (room > bestRoom) { bestRoom = room; best = i; }
      }
    }
    if (best >= 0) {
      active[best].idx += 1;
      continue;
    }
    // All maxed & still short → swap the lowest-odds leg for the highest-ceiling
    // bench player (raises what's reachable). Pinned count keeps the leg count.
    if (bench.length) {
      let lo = 0;
      for (let i = 1; i < active.length; i++) {
        if (Number(active[i].lines[active[i].idx].odds) < Number(active[lo].lines[active[lo].idx].odds)) lo = i;
      }
      bench.sort((a, b) => Number(b.lines[b.lines.length - 1].odds) - Number(a.lines[a.lines.length - 1].odds));
      const incoming = bench.shift();
      incoming.idx = 0;
      active.splice(lo, 1, incoming);
    } else {
      break; // ⑥ pool exhausted → safest build we've got
    }
  }

  return active.map((pl) => ({ ...pl.lines[pl.idx] }));
}

// Deterministically pick the strongest legs for the target and risk profile.
// Wraps selectLegsForProfile with progressive relaxation: if the requested tier
// can't get within ±30c of the target AND clear its combined-chance floor, drop
// one tier and retry. The result is tagged `profileUsed` vs `profileRequested`
// so the UI can surface a "couldn't hit target at Balanced — relaxed to
// Aggressive" note.
function selectOptimalLegs(enriched, targetLegs, targetOddsValue, riskProfile) {
  // Best Chance now runs through the same combinatorial search as the other tiers,
  // but with a max-COMBINED-CHANCE objective + a 60% floor (see selectLegsForProfile).
  // The old "anchor deep, climb" greedy maximised cushion DEPTH, which stacked
  // low-edge deep legs and dragged the combined chance BELOW Balanced — the exact
  // bug we're fixing. (selectBestChanceGreedy is retained but no longer called.)
  const RELAX_CHAIN = {
    // Best Chance never relaxes — it keeps its safety floors and builds the
    // closest SAFE multi it can (the UI flags "add a game" if it falls short).
    "Best Chance": ["Best Chance"],
    // Balanced can drop to Aggressive to reach the target when its own floors
    // can't; tagged so the UI shows the relax note.
    Balanced: ["Balanced", "Aggressive"],
    Aggressive: ["Aggressive"],
  };
  const RELAX_NEAR = 0.30; // within ±30c of the target counts as "hit"
  // Per-profile combined-chance floor for the WHOLE multi — stops a tier
  // relaxing into a technically-on-target but very unlikely combo. Best Chance
  // needs none (its objective already maximises combined chance); Balanced wants
  // at least a coin-flip; Aggressive is unconstrained.
  const MIN_COMBINED_PROB = {
    "Best Chance": 0.60,  // the chance floor — enforced inside selectLegsForProfile (sort + cap)
    Balanced: 0.50,
    Aggressive: 0,
  };
  const chain = RELAX_CHAIN[riskProfile] || [riskProfile];

  let best = [];
  let usedProfile = riskProfile;
  for (const profile of chain) {
    const candidate = selectLegsForProfile(enriched, targetLegs, targetOddsValue, profile);
    if (!candidate.length) continue;
    // First non-empty result becomes the fallback so we always return something.
    if (!best.length) {
      best = candidate;
      usedProfile = profile;
    }
    if (!targetOddsValue) break;
    const combinedOdds = candidate.reduce((a, p) => a * Number(p.odds), 1);
    const combinedProb = candidate.reduce((a, p) => a * (p.empirical ?? 0), 1);
    const minProb = MIN_COMBINED_PROB[profile] ?? 0;
    // Stop relaxing once we land at or above BOTH the target tolerance AND
    // the profile's combined-confidence floor. The combo search already
    // prefers closeness-to-target; the prob check is what catches the
    // "Safer multi at 62% combined confidence" pathology the user flagged.
    const targetMet = Math.abs(combinedOdds - targetOddsValue) <= RELAX_NEAR;
    const probMet = combinedProb >= minProb;
    if (targetMet && probMet) {
      best = candidate;
      usedProfile = profile;
      break;
    }
  }

  // Attach metadata so the response layer can surface a "relaxed from Safer
  // to Balanced" note. Arrays are objects in JS so the extra properties don't
  // affect normal iteration/length semantics.
  best.profileUsed = usedProfile;
  best.profileRequested = riskProfile;
  return best;
}

function selectLegsForProfile(enriched, targetLegs, targetOddsValue, riskProfile) {
  // ===================== RISK LADDER =====================
  // Three tiers, each a clean relaxation of the one above. All three target the
  // requested odds within a flat ±30c window (see NEAR below).
  //
  //   Best Chance — "safest, most likely to land"
  //     8/10 form · ≥88% model chance (the near-lock gate) · bulletproof marks/tackles
  //     objective: highest combined CHANCE within ±30c, with a 60% chance floor
  //     (caps short of target rather than drop below 60%; flagged to the user)
  //     NB: form is 8/10 not 9/10 — 9/10 only passed each player's single deepest
  //     line, so Low could never climb onto a normal target. The 88% gate + 60%
  //     combined floor are what keep it safe; form is just a sanity check now.
  //   Balanced — "strong form, best value"
  //     8/10 form · no-negative cushion · 55% conf
  //     objective: highest combined EDGE (most underpriced) within ±30c
  //   Aggressive — "reach the target, chase edge"
  //     5/10 form · no cushion · 45% conf
  //     objective: closest to target + edge
  //
  // minHitRate = raw recent-form floor (actual last-10 clears), distinct from
  // `minHit` (model-confidence floor) below. Every floored tier also needs >=5
  // games of sample (the hr10.total<5 reject), so 3/3-perfect noise can't sneak in.
  const minHitRate =
    // Best Chance = 8/10, NOT 9/10. 9/10 only ever passes a player's single DEEPEST line — a line near
    // their average clears ~5-6/10 — so every player collapsed to one ultra-short $1.05 near-lock and the
    // search had nothing longer to climb with: it stacked 6 near-locks to ~$1.33 and physically could not
    // reach a $2 target (returned the SAME build for $1.50/$2/$3). Low's real "near-lock" identity is the
    // 88% model-chance gate below; its real safety net is the 60% COMBINED-chance floor. 8/10 form keeps
    // every leg a strong favourite while letting Low climb its longer near-lock lines onto the target.
    riskProfile === "Best Chance" ? 0.8
    : riskProfile === "Balanced" ? 0.8    // 8/10 recent clears
    : riskProfile === "Aggressive" ? 0.5  // 5/10 — still cleared it at least half the time
    : 0.8; // unknown/legacy ("Safer" retired) -> safest floor

  // Sanity gate: reject any leg the player has never cleared in their last 10
  // games. Catches the "Joel Amartey 6+ goals at $31, 0/10 hit, 67% confidence"
  // class of bug where the model rates an impossible line confidently due to
  // a broken implied-prior fallback. If a player has literally never hit the
  // line recently, we don't trust the model to suddenly bless it — period.
  // (Tracked as Task #106 — the underlying confidence bug still needs fixing.)
  const candidates = enriched.filter((p) => {
    if (!p.statsAvailable || p.empirical == null) return false;
    if (!(Number(p.odds) > 1)) return false;
    if (p.sampleSize < 3) return false;
    // Drop legs with 0 hits across the last 10 games — the model is lying
    // about its confidence on these. Pre-existing bug, hard floor for now.
    if (p.hr10 && p.hr10.total >= 5 && p.hr10.hits === 0) return false;
    // Per-tier raw hit-rate floor (see minHitRate comment above)
    if (minHitRate > 0) {
      if (!p.hr10 || p.hr10.total < 5) return false;
      if (p.hr10.hits / p.hr10.total < minHitRate) return false;
    }
    // Best Chance gates on HIT RATE, not cushion depth: every leg must be a near-lock
    // (≥88% model chance). This cuts shaky / negative-edge legs (e.g. an 82% leg) while
    // admitting the safe 98% legs the old +2 cushion wrongly excluded for sitting "on
    // the line". (Form is already ≥9/10 via minHitRate above.)
    if (riskProfile === "Best Chance" && (p.empirical ?? 0) < 0.88) return false;
    // …except marks & tackles, whose hit rate genuinely lies (spiky low counts): they
    // additionally need the bulletproof cushion bar (≥2 below worst-of-5, Comfortable).
    if (riskProfile === "Best Chance" && VOLATILE_METRICS.has(p.metric)) {
      if ((p.floorMargin ?? -99) < 2) return false;
      if ((p.cushionZ ?? -99) < 1.5) return false;
    }
    return true;
  });

  const minHit =
    riskProfile === "Best Chance" ? 0.60   // safest tier shouldn't share a floor with Aggressive
    : riskProfile === "Balanced" ? 0.55
    : riskProfile === "Aggressive" ? 0.45
    : 0.60; // unknown/legacy -> safest
  const scoreOf = (p) => (p.empirical ?? 0) + Math.max(0, p.edge ?? 0) * 1.5;

  // Cushion floors (now meaningful after the integer-threshold fix):
  //   Best Chance — HARD Solid+ (cushionZ >= 1.0): every leg sits ~2 below the
  //     player's recent worst. Line-huggers (2+ marks/tackles with no margin) are
  //     dropped — that's the whole point of the tier.
  //   Balanced — LIGHT (cushionZ >= 0): drop only legs whose recent worst game
  //     fell BELOW the line (negative cushion), even at 8/10 form — keeps "best
  //     value" from grabbing a leg that clears often but craters hard.
  //   Aggressive — none.
  // Each relaxes back to the full pool if its floor would leave <2 distinct
  // players (a thin game still builds something); the cushion chip flags any leg
  // that slips through in that rare fallback.
  let selectionPool = candidates;
  // Best Chance no longer cushion-filters here — it gates on HIT RATE in `candidates`
  // (≥88% + 9/10), plus the cushion bar for marks/tackles. Balanced drops only legs
  // whose recent worst fell below the line (negative cushion).
  if (riskProfile === "Balanced") {
    const cushioned = candidates.filter((p) => (p.cushionZ ?? -99) >= 0);
    if (new Set(cushioned.map((p) => p.playerName)).size >= 2) selectionPool = cushioned;
  }

  // Keep up to a few candidate LINES per player (not just the single highest-score
  // one). A player's top-score line is often an ultra-short deep line (e.g. a mid
  // Over 16.5 disposals @ $1.03) that can't combine toward a normal target, which
  // used to force the build onto whatever DID fit (forwards' goal legs). Holding a
  // few lines per player lets the combo search pick the one that actually fits.
  // A multi still never repeats a player.
  const PER_PLAYER = 3;
  const linesByPlayer = new Map();
  for (const p of selectionPool) {
    const arr = linesByPlayer.get(p.playerName) || [];
    arr.push({ ...p, score: scoreOf(p) }); // cushionZ already carried from enrichProps
    linesByPlayer.set(p.playerName, arr);
  }
  const perPlayerLines = [];
  const bestPerPlayer = [];
  for (const arr of linesByPlayer.values()) {
    arr.sort((a, b) => b.score - a.score);
    bestPerPlayer.push(arr[0]);
    // Keep a SPREAD of lines per player so the combo search can fine-tune the
    // combined odds ONTO the target. Top-N by score holds the best legs, but we
    // MUST also keep each player's CHEAPEST (deepest cushion) AND LONGEST
    // qualifying line + a mid. Without the longer lines the search can only stack
    // near-locks (~$1.06) and undershoots — a 7-leg $2 build lands at $1.58.
    const kept = new Set(arr.slice(0, PER_PLAYER));
    const byOdds = [...arr].sort((a, b) => Number(a.odds) - Number(b.odds));
    kept.add(byOdds[0]);                                          // cheapest / deepest cushion
    kept.add(byOdds[byOdds.length - 1]);                         // longest qualifying line
    if (byOdds.length >= 3) kept.add(byOdds[Math.floor(byOdds.length / 2)]); // a mid line
    perPlayerLines.push(...kept);
  }

  const ordered = [
    ...bestPerPlayer.filter((p) => p.empirical >= minHit).sort((a, b) => b.score - a.score),
    ...bestPerPlayer.filter((p) => p.empirical < minHit).sort((a, b) => b.score - a.score),
  ];

  const wantCount =
    targetLegs === "Any" || !targetLegs ? null : Math.max(1, parseInt(targetLegs, 10) || 3);

  // No target odds: just honour the requested leg count by quality (one per player)
  if (!targetOddsValue) {
    return ordered.slice(0, wantCount || 3);
  }

  // Target odds set: search combinations (one leg per player) whose combined odds
  // land within a tolerance of the target. Tolerance widens only if no tighter combo
  // exists. Prefer requested leg count, then market variety, then highest chance.
  //
  // Shortlist construction has to balance two failure modes:
  //   (a) top-N by score alone gets dominated by near-locks (cheap lines, high
  //       form chance, modest edge), leaving no mid-odds legs to combine toward
  //       higher targets — a 3-leg \$5 target then under-shoots to ~\$2.50.
  //   (b) blindly pulling high-odds legs in pushes weak/low-confidence picks
  //       into the search, which can survive the combo search and degrade quality.
  // Resolution: bucket by odds and take top legs from each band. Near-locks
  // still dominate the cheap end (so Safer builds at low targets stay good)
  // but higher targets get genuine candidates at every price level.
  // Within each odds band the shortlist keeps the top legs by SCORE (chance + edge)
  // for every tier. Best Chance USED to rank these by cushion DEPTH, which filled the
  // near-locks band with deep legs and cut clean high-chance legs sitting "on the
  // line" (e.g. a 98% Erasmus 13+), forcing Low onto weaker/fewer legs. Hit rate, not
  // cushion, decides Low now — so it ranks by score like the others.
  const ranked = perPlayerLines.sort((a, b) => {
    const m = (b.empirical >= minHit) - (a.empirical >= minHit);
    if (m) return m;
    return b.score - a.score;
  });
  const oddsBands = [
    { min: 1.0, max: 1.3, take: 6 },   // near-locks
    { min: 1.3, max: 1.6, take: 5 },   // strong favourites
    { min: 1.6, max: 2.0, take: 5 },   // ~50/50 lines
    { min: 2.0, max: 3.0, take: 5 },   // longer
    { min: 3.0, max: Infinity, take: 3 }, // long shots
  ];
  const seen = new Set();
  const shortlist = [];
  for (const band of oddsBands) {
    let kept = 0;
    for (const p of ranked) {
      if (kept >= band.take) break;
      if (seen.has(p)) continue;
      const o = Number(p.odds);
      if (o >= band.min && o < band.max) {
        shortlist.push(p);
        seen.add(p);
        kept += 1;
      }
    }
  }
  if (!shortlist.length) return ordered.slice(0, wantCount || 3);

  // Per-team quota: ensure every team that has candidates is represented in
  // the shortlist with at least PER_TEAM_MIN legs. Without this, a
  // single-game build where one team's mids dominate every odds band leaves
  // the other team with zero shortlist slots — the team-diversity penalty
  // downstream then has no diverse combos to prefer. Pulls extras straight
  // from the ranked list (top-by-score for the underrepresented team).
  const PER_TEAM_MIN = 4;
  const allTeams = [...new Set(ranked.map((p) => p.team).filter(Boolean))];
  for (const team of allTeams) {
    let inShortlist = shortlist.filter((p) => p.team === team).length;
    if (inShortlist >= PER_TEAM_MIN) continue;
    for (const p of ranked) {
      if (inShortlist >= PER_TEAM_MIN) break;
      if (p.team !== team) continue;
      if (seen.has(p)) continue;
      shortlist.push(p);
      seen.add(p);
      inShortlist += 1;
    }
  }

  // Per-player line spread: ensure each player ALREADY in the shortlist also has
  // their LONGEST (and a MID) qualifying line — not just their deepest-cushion
  // shortest one. The cushion-first odds-band fill above keeps a player's shortest
  // lines and cuts the longer ones, which left the combo search unable to CLIMB a
  // line up to reach the target — a $2 build stalled at $1.43 on near-locks. With
  // the longer lines available it can bump e.g. Noah 20+ -> 23+ (still inside his
  // cushion) to hit the number instead of quitting short.
  for (const name of [...new Set(shortlist.map((p) => p.playerName))]) {
    const lines = ranked.filter((p) => p.playerName === name);
    if (lines.length < 2) continue;
    const byOdds = [...lines].sort((a, b) => Number(a.odds) - Number(b.odds));
    const extras = [byOdds[byOdds.length - 1]]; // longest qualifying line
    if (byOdds.length >= 3) extras.push(byOdds[Math.floor(byOdds.length / 2)]); // a mid line
    for (const leg of extras) {
      if (!seen.has(leg)) {
        shortlist.push(leg);
        seen.add(leg);
      }
    }
  }

  const minLegs = 2;
  // Cap legs to roughly what the target NEEDS. Low targets stay shallow so the
  // exhaustive search reliably finds the best near-target combo instead of
  // drowning in deep undershooting near-lock stacks; high targets reach further.
  // log base ~1.13 = a typical short Solid leg, an UPPER bound (fewer used when
  // longer lines fit): $2->7, $3->9, $5->12. Floor 7, hard cap 12.
  const distinctPlayers = new Set(shortlist.map((p) => p.playerName)).size;
  const legsForTarget = targetOddsValue ? Math.ceil(Math.log(targetOddsValue) / Math.log(1.13)) : 7;
  const maxLegs = Math.min(12, Math.max(7, legsForTarget), distinctPlayers);

  // Size of the largest single-team block in a combo (4 Hawks => 4). When the
  // combo search produces "all 4 legs same team" picks (which used to happen
  // a lot in same-game multis), the concentration risk goes up — if that team
  // gets blown out and chases tail in the last quarter, every leg can die
  // together. Same-game positive correlation already lifts the upside, but
  // the downside is real too. Tracked as a soft penalty (not a hard cap) so
  // the search still picks single-team stacks when they're genuinely the
  // best buildable combo, but prefers cross-team spread when one's available.
  const teamDominance = (legs) => {
    const counts = {};
    let max = 0;
    for (const l of legs) {
      const t = l.team || "?";
      counts[t] = (counts[t] || 0) + 1;
      if (counts[t] > max) max = counts[t];
    }
    return max;
  };

  // Size of the largest single-metric block in a combo (5 goals => 5)
  const metricDominance = (legs) => {
    const counts = {};
    let max = 0;
    for (const l of legs) {
      counts[l.metric] = (counts[l.metric] || 0) + 1;
      if (counts[l.metric] > max) max = counts[l.metric];
    }
    return max;
  };

  // How evenly priced the legs are (std dev of log-odds, bucketed). Discourages
  // "one long leg + filler near-locks" (e.g. a $1.86 leg carrying four $1.03s) in
  // favour of legs that spread the risk more evenly across the multi.
  const balanceBucket = (legs) => {
    const logs = legs.map((l) => Math.log(Number(l.odds)));
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    const variance = logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length;
    return Math.round(Math.sqrt(variance) / 0.1);
  };

  const NEAR = 0.30; // ±30c target window — also keeps this search lean (only in-window combos kept)
  const CHANCE_FLOOR = riskProfile === "Best Chance" ? 0.60 : 0; // Low: never present below 60% combined chance
  const combos = [];
  let closest = null;
  let capFallback = null; // longest build (highest odds, <= target) that still clears the chance floor
  let explored = 0; // safety valve: high targets (many legs) can't blow up the DFS
  const choose = (start, acc, players, accOdds) => {
    if (explored++ > 600000) return;
    if (acc.length >= minLegs) {
      const diff = Math.abs(accOdds - targetOddsValue);
      const prob = acc.reduce((a, p) => a * (p.empirical ?? 0), 1);
      // Combined market-implied prob -> the multi's EDGE (how underpriced the model
      // rates the whole combo). Drives the Balanced "best value" objective.
      const imp = acc.reduce((a, p) => a * (p.implied ?? p.impliedRaw ?? 1 / Number(p.odds)), 1);
      const edgeScore = prob - imp;
      const legPenalty = wantCount ? Math.abs(acc.length - wantCount) : 0;
      // Diversity: discourage stacking one metric (e.g. all goals). Allow up to
      // ~half the legs in any single market before penalising.
      const diversityPenalty = Math.max(0, metricDominance(acc) - Math.ceil(acc.length / 2));
      // Team diversity: only penalise *pure* single-team stacks (4-0 in a
      // 4-leg multi, 3-0 in a 3-leg, etc.). The earlier ceil(legs/2) shape
      // was too eager — it biased toward forced 2-2 even when a 3-1 split
      // had genuinely better value, which the user pushed back on ("I don't
      // want to force the builder to have an exact even split — just give
      // me the best selections from either team"). Two-leg multis never
      // penalised since same-team-pair is often the most-likely combo.
      const teamCapAllowed = Math.max(2, acc.length - 1);
      const teamPenalty = Math.max(0, teamDominance(acc) - teamCapAllowed);
      // Cushion of the combo: the weakest leg's clearance z (a multi is only as
      // safe as its shakiest leg) plus the total, used by the Best Chance sort.
      const czs = acc.map((l) => (l.cushionZ == null ? 0 : l.cushionZ));
      const minCushion = czs.length ? Math.min(...czs) : 0;
      const avgCushion = czs.length ? czs.reduce((s, z) => s + z, 0) / czs.length : 0;
      const cand = { legs: [...acc], prob, imp, edgeScore, diff, odds: accOdds, legPenalty, diversityPenalty, teamPenalty, balance: balanceBucket(acc), minCushion, avgCushion };
      if (diff <= NEAR) combos.push(cand);                  // keep only in-window combos (memory + a small sort)
      if (!closest || diff < closest.diff) closest = cand;  // closest tracked over ALL combos (the fallback)
      // Chance-floor cap: the longest build (highest odds, not past target) that still
      // clears the floor — used when nothing in the window stays >= the floor (Low only).
      if (CHANCE_FLOOR && prob >= CHANCE_FLOOR && accOdds <= targetOddsValue + NEAR && (!capFallback || accOdds > capFallback.odds)) capFallback = cand;
    }
    if (acc.length >= maxLegs) return;
    // Odds only grow as legs are added; once we've overshot the target there's no
    // point going deeper. Keeps the search bounded even with many lines per player.
    if (accOdds > targetOddsValue * 1.6) return;
    for (let i = start; i < shortlist.length; i++) {
      const cand = shortlist[i];
      if (players.has(cand.playerName)) continue; // never repeat a player
      acc.push(cand);
      players.add(cand.playerName);
      choose(i + 1, acc, players, accOdds * Number(cand.odds));
      players.delete(cand.playerName);
      acc.pop();
    }
  };
  choose(0, [], new Set(), 1);

  // ===== Target window: a flat ±30c around the requested odds, for EVERY tier =====
  // The odds you ask for is the odds you get, regardless of risk level. Within
  // that window each tier applies its own objective (the sort below). If nothing
  // lands inside ±30c (pool too thin / target unreachable) we fall back to the
  // single closest combo so we still return something — the UI flags the miss.
  // combos already holds only in-window (±30c) candidates (see NEAR in the search).
  let pool = wantCount ? combos.filter((c) => c.legs.length === wantCount) : combos.slice();
  if (!pool.length) pool = combos.slice();
  if (!pool.length) pool = closest ? [closest] : [];
  if (!pool.length) return ordered.slice(0, wantCount || 3);

  // Inside the ±30c window, lean toward "on target" (±15c) before the objective —
  // a COARSE split (not fine buckets) so a $1.90 and a $1.92 build count as equally
  // on-target and the objective decides, while a combo 28c off can't beat one 5c
  // off. (Fine buckets used to create a cliff where a 2c-closer 7-leg build beat a
  // far higher-chance 4-leg.)
  const ON_TARGET = NEAR / 2; // ±15c
  const bucketSize = targetOddsValue ? Math.max(0.10, targetOddsValue * 0.05) : 0.5;
  const diffBucket = (c) => Math.floor(c.diff / bucketSize);
  pool.sort((a, b) => {
    // Requested leg count always wins first (when the user pinned one).
    if (a.legPenalty !== b.legPenalty) return a.legPenalty - b.legPenalty;

    if (riskProfile === "Best Chance") {
      // Objective: the HIGHEST COMBINED CHANCE for the target, with a 60% floor.
      // (At a fixed target, max chance == max value; stacking deep low-edge legs
      // lowers the product, which is why the old "deepest cushion" sort fell BELOW
      // Balanced.) Every combo is already safe (the filter) and within ±30c.
      const aOk = (a.prob ?? 0) >= CHANCE_FLOOR, bOk = (b.prob ?? 0) >= CHANCE_FLOOR;
      if (aOk !== bOk) return aOk ? -1 : 1;                                       // ≥60% floor clears first
      const aband = Math.floor(a.diff / 0.20);
      const bband = Math.floor(b.diff / 0.20);
      if (aband !== bband) return aband - bband;                                 // near target (coarse 20c band)
      if (b.prob !== a.prob) return b.prob - a.prob;                             // HIGHEST combined chance
      if (a.legs.length !== b.legs.length) return a.legs.length - b.legs.length; // fewest legs (tiebreak)
      if (b.edgeScore !== a.edgeScore) return b.edgeScore - a.edgeScore;         // then value
      return a.diff - b.diff;                                                    // exact closest
    }

    if (riskProfile === "Balanced") {
      // BEST VALUE. Prefer on-target, then the most UNDERPRICED combo (highest
      // model-vs-market edge), then market/team diversity, then chance, then close.
      const aOn = a.diff <= ON_TARGET, bOn = b.diff <= ON_TARGET;
      if (aOn !== bOn) return aOn ? -1 : 1;
      if (b.edgeScore !== a.edgeScore) return b.edgeScore - a.edgeScore;
      if (a.diversityPenalty !== b.diversityPenalty) return a.diversityPenalty - b.diversityPenalty;
      if (a.teamPenalty !== b.teamPenalty) return a.teamPenalty - b.teamPenalty;
      if (b.prob !== a.prob) return b.prob - a.prob;
      return a.diff - b.diff;
    }

    // AGGRESSIVE (and any fallback). REACH the target — closest first — then chase
    // edge, keep it diverse and evenly priced.
    if (diffBucket(a) !== diffBucket(b)) return diffBucket(a) - diffBucket(b);
    if (b.edgeScore !== a.edgeScore) return b.edgeScore - a.edgeScore;
    if (a.diversityPenalty !== b.diversityPenalty) return a.diversityPenalty - b.diversityPenalty;
    if (a.teamPenalty !== b.teamPenalty) return a.teamPenalty - b.teamPenalty;
    if (a.balance !== b.balance) return a.balance - b.balance;
    return a.diff - b.diff;
  });
  // Chance floor: if nothing in the ±30c window stays ≥60%, the target is too long
  // to stay "Low" — return the longest build that DOES clear 60% (shorter than the
  // target) and flag it, rather than an on-target but sub-60% combo.
  let chosen = pool[0];
  const capped = !!(CHANCE_FLOOR && (chosen.prob ?? 0) < CHANCE_FLOOR && capFallback);
  if (capped) chosen = capFallback;
  const out = chosen.legs.sort((a, b) => b.score - a.score);
  out.chanceFloorCapped = capped;
  return out;
}

// ── Correlation-aware combined probability ───────────────────────────────
// Naively multiplying leg probabilities assumes independence. Player counting
// stats in the SAME match aren't independent: game pace / total possessions is a
// shared driver, so same-game "overs" tend to hit (or miss) together. We model
// this with a Gaussian copula + a small structural correlation matrix and
// estimate P(all legs hit) by seeded Monte-Carlo. Odds are unaffected — only the
// true combined chance (and therefore EV and risk) changes. For same-game,
// positively-correlated legs this RAISES the chance vs the naive product.
const POSSESSION_METRICS = new Set([
  // AFL — possession-family stats driven by game pace / ball movement
  "disposals", "kicks", "handballs", "marks", "clearances", "fantasy_points",
  // NBA — all counting stats correlate with game pace
  "points", "rebounds", "assists", "threes", "blocks", "steals",
]);

// Inverse standard-normal CDF (Acklam's rational approximation)
function probit(p) {
  const x = Math.min(1 - 1e-9, Math.max(1e-9, p));
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (x < plow) {
    q = Math.sqrt(-2 * Math.log(x));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (x <= phigh) {
    q = x - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - x));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// Small deterministic PRNG so the same build always yields the same estimate
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Cholesky decomposition (lower triangular), with tiny jitter for PD safety
function cholesky(matrix) {
  const n = matrix.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-9)) : sum / L[j][j];
    }
  }
  return L;
}

// Structural pairwise correlation between two legs. Different games => independent.
// Same game splits on team: teammates' possession volume rises together (team
// controls the ball); opponents' possession is partly zero-sum; teammates both
// kicking goals substitute for each other. Team is unknown when the player didn't
// match our stats — then we fall back to the neutral same-game game-pace estimate.
function pairCorrelation(a, b) {
  if (!a.game || !b.game || a.game !== b.game) return 0;

  const teamA = String(a.team || "").toLowerCase();
  const teamB = String(b.team || "").toLowerCase();
  const teamsKnown = Boolean(teamA && teamB);
  const sameTeam = teamsKnown && teamA === teamB;
  const opposing = teamsKnown && teamA !== teamB;

  const bothPossession = POSSESSION_METRICS.has(a.metric) && POSSESSION_METRICS.has(b.metric);
  const bothGoals = a.metric === "goals" && b.metric === "goals";

  if (bothPossession) {
    if (sameTeam) return 0.35;
    if (opposing) return -0.1;
    return 0.28; // team unknown — neutral same-game game-pace estimate
  }
  if (bothGoals) {
    if (sameTeam) return -0.1; // compete for the same goals
    return 0.05; // opposing / unknown — shared high-scoring game
  }
  // Mixed markets (one possession + one goals, tackles, etc.)
  if (opposing) return 0.02;
  return 0.08;
}

// P(all legs hit) under a Gaussian copula. items: [{prob, game, metric}].
// Falls back to the exact independence product when no pair shares a game.
function correlationAdjustedProb(items) {
  const n = items.length;
  if (n === 0) return 0;
  const product = items.reduce((acc, it) => acc * Math.max(0, Math.min(1, it.prob || 0)), 1);
  if (n === 1) return product;

  const R = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : pairCorrelation(items[i], items[j])))
  );
  const anyCorrelated = R.some((row, i) => row.some((v, j) => i !== j && v !== 0));
  if (!anyCorrelated) return product;

  const thresholds = items.map((it) => probit(Math.max(1e-6, Math.min(1 - 1e-6, it.prob || 0))));
  const L = cholesky(R);
  const seed = hashSeed(items.map((it) => `${it.game}|${it.team || ""}|${it.metric}|${Math.round((it.prob || 0) * 1000)}`).join("~"));
  const rand = mulberry32(seed);
  const nextNormal = () => {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const SAMPLES = 20000;
  const z = new Array(n);
  let hits = 0;
  for (let s = 0; s < SAMPLES; s++) {
    for (let i = 0; i < n; i++) z[i] = nextNormal();
    let all = true;
    for (let i = 0; i < n; i++) {
      let y = 0;
      for (let k = 0; k <= i; k++) y += L[i][k] * z[k];
      if (y > thresholds[i]) { all = false; break; }
    }
    if (all) hits++;
  }
  return hits / SAMPLES;
}

function computeCombinedMetrics(selected) {
  const combinedOdds = selected.reduce((acc, p) => acc * Number(p.odds), 1);
  const independentProb = selected.reduce((acc, p) => acc * (p.empirical ?? 0), 1);
  const combinedProb = correlationAdjustedProb(
    selected.map((p) => ({ prob: p.empirical ?? 0, game: p.gameLabel, metric: p.metric, team: p.team }))
  );
  const ev = combinedProb * combinedOdds - 1;
  return {
    combinedOdds: Number(combinedOdds.toFixed(2)),
    combinedProb,
    combinedProbPct: Math.round(combinedProb * 100),
    independentProbPct: Math.round(independentProb * 100),
    evPct: Math.round(ev * 100),
    correlated: Math.abs(combinedProb - independentProb) >= 0.005,
  };
}

function computeRiskScore(combinedProb, legCount) {
  let score = 10 - combinedProb * 9;
  score += Math.max(0, legCount - 2) * 0.4;
  return Math.min(10, Math.max(1, Math.round(score)));
}

const METRIC_LABELS = {
  // AFL
  disposals: "disposals",
  goals: "goals",
  marks: "marks",
  tackles: "tackles",
  fantasy_points: "fantasy points",
  kicks: "kicks",
  handballs: "handballs",
  clearances: "clearances",
  // NBA
  points: "points",
  rebounds: "rebounds",
  assists: "assists",
  threes: "3-pointers",
  blocks: "blocks",
  steals: "steals",
};

function metricLabel(metric) {
  return METRIC_LABELS[metric] || metric;
}

function detectLegCountFromMessage(message) {
  const lower = String(message || "").toLowerCase();
  const numMatch = lower.match(/(\d+)\s*[- ]?\s*legs?\b/);
  if (numMatch) return numMatch[1];

  const words = { two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8" };
  for (const [word, num] of Object.entries(words)) {
    if (new RegExp(`\\b${word}[- ]?\\s*legs?\\b`).test(lower)) return num;
  }
  return null;
}

function detectTargetOddsFromMessage(message) {
  const match = String(message || "").match(/\$\s*(\d+(?:\.\d+)?)/);
  return match ? `$${match[1]}` : null;
}

function detectRiskFromMessage(message) {
  const lower = String(message || "").toLowerCase();
  // "Best Chance" is the renamed safe profile (was "Safer"). Every build message
  // restates the chosen profile ("...with a Best Chance risk profile"), so this
  // MUST be recognised here — otherwise a Best Chance build returns null and the
  // resolver silently falls back to the "Balanced" default, dropping the whole
  // cushion floor. Checked first so "best chance" never trips the "safe" branch.
  // All "safe"-ish synonyms map to Best Chance, the safe tier ("Safer" retired).
  if (
    lower.includes("best chance") || lower.includes("safest") ||
    lower.includes("safer") || lower.includes("safe multi") || lower.includes("low risk")
  ) return "Best Chance";
  if (lower.includes("aggressive") || lower.includes("high risk") || lower.includes("riskier")) return "Aggressive";
  if (lower.includes("balanced")) return "Balanced";
  return null;
}

// If the user asked to focus on one market (e.g. "disposals only"), return that metric
function detectMultiMetricFilter(message, context) {
  const text = `${message || ""} ${context?.request || ""}`.toLowerCase();
  if (text.includes("fantasy")) return "fantasy_points";
  if (text.includes("disposal")) return "disposals";
  if (text.includes("clearance")) return "clearances";
  if (text.includes("tackle")) return "tackles";
  if (text.includes("handball")) return "handballs";
  if (text.includes("kick")) return "kicks";
  if (text.includes("goal")) return "goals";
  if (/\bmarks?\b/.test(text)) return "marks";
  return null;
}

// Shared computation: enrich props, select legs, compute combined metrics + risk
function computeAFLMulti(props, aflStats, targetLegs, targetOdds, riskProfile, factors = null, calibrationCurve = null, gameEnv = null) {
  const enriched = enrichProps(props, aflStats, factors, calibrationCurve, gameEnv);
  const targetOddsValue = parseOddsValue(targetOdds);
  const selected = selectOptimalLegs(enriched, targetLegs, targetOddsValue, riskProfile);
  const srcLabel = aflStats?.source || "Stats";
  const dataSource = aflStats?.available
    ? `${srcLabel} — ${aflStats.gamesAnalysed} recent games analysed`
    : `${srcLabel} unavailable`;

  if (!selected.length) {
    return { selected: [], enriched, dataSource, metrics: null, risk: null };
  }

  const metrics = computeCombinedMetrics(selected);
  const risk = computeRiskScore(metrics.combinedProb, selected.length);
  return {
    selected,
    enriched,
    dataSource,
    metrics,
    risk,
    profileUsed: selected.profileUsed || riskProfile,
    profileRequested: selected.profileRequested || riskProfile,
  };
}

// Build one structured leg from an enriched prop (shared by fresh builds + edits)
function structureLegFromEnriched(p) {
  const empPct = Math.round((p.empirical ?? 0) * 100);
  const impPct = p.implied != null ? Math.round(p.implied * 100) : null;
  const edgePct = p.edge != null ? Math.round(p.edge * 100) : null;
  const l5 = p.hr5 ? `${p.hr5.hits}/${p.hr5.total}` : "N/A";
  const l10 = p.hr10 ? `${p.hr10.hits}/${p.hr10.total}` : "N/A";
  const matchupPct = p.matchupFactor && p.matchupFactor !== 1 ? Math.round((p.matchupFactor - 1) * 100) : 0;
  const cushion = cushionGrade(p.cushionZ);

  const details = [
    { label: "Market line", value: `${Math.ceil(Number(p.line))}+` },
    { label: "Best odds", value: p.bookmaker ? `$${Number(p.odds).toFixed(2)} (${p.bookmaker})` : `$${Number(p.odds).toFixed(2)}` },
    { label: "Recent average", value: `${p.recentAvg}` },
    { label: "Last 5 hit rate", value: l5 },
    { label: "Last 10 hit rate", value: l10 },
    { label: "Form edge", value: edgePct != null ? `${edgePct >= 0 ? "+" : ""}${edgePct}%` : "N/A" },
  ];
  if (matchupPct !== 0 && p.opponent) {
    details.push({
      label: "Matchup",
      value: `vs ${p.opponent}: concedes ${matchupPct >= 0 ? "+" : ""}${matchupPct}% ${metricLabel(p.metric)}`,
    });
  }
  if (p.gameEnvFactor && Math.abs(p.gameEnvFactor - 1) >= 0.02) {
    const gp = Math.round((p.gameEnvFactor - 1) * 100);
    details.push({
      label: "Game pace",
      value: `${gp >= 0 ? "+" : ""}${gp}%${p.gameTotal != null ? ` · total ${p.gameTotal}` : ""}`,
    });
  }

  return {
    name: `${p.playerName} ${Math.ceil(Number(p.line))}+ ${metricLabel(p.metric)}`,
    player: p.playerName,
    metric: p.metric,
    team: p.team || null,
    position: p.position || null,
    opponent: p.opponent || null,
    matchupFactor: p.matchupFactor || 1,
    formAsOf: p.formAsOf || null,
    game: p.gameLabel,
    odds: p.odds,
    bookmaker: p.bookmaker || null,
    confidence: `${empPct}%`,
    edgePct, // form hit-rate minus odds-implied probability (the value signal)
    cushionZ: p.cushionZ != null ? Number(p.cushionZ.toFixed(2)) : null, // recency-weighted clearance z
    cushionGrade: cushion, // "Comfortable" | "Solid" | "Slim" | "On the line" | null
    reason: `Cleared this line in ${l10} recent games, averaging ${p.recentAvg}.`,
    details,
    last5Values: p.last5Values || [], // most-recent-first; UI highlights the latest game
    // Per-game values across the last 10 fixtures, most-recent-first. The
    // frontend reverses this for the per-game dot row so the rightmost dot
    // is the most recent game (a miss 4 games ago shows at position 4-from-
    // right, not bunched at the start).
    last10Values: p.last10Values || [],
    line: p.line,
    trend: `Last 5 results: ${(p.last5Values || []).join(", ")}.`,
    extraReason: `Recent-form chance ${empPct}%${impPct != null ? ` vs odds-implied ${impPct}%` : ""}${matchupPct !== 0 && p.opponent ? `, matchup-adjusted for ${p.opponent} (${matchupPct >= 0 ? "+" : ""}${matchupPct}% ${metricLabel(p.metric)})` : ""}. Based on ${p.sampleSize} recent games.`,
  };
}

// Same-game multi detection + conservative value. Bookmakers price same-game legs
// as a Same-Game Multi with a correlation discount, so multiplying single-leg prices
// overstates BOTH the odds and the value. We flag it, and haircut the odds (~8% per
// extra same-game leg) when computing EV so the displayed value isn't overstated.
//
// Factor was 0.85 (15% per leg) — way more aggressive than typical AFL/NBA SGM
// pricing in practice. For a 4-same-game-leg multi, 0.85^3 = 0.61 wiped out per-leg
// edge entirely, showing negative EV even when every leg had +7-15% individual edge.
// 0.92^3 = 0.78 matches what PointsBet/SportsBet actually post for AFL all-mid SGMs,
// so the displayed EV now tracks real bookmaker repricing instead of worst-case.
function sameGameAdjust(legs, combinedOdds, combinedProb) {
  const counts = {};
  let maxGroup = 1;
  for (const l of legs) {
    const g = l.game;
    if (!g) continue;
    counts[g] = (counts[g] || 0) + 1;
    if (counts[g] > maxGroup) maxGroup = counts[g];
  }
  const sameGameCount = maxGroup >= 2 ? maxGroup : 0;
  const sgmFactor = Math.pow(0.92, Math.max(0, maxGroup - 1));
  const effectiveOdds = combinedOdds * sgmFactor;
  const evPct = Math.round((combinedProb * effectiveOdds - 1) * 100);
  const sameGameNote = sameGameCount
    ? `${sameGameCount} legs are from the same game. Bookmakers price same-game legs as a Same-Game Multi with a correlation discount, so your real price (and value) will be lower than the $${combinedOdds.toFixed(2)} shown — that figure just multiplies the single-leg prices.`
    : null;
  return { evPct, sameGameCount, sameGameNote };
}

// Structured multi for the output panel (separate from the GPT narration)
function buildStructuredMulti(computed, sport, targetOdds) {
  if (!computed.selected.length) return null;
  const { selected, metrics, risk, profileUsed, profileRequested } = computed;

  const legs = selected.map(structureLegFromEnriched);

  const targetVal = parseOddsValue(targetOdds);
  let oddsNote = null;
  if (selected.chanceFloorCapped) {
    // Low capped short of the target to stay above its 60% combined-chance floor.
    oddsNote = `Capped at $${metrics.combinedOdds.toFixed(2)} — the longest Low-risk build that stays above a 60% chance. To reach ${targetOdds}, switch to Balanced, or add more games so Low has more safe legs to stack.`;
  } else if (targetVal && metrics.combinedOdds > targetVal + 0.30) {
    oddsNote = `${selected.length} legs naturally pays more than your ${targetOdds} target — for odds nearer ${targetOdds}, try fewer legs.`;
  } else if (targetVal && metrics.combinedOdds < targetVal - 0.30) {
    // Eligible pool exhausted under the current floor — there are no more legs that
    // pass the filters. More GAMES is the real lever (more safe legs to stack);
    // a single book's lines are already all considered, so don't over-promise it.
    oddsNote = `Only ${selected.length} eligible legs here combine to $${metrics.combinedOdds.toFixed(2)}. To reach ${targetOdds}, add more games (more safe legs to stack), or drop to Balanced/Aggressive.`;
  }

  // Profile-relaxation note: surfaced when the requested risk floor was too
  // tight to hit the target and we dropped a tier to find a buildable combo.
  // Honest with the user about what actually shipped — they picked Safer for
  // a reason, so don't silently downgrade without telling them.
  const profileNote =
    profileUsed && profileRequested && profileUsed !== profileRequested
      ? `Couldn't build a **${profileRequested}** multi at ${targetOdds || "the target"} — the pool was too thin to clear ${profileRequested}'s hit-rate floor AND combined-confidence floor at this target. Relaxed to **${profileUsed}**, which uses a wider pool and lower per-leg requirement.`
      : null;

  const sg = sameGameAdjust(legs, metrics.combinedOdds, metrics.combinedProb);

  return {
    sport,
    legCount: selected.length,
    legs,
    combinedOdds: metrics.combinedOdds,
    combinedProbPct: metrics.combinedProbPct,
    independentProbPct: metrics.independentProbPct,
    correlated: metrics.correlated,
    evPct: sg.evPct, // value vs market — conservative for same-game legs (SGM repricing)
    sameGameCount: sg.sameGameCount,
    sameGameNote: sg.sameGameNote,
    valueLegs: legs.filter((l) => typeof l.edgePct === "number" && l.edgePct > 0).length,
    targetOdds,
    oddsNote,
    profileNote,
    profileUsed,
    profileRequested,
    risk,
    riskExplanation: `A ${risk}/10 score reflects ${selected.length} legs with a combined recent-form chance of about ${metrics.combinedProbPct}%. More legs and lower individual hit rates raise the risk. This is based on historical stats only and does not guarantee the outcome.`,
  };
}

// ── Conversational multi editing ────────────────────────────────────────
// Turn the chat into an analyst that edits the current build in place
// (swap / remove / add a leg, retarget odds or leg count, make it safer/riskier)
// instead of regenerating from scratch every time.

function legEmpirical(leg) {
  const n = parseFloat(String(leg?.confidence || "").replace("%", ""));
  return Number.isFinite(n) ? n / 100 : 0;
}

function legEmpiricalPct(leg) {
  return Math.round(legEmpirical(leg) * 100);
}

function legMetricOf(leg) {
  if (leg && leg.metric) return leg.metric;
  const name = String(leg?.name || "").toLowerCase();
  for (const [key, label] of Object.entries(METRIC_LABELS)) {
    if (name.includes(label)) return key;
  }
  return null;
}

function weakestLegIndex(legs) {
  return legs
    .map((l, i) => [i, legEmpirical(l)])
    .sort((a, b) => a[1] - b[1])[0][0];
}

// Best-scoring enriched candidates not already in the build, optionally one metric
function eligibleCandidates(enriched, usedPlayers, metric) {
  const list = (enriched || [])
    .filter(
      (p) =>
        p.statsAvailable &&
        p.empirical != null &&
        Number(p.odds) > 1 &&
        p.sampleSize >= 3 &&
        !usedPlayers.has((p.playerName || "").toLowerCase()) &&
        (!metric || p.metric === metric)
    )
    .map((p) => ({ ...p, score: (p.empirical ?? 0) + Math.max(0, p.edge ?? 0) * 1.5 }));

  // One entry per player (keep best score)
  const byPlayer = new Map();
  for (const c of list) {
    const key = (c.playerName || "").toLowerCase();
    const cur = byPlayer.get(key);
    if (!cur || c.score > cur.score) byPlayer.set(key, c);
  }
  return [...byPlayer.values()].sort((a, b) => b.score - a.score);
}

// Pick a replacement: prefer same metric; among the strongest, prefer odds closest
// to the leg being replaced so the combined price stays near where it was.
function pickReplacement(enriched, usedPlayers, metric, targetLegOdds) {
  let cands = eligibleCandidates(enriched, usedPlayers, metric);
  if (!cands.length && metric) cands = eligibleCandidates(enriched, usedPlayers, null);
  if (!cands.length) return null;
  if (targetLegOdds) {
    const top = cands.slice(0, 8);
    top.sort(
      (a, b) =>
        Math.abs(Number(a.odds) - targetLegOdds) - Math.abs(Number(b.odds) - targetLegOdds)
    );
    return top[0];
  }
  return cands[0];
}

// Recompute combined odds/prob/risk from a final set of structured legs
function recomputeMultiFromLegs(base, legs, sport) {
  const combinedOdds = Number(legs.reduce((a, l) => a * Number(l.odds || 1), 1).toFixed(2));
  const independentProb = legs.reduce((a, l) => a * legEmpirical(l), 1);
  const combinedProb = correlationAdjustedProb(
    legs.map((l) => ({ prob: legEmpirical(l), game: l.game, metric: legMetricOf(l), team: l.team }))
  );
  const combinedProbPct = Math.round(combinedProb * 100);
  const independentProbPct = Math.round(independentProb * 100);
  const sg = sameGameAdjust(legs, combinedOdds, combinedProb);
  const evPct = sg.evPct;
  const valueLegs = legs.filter((l) => typeof l.edgePct === "number" && l.edgePct > 0).length;
  const correlated = Math.abs(combinedProb - independentProb) >= 0.005;
  const risk = computeRiskScore(combinedProb, legs.length);
  const targetOdds = base.targetOdds;
  const targetVal = parseOddsValue(targetOdds);
  let oddsNote = null;
  if (targetVal && combinedOdds > targetVal * 1.25) {
    oddsNote = `${legs.length} legs naturally pays more than your ${targetOdds} target — for odds nearer ${targetOdds}, try fewer legs.`;
  } else if (targetVal && combinedOdds < targetVal * 0.8) {
    oddsNote = `These legs combine below your ${targetOdds} target — for higher odds, add more legs.`;
  }
  return {
    ...base,
    sport: sport || base.sport,
    legCount: legs.length,
    legs,
    combinedOdds,
    combinedProbPct,
    independentProbPct,
    correlated,
    evPct,
    sameGameCount: sg.sameGameCount,
    sameGameNote: sg.sameGameNote,
    valueLegs,
    oddsNote,
    risk,
    riskExplanation: `A ${risk}/10 score reflects ${legs.length} legs with a combined recent-form chance of about ${combinedProbPct}%. More legs and lower individual hit rates raise the risk. This is based on historical stats only and does not guarantee the outcome.`,
  };
}

// Parse an edit instruction against the current build. Returns null for anything
// that isn't a recognisable edit (so it falls through to a fresh build / other intents).
function detectEditIntent(message, currentMulti) {
  if (!currentMulti || !Array.isArray(currentMulti.legs) || !currentMulti.legs.length) return null;
  const lower = String(message || "").toLowerCase();
  const legs = currentMulti.legs;

  const resolveLegIndex = () => {
    const m = lower.match(/leg\s*(\d+)/);
    if (m) {
      const i = parseInt(m[1], 10) - 1;
      if (i >= 0 && i < legs.length) return i;
    }
    const ordinals = [["first", 0], ["1st", 0], ["second", 1], ["2nd", 1], ["third", 2], ["3rd", 2], ["fourth", 3], ["4th", 3], ["fifth", 4], ["5th", 4]];
    for (const [w, i] of ordinals) if (lower.includes(`${w} leg`) && i < legs.length) return i;
    if (lower.includes("last leg") || lower.includes("final leg")) return legs.length - 1;
    for (let i = 0; i < legs.length; i++) {
      const player = (legs[i].player || "").toLowerCase();
      const surname = player.split(/\s+/).slice(-1)[0];
      if (player && (lower.includes(player) || (surname && surname.length >= 4 && lower.includes(surname)))) return i;
    }
    const teams = detectAllTeamAliases(message);
    if (teams.length) {
      for (let i = 0; i < legs.length; i++) {
        const g = (legs[i].game || "").toLowerCase();
        if (teams.some((t) => g.includes((t.team || "").toLowerCase()))) return i;
      }
    }
    return null;
  };

  const wantsRemove = /\b(remove|drop|delete|take out|get rid of|cut|ditch)\b/.test(lower);
  const wantsSwap = /\b(swap|replace|change|switch|sub|substitute)\b/.test(lower) || /\bdifferent\b/.test(lower);
  const wantsAdd = /\b(add|another|one more|extra|include)\b/.test(lower);
  const wantsSafer = /\b(safer|less risky|lower risk|reduce risk)\b/.test(lower);
  const wantsRiskier = /\b(riskier|more aggressive|more risk|longshot|long shot)\b/.test(lower);
  const explicitTarget = detectTargetOddsFromMessage(message);
  const wantsLonger = /(longer|bigger|higher|more)\s+(odds|payout)|lengthen|push (it )?(up|out)/.test(lower);
  const wantsShorter = /(shorter|smaller|lower|less)\s+(odds|payout)|tighten/.test(lower);
  const modifyPhrase = /\b(make it|change to|turn it into|rebuild)\b/.test(lower);
  const targetCountStr = detectLegCountFromMessage(message);
  const targetCount = targetCountStr ? parseInt(targetCountStr, 10) : null;

  // A clear fresh-build request should start over, not edit — even if it names a
  // target price (e.g. "Build a 3-leg multi around $2.00", "give me a 3 leg multi").
  // Edits use verbs like swap/remove/add/safer/longer or "make it…".
  const hasEditVerb =
    wantsRemove || wantsSwap || wantsAdd || wantsSafer || wantsRiskier || wantsLonger || wantsShorter || modifyPhrase;
  const freshBuildRequest =
    /\bbuild\b/.test(lower) ||
    lower.includes("example multi") ||
    lower.includes("new multi") ||
    (/\bmulti\b/.test(lower) && !hasEditVerb);
  if (freshBuildRequest) return null;

  // Change leg count: "make it 4 legs" / "add another leg" with explicit count
  if (targetCount && targetCount >= 1 && targetCount <= 8 && targetCount !== legs.length && (modifyPhrase || wantsAdd || wantsRemove)) {
    return { action: "retarget_legs", targetCount };
  }
  // Retarget odds
  if (explicitTarget && !wantsRemove && !wantsSwap && !wantsAdd) {
    return { action: "retarget", newTargetOdds: explicitTarget };
  }
  if ((wantsLonger || wantsShorter) && !wantsSwap && !wantsRemove) {
    return { action: "retarget", direction: wantsLonger ? "longer" : "shorter" };
  }
  // Per-leg edits
  if (wantsRemove) return { action: "remove", legIndex: resolveLegIndex() ?? weakestLegIndex(legs) };
  if (wantsSwap) return { action: "swap", legIndex: resolveLegIndex() ?? weakestLegIndex(legs) };
  if (wantsAdd) return { action: "add" };
  if (wantsSafer) return { action: "safer" };
  if (wantsRiskier) return { action: "riskier" };
  return null;
}

// Apply an edit action to the current build using the fresh enriched pool.
// Returns { ok, multi, summary } or { ok:false, message }.
function editAFLMulti(enriched, currentMulti, action, ctx = {}) {
  const sport = ctx.sport || currentMulti.sport || "AFL";
  let legs = currentMulti.legs.map((l) => ({ ...l }));
  const usedPlayers = () => new Set(legs.map((l) => (l.player || "").toLowerCase()));
  const dominantMetric = () => {
    const counts = {};
    legs.forEach((l) => {
      const m = legMetricOf(l);
      if (m) counts[m] = (counts[m] || 0) + 1;
    });
    let best = null, bestCount = 0;
    for (const [m, c] of Object.entries(counts)) if (c > bestCount) { bestCount = c; best = m; }
    return best;
  };
  let summary = "";

  if (action.action === "remove") {
    const i = action.legIndex;
    if (i == null || i < 0 || i >= legs.length) return { ok: false, message: "I couldn't tell which leg to remove — try 'remove leg 2' or name the player." };
    if (legs.length <= 1) return { ok: false, message: "That build only has one leg, so I can't remove the last one. Try swapping it instead." };
    const removed = legs.splice(i, 1)[0];
    summary = `Removed **${removed.player}** (was leg ${i + 1}).`;
  } else if (action.action === "swap") {
    const i = action.legIndex;
    if (i == null || i < 0 || i >= legs.length) return { ok: false, message: "I couldn't tell which leg to swap — try 'swap leg 2' or name the player." };
    const old = legs[i];
    const metric = legMetricOf(old);
    // Exclude every current player INCLUDING the one being swapped out, so the
    // replacement is a genuinely different player — never swap a player for himself.
    const used = usedPlayers();
    const repl = pickReplacement(enriched, used, metric, Number(old.odds));
    if (!repl) return { ok: false, message: `I couldn't find a suitable replacement for **${old.player}** in the ${metric ? metricLabel(metric) + " " : ""}markets available right now.` };
    legs[i] = structureLegFromEnriched(repl);
    summary = `Swapped **${old.player}** → **${repl.playerName}** (${Math.round((repl.empirical ?? 0) * 100)}% recent hit rate vs ${legEmpiricalPct(old)}%, $${repl.odds} vs $${old.odds}).`;
  } else if (action.action === "add") {
    const repl = pickReplacement(enriched, usedPlayers(), dominantMetric(), null);
    if (!repl) return { ok: false, message: "I couldn't find another suitable leg to add from the markets available right now." };
    legs.push(structureLegFromEnriched(repl));
    summary = `Added **${repl.playerName}** (${Math.round((repl.empirical ?? 0) * 100)}% recent hit rate, $${repl.odds}).`;
  } else if (action.action === "safer") {
    const i = weakestLegIndex(legs);
    const old = legs[i];
    // Exclude the swapped-out player too, so "make it safer" brings in a new name.
    const used = usedPlayers();
    const cands = eligibleCandidates(enriched, used, legMetricOf(old));
    const safer =
      cands.filter((c) => Number(c.odds) <= Number(old.odds)).sort((a, b) => (b.empirical ?? 0) - (a.empirical ?? 0))[0] ||
      cands.sort((a, b) => (b.empirical ?? 0) - (a.empirical ?? 0))[0];
    if (!safer) return { ok: false, message: "I couldn't find a safer leg to swap in from the markets available right now." };
    legs[i] = structureLegFromEnriched(safer);
    summary = `Made it safer: swapped **${old.player}** for **${safer.playerName}** (${Math.round((safer.empirical ?? 0) * 100)}% recent hit rate).`;
  } else if (action.action === "riskier") {
    const repl = pickReplacement(enriched, usedPlayers(), null, null);
    if (!repl) return { ok: false, message: "I couldn't find another leg to add for a riskier build right now." };
    legs.push(structureLegFromEnriched(repl));
    summary = `Made it riskier: added **${repl.playerName}** for longer odds.`;
  } else if (action.action === "retarget" || action.action === "retarget_legs") {
    let guard = 0;
    if (action.targetCount) {
      while (legs.length < action.targetCount && guard++ < 8) {
        const repl = pickReplacement(enriched, usedPlayers(), dominantMetric(), null);
        if (!repl) break;
        legs.push(structureLegFromEnriched(repl));
      }
      while (legs.length > action.targetCount && legs.length > 1 && guard++ < 16) {
        legs.splice(weakestLegIndex(legs), 1);
      }
      summary = `Rebuilt to **${legs.length} legs**, keeping your strongest picks.`;
    } else {
      const curOdds = () => legs.reduce((a, l) => a * Number(l.odds || 1), 1);
      const targetVal = action.newTargetOdds
        ? parseOddsValue(action.newTargetOdds)
        : action.direction === "longer"
        ? curOdds() * 1.4
        : action.direction === "shorter"
        ? curOdds() * 0.7
        : null;
      if (!targetVal) return { ok: false, message: "I couldn't work out the new target — try 'make it around $3' or 'make it 4 legs'." };
      if (targetVal > curOdds()) {
        while (curOdds() < targetVal * 0.92 && legs.length < 8 && guard++ < 12) {
          const repl = pickReplacement(enriched, usedPlayers(), dominantMetric(), null);
          if (!repl) break;
          legs.push(structureLegFromEnriched(repl));
        }
      } else {
        while (curOdds() > targetVal * 1.08 && legs.length > 1 && guard++ < 12) {
          legs.splice(weakestLegIndex(legs), 1);
        }
      }
      summary = `Adjusted toward **$${targetVal.toFixed(2)}**.`;
    }
  } else {
    return { ok: false, message: "I couldn't work out what to change. Try 'swap leg 2', 'remove a leg', 'add a leg', 'make it safer' or 'make it around $3'." };
  }

  const base = { ...currentMulti };
  if (action.action === "retarget" && action.newTargetOdds) base.targetOdds = action.newTargetOdds;
  const multi = recomputeMultiFromLegs(base, legs, sport);
  return { ok: true, multi, summary };
}

function buildAFLMultiDataBlock(computed, targetLegs, targetOdds, riskProfile, sport = "AFL") {
  const { selected, enriched, dataSource, metrics, risk } = computed;

  if (!selected.length) {
    return `
PRE-COMPUTED ${sport} MULTI (no qualifying legs)
Stats source: ${dataSource}
No player props had enough recent stats to build a confident multi for these games yet.

INSTRUCTIONS FOR GRID BUILD:
- Explain that live player prop stats were not available for these games yet.
- Do not invent players or numbers.
- Keep it brief, informational only, not betting advice.
`.trim();
  }

  const fmtPct = (x) => (x == null ? "N/A" : Math.round(x * 100) + "%");
  const fmtEdge = (e) => (e == null ? "N/A" : (e >= 0 ? "+" : "") + Math.round(e * 100) + "%");

  const selectedLines = selected
    .map((p, i) => {
      const l5 = p.hr5 ? `${p.hr5.hits}/${p.hr5.total}` : "N/A";
      const l10 = p.hr10 ? `${p.hr10.hits}/${p.hr10.total}` : "N/A";
      const marginStr = p.margin != null ? `${p.margin >= 0 ? "+" : ""}${p.margin}` : "N/A";
      return `LEG ${i + 1}: ${p.playerName} — ${Math.ceil(Number(p.line))}+ ${p.metric} @ $${Number(p.odds).toFixed(2)}${p.bookmaker ? ` (best at ${p.bookmaker})` : ""} (${p.gameLabel})
   Recent average: ${p.recentAvg} (clears the line by ${marginStr})
   Hit rate L5: ${l5} | L10: ${l10} (from ${p.sampleSize} games)
   Recent-form chance: ${fmtPct(p.empirical)} | Odds imply: ${fmtPct(p.implied)} | Form edge: ${fmtEdge(p.edge)}
   Last 5 results: [${p.last5Values.join(", ")}]`;
    })
    .join("\n\n");

  const selectedKeys = new Set(selected.map(propKey));
  const alternatives = enriched
    .filter((p) => p.statsAvailable && p.empirical != null && !selectedKeys.has(propKey(p)))
    .sort((a, b) => (b.empirical ?? 0) - (a.empirical ?? 0))
    .slice(0, 5)
    .map(
      (p) =>
        `• ${p.playerName} — ${Math.ceil(Number(p.line))}+ ${p.metric} @ $${Number(p.odds).toFixed(2)} | form chance ${fmtPct(p.empirical)} | edge ${fmtEdge(p.edge)}`
    )
    .join("\n");

  const targetVal = parseOddsValue(targetOdds);
  let oddsGapNote = "";
  if (targetVal && metrics.combinedOdds > targetVal * 1.25) {
    oddsGapNote = `\nNOTE: ${selected.length} legs at realistic prices combine to $${metrics.combinedOdds}, which is above the $${targetVal.toFixed(2)} target. The target cannot be reached with this many legs; fewer legs would be needed for odds nearer the target.`;
  } else if (targetVal && metrics.combinedOdds < targetVal * 0.8) {
    oddsGapNote = `\nNOTE: ${selected.length} legs combine to $${metrics.combinedOdds}, below the $${targetVal.toFixed(2)} target. More legs would be needed for odds nearer the target.`;
  }

  return `
PRE-COMPUTED ${sport} MULTI (all numbers below are already calculated by the app's math engine — DO NOT recompute or change selections, just present and explain them)
Request: ${targetLegs} legs | Target odds: ${targetOdds} | Risk profile: ${riskProfile}
Stats source: ${dataSource}

SELECTED MULTI (${selected.length} legs):
${selectedLines}

COMBINED (already calculated):
- Combined odds: $${metrics.combinedOdds}
- Estimated combined chance from recent form: ${metrics.combinedProbPct}%
- Overall risk score: ${risk}/10
- Historical edge figure (context only, not a prediction): ${metrics.evPct >= 0 ? "+" : ""}${metrics.evPct}%${oddsGapNote}

OTHER QUALIFYING OPTIONS (mention only if useful):
${alternatives || "None."}

INSTRUCTIONS FOR GRID BUILD:
- The legs and every number above are already selected and calculated. Present them as-is. Do NOT recompute, re-pick, or alter any figure.
- Use these exact section labels: "Simple view:", "Example structure:", "What I would check:", "Risk level:", "Important:".
- Under "Example structure:" list each leg with player, market line, odds, recent average and hit rate (L5 and L10).
- Under "Risk level:" state the ${risk}/10 score and explain it plainly (more legs and lower hit rates raise risk).
- Under "What I would check:" remind the user to confirm team news, late outs and role changes, which historical stats cannot capture, and flag any leg built on a small sample.${oddsGapNote ? "\n- Mention the note above about the combined odds versus the target, plainly." : ""}
- Frame the recent-form chance and edge as historical only, never a guarantee.
- Under "Important:" state clearly this is informational only, not betting advice, and outcomes are uncertain.
- Keep it clear and under 320 words.
`.trim();
}

async function fetchPlayerStatsContext(req, sport, metric, players = []) {
  try {
    const baseUrl = buildBaseUrl(req);
    const url = new URL("/api/player-stats", baseUrl);

    url.searchParams.set("sport", sport || "AFL");
    url.searchParams.set("metric", metric || "fantasy_points");

    if (players.length) {
      url.searchParams.set("players", players.join(","));
    }

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
      return {
        available: false,
        metric,
        players: [],
        summary: `Player stats could not be loaded. Error: ${data?.error || "Unknown error"}`,
      };
    }

    return {
      available: Boolean(data.players?.length),
      metric: data.metric,
      requestedPlayers: data.requestedPlayers || [],
      players: data.players || [],
      source: data.source || "Player stats source",
    };
  } catch (error) {
    console.error("Edge player stats context error:", error);

    return {
      available: false,
      metric,
      players: [],
      summary: "Player stats could not be loaded right now.",
    };
  }
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "Not available";
  const number = Number(value);
  return Number.isNaN(number) ? String(value) : String(Number(number.toFixed(2)));
}

function formatLineComparisonFromValues(averageValue, lineValue) {
  const average = Number(averageValue);
  const line = Number(lineValue);

  if (Number.isNaN(average) || Number.isNaN(line)) {
    return "Line comparison: **Not available**";
  }

  const difference = Number((average - line).toFixed(2));

  if (difference > 0) {
    return `Line comparison: recent average is **${difference}** above the listed line`;
  }

  if (difference < 0) {
    return `Line comparison: recent average is **${Math.abs(difference)}** below the listed line`;
  }

  return "Line comparison: recent average is exactly equal to the listed line";
}

function normalisePlayerName(value) {
  return normaliseText(value);
}

function extractComparableMarketLines(event, requestedMarket) {
  const lines = [];
  const seen = new Set();

  for (const bookmaker of event?.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      if (!requestedMarket.markets.includes(market.key)) continue;

      for (const outcome of market.outcomes || []) {
        const player = outcome.description || outcome.name;
        const isOverMarket = market.key.includes("_over") || outcome.name === "Over";

        if (!player || !isOverMarket) continue;

        const key = `${player}-${outcome.point}-${market.key}`;

        if (seen.has(key)) continue;
        seen.add(key);

        lines.push({
          playerName: player,
          marketKey: market.key,
          marketLabel: requestedMarket.label,
          metric: requestedMarket.metric,
          line: outcome.point ?? null,
          price: outcome.price ?? null,
          bookmaker: bookmaker.title || "Bookmaker",
        });

        if (lines.length >= 12) return lines;
      }
    }
  }

  return lines;
}

function buildDirectPlayerStatsReply({ sport, metric, playerStatsContext }) {
  if (!playerStatsContext?.available || !playerStatsContext.players?.length) {
    return `Simple view:

I could not find any saved **${metric}** stats for **${sport}** yet.

What I would check:

Add player stats into the **player_stats** table first, including recent average, last 5 hit rate, last 10 hit rate, last 20 hit rate, source and data freshness.

Important:

I will not invent player averages or hit rates. This is informational only, not betting advice.`;
  }

  const lines = playerStatsContext.players
    .slice(0, 6)
    .map((stat) => {
      return `**${stat.player_name}**

Team: **${stat.team || "Not available"}**
Metric: **${stat.metric}**
Line: **${formatNumber(stat.line)}**
Recent average: **${formatNumber(stat.recent_average)}**
Last 5 hit rate: **${stat.last_5_hit_rate || "Not available"}**
Last 10 hit rate: **${stat.last_10_hit_rate || "Not available"}**
Last 20 hit rate: **${stat.last_20_hit_rate || "Not available"}**
${formatLineComparisonFromValues(stat.recent_average, stat.line)}
Source: **${stat.source || "Not available"}**
Freshness: **${stat.data_freshness || "Not available"}**`;
    })
    .join("\n\n");

  return `Simple view:

Here is the saved **${metric}** stat context I found for **${sport}**:

${lines}

Important:

This is historical stat context only. It does not guarantee what will happen next, and it is not betting advice. Injuries, team news and live form are still not connected.`;
}

function buildMarketStatsComparisonReply({
  sport,
  requestedMarket,
  matchedEvent,
  eventMarketContext,
  playerStatsContext,
  marketLines,
  availableEvents,
}) {
  if (!matchedEvent) {
    return `Available games:

I could not tell which **${sport}** match you meant. Please ask again with one of these games:

${listAvailableEventOptions(availableEvents)}

Important:

I need a specific game before I can compare **${requestedMarket.label}** market lines with saved stats.`;
  }

  if (!eventMarketContext?.available || !marketLines.length) {
    return `Simple view:

I could not find comparable **${requestedMarket.label}** over-market lines for **${matchedEvent.homeTeam} vs ${matchedEvent.awayTeam}** right now.

Important:

Some markets may not be available yet, or they may not include over/under player lines. This is informational only, not betting advice.`;
  }

  const statsByPlayer = new Map();

  for (const stat of playerStatsContext?.players || []) {
    statsByPlayer.set(normalisePlayerName(stat.player_name), stat);
  }

  const comparisonLines = marketLines.slice(0, 8).map((line) => {
    const stat = statsByPlayer.get(normalisePlayerName(line.playerName));

    if (!stat) {
      return `**${line.playerName}**

Market line: Over **${formatNumber(line.line)} ${requestedMarket.label}**
Odds: **$${line.price}** — ${line.bookmaker}
Saved stats: **Not available yet**`;
    }

    return `**${line.playerName}**

Market line: Over **${formatNumber(line.line)} ${requestedMarket.label}**
Odds: **$${line.price}** — ${line.bookmaker}
Recent average: **${formatNumber(stat.recent_average)}**
Last 5 hit rate: **${stat.last_5_hit_rate || "Not available"}**
Last 10 hit rate: **${stat.last_10_hit_rate || "Not available"}**
Last 20 hit rate: **${stat.last_20_hit_rate || "Not available"}**
${formatLineComparisonFromValues(stat.recent_average, line.line)}
Source: **${stat.source || "Not available"}**
Freshness: **${stat.data_freshness || "Not available"}**`;
  });

  return `Simple view:

**${requestedMarket.label}** comparison for **${matchedEvent.homeTeam} vs ${matchedEvent.awayTeam}**:

${comparisonLines.join("\n\n")}

Important:

This compares available market lines against saved historical stats only. It does not guarantee the outcome. Injuries, role changes, late team news and live form are still not connected. This is informational only, not betting advice.`;
}

function getMarketGroupLabel(marketKey, requestedMarketLabel) {
  const labels = {
    player_disposals_over: "Disposals over markets",
    player_disposals: "Most disposals markets",
    player_afl_fantasy_points_over: "Fantasy points over markets",
    player_afl_fantasy_points: "Fantasy points markets",
    player_afl_fantasy_points_most: "Most fantasy points markets",
    player_goals_scored_over: "Goals over markets",
    player_goal_scorer_anytime: "Anytime goalscorer markets",
    player_goal_scorer_first: "First goalscorer markets",
    player_goal_scorer_last: "Last goalscorer markets",
    player_marks_over: "Marks over markets",
    player_marks_most: "Most marks markets",
    player_tackles_over: "Tackles over markets",
    player_tackles_most: "Most tackles markets",
    player_clearances_over: "Clearances over markets",
    player_kicks_over: "Kicks over markets",
    player_handballs_over: "Handballs over markets",
    h2h: "Head-to-head markets",
    spreads: "Handicap / line markets",
    totals: "Total markets",
  };

  return labels[marketKey] || `${requestedMarketLabel} markets`;
}

function formatOutcomeLine(outcome, marketKey, bookmakerTitle) {
  const player = outcome.description || outcome.name || "Selection";
  const price = outcome.price ? `**$${outcome.price}**` : "Price unavailable";
  const point =
    outcome.point !== null && outcome.point !== undefined
      ? `**${outcome.point}**`
      : null;
  const book = bookmakerTitle || "Bookmaker";

  if (marketKey.includes("_most")) {
    return `- **${player}** — Most — ${price} — ${book}`;
  }

  if (marketKey.includes("_over") || outcome.name === "Over") {
    return `- **${player}** — Over ${point || "line unavailable"} — ${price} — ${book}`;
  }

  if (marketKey.includes("first")) {
    return `- **${player}** — First scorer — ${price} — ${book}`;
  }

  if (marketKey.includes("last")) {
    return `- **${player}** — Last scorer — ${price} — ${book}`;
  }

  if (marketKey.includes("anytime")) {
    return `- **${player}** — Anytime scorer — ${price} — ${book}`;
  }

  if (outcome.point !== null && outcome.point !== undefined) {
    return `- **${player}** — ${outcome.name || "Market"} ${point} — ${price} — ${book}`;
  }

  return `- **${player}**${outcome.name ? ` — ${outcome.name}` : ""} — ${price} — ${book}`;
}

function summariseEventMarkets(event, requestedMarket) {
  if (!event) {
    return "No event market data was returned.";
  }

  const groupedLines = {};
  const seen = new Set();

  for (const bookmaker of event.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      if (!requestedMarket.markets.includes(market.key)) continue;

      const groupLabel = getMarketGroupLabel(market.key, requestedMarket.label);

      if (!groupedLines[groupLabel]) {
        groupedLines[groupLabel] = [];
      }

      for (const outcome of market.outcomes || []) {
        const key = `${market.key}-${outcome.description || outcome.name}-${outcome.point}-${outcome.price}`;

        if (seen.has(key)) continue;
        seen.add(key);

        groupedLines[groupLabel].push(
          formatOutcomeLine(outcome, market.key, bookmaker.title)
        );

        if (groupedLines[groupLabel].length >= 6) break;
      }
    }
  }

  const groupEntries = Object.entries(groupedLines)
    .filter(([, lines]) => lines.length)
    .map(([label, lines]) => `**${label}:**\n\n${lines.slice(0, 6).join("\n")}`);

  if (!groupEntries.length) {
    return `No **${requestedMarket.label}** markets were returned for this event right now.`;
  }

  return `**${event.homeTeam} vs ${event.awayTeam}**

${groupEntries.join("\n\n")}`;
}

function buildDirectOddsReply({ sport, detectedTeam, dateWindow, oddsContext }) {
  const summary =
    oddsContext?.summary ||
    `No odds were returned for **${sport}** for **${dateWindow?.label || "upcoming games"}**.`;

  return `Available games:

${summary}

Important:

Odds can change leading up to the games. These are sample odds from available bookmaker data. This is informational only, not betting advice.`;
}

function buildDirectEventMarketReply({
  sport,
  requestedMarket,
  matchedEvent,
  eventMarketContext,
  availableEvents,
}) {
  if (!matchedEvent) {
    return `Available games:

I could not tell which **${sport}** match you meant. Please ask again with one of these games:

${listAvailableEventOptions(availableEvents)}

Important:

I need a specific game before I can show **${requestedMarket.label}** markets. Markets can change and this is informational only, not betting advice.`;
  }

  return `Available games:

Available **${requestedMarket.label}** markets for **${matchedEvent.homeTeam} vs ${matchedEvent.awayTeam}**:

${eventMarketContext?.summary || `No **${requestedMarket.label}** markets were returned for this game.`}

Important:

These are market lines only. Historical averages and hit rates are only shown when saved stats are available. This is informational only, not betting advice.`;
}

function buildUserPrompt({
  message,
  context,
  oddsContext,
  userIntent,
  sport,
  detectedTeam,
  dateWindow,
}) {
  return `
User request:
${message}

Detected user intent:
${userIntent}

Requested sport or league:
${sport}

Requested date window:
${dateWindow?.label || "upcoming games"}

Detected team:
${detectedTeam?.team || "None"}

Available odds context:
${oddsContext?.summary || "No odds context available."}

Respond as Grid Build.

Important:
- Keep the answer short, simple, and user-friendly.
- Use **bold** markers for important names, teams, markets, stats, odds, hit rates and risk scores.
- Do not invent player stats, injuries, lineups, odds, or player data.
- Make clear that this is informational analysis only, not betting advice.
`;
}

// ── Game analysis ────────────────────────────────────────────────────────
const ANALYSIS_METRICS = ["disposals", "goals", "marks", "tackles"];
const ANALYSIS_PLAYER_MARKETS = [
  "player_disposals_over",
  "player_goals_scored_over",
  "player_marks_over",
  "player_tackles_over",
  "player_afl_fantasy_points_over",
  "player_kicks_over",
  "player_handballs_over",
  "player_clearances_over",
];

// Best h2h price per team -> normalised implied win %, plus total + spread lines
function extractMarketRead(event) {
  if (!event) return null;
  const home = event.homeTeam;
  const away = event.awayTeam;
  let bestHome = null, bestAway = null, totalLine = null, spreadLine = null, spreadFav = null;
  for (const bk of event.bookmakers || []) {
    for (const m of bk.markets || []) {
      if (m.key === "h2h") {
        for (const o of m.outcomes || []) {
          if (o.name === home && (bestHome == null || o.price > bestHome)) bestHome = o.price;
          if (o.name === away && (bestAway == null || o.price > bestAway)) bestAway = o.price;
        }
      } else if (m.key === "totals" && totalLine == null) {
        const over = (m.outcomes || []).find((o) => /over/i.test(o.name));
        if (over?.point != null) totalLine = over.point;
      } else if (m.key === "spreads" && spreadLine == null) {
        const neg = (m.outcomes || []).find((o) => Number(o.point) < 0);
        if (neg) { spreadLine = Math.abs(Number(neg.point)); spreadFav = neg.name; }
      }
    }
  }
  const read = { home, away, totalLine, spreadLine, spreadFav, favourite: null, favPrice: null, favPct: null, underdog: null, dogPrice: null, dogPct: null };
  if (bestHome && bestAway) {
    const ih = 1 / bestHome, ia = 1 / bestAway, tot = ih + ia;
    const homePct = Math.round((ih / tot) * 100);
    const awayPct = Math.round((ia / tot) * 100);
    if (bestHome <= bestAway) {
      read.favourite = home; read.favPrice = bestHome; read.favPct = homePct;
      read.underdog = away; read.dogPrice = bestAway; read.dogPct = awayPct;
    } else {
      read.favourite = away; read.favPrice = bestAway; read.favPct = awayPct;
      read.underdog = home; read.dogPrice = bestHome; read.dogPct = homePct;
    }
  }
  return read;
}

// Compact analysis leg from an enriched prop (with form detail for depth)
function analysisLeg(p) {
  return {
    player: p.playerName,
    team: p.team || null,
    label: `${Math.ceil(Number(p.line))}+ ${metricLabel(p.metric)}`,
    metric: p.metric,
    confidence: Math.round((p.empirical ?? 0) * 100),
    edgePct: p.edge != null ? Math.round(p.edge * 100) : null,
    recentAvg: p.recentAvg ?? null,
    hr10: p.hr10 ? `${p.hr10.hits}/${p.hr10.total}` : null,
    matchupPct: p.matchupFactor && p.matchupFactor !== 1 ? Math.round((p.matchupFactor - 1) * 100) : 0,
    opponent: p.opponent || null,
    odds: p.odds,
    bookmaker: p.bookmaker || null,
  };
}

// Top in-form players per team (one best line per player)
function topKeyPlayersByTeam(enriched, home, away, perTeam = 4) {
  const eligible = enriched.filter((p) => p.statsAvailable && p.empirical != null && p.sampleSize >= 3 && Number(p.odds) > 1);
  const best = new Map();
  for (const p of eligible) {
    const score = (p.empirical ?? 0) + Math.max(0, p.edge ?? 0) * 1.5;
    const cur = best.get(p.playerName);
    if (!cur || score > cur.score) best.set(p.playerName, { ...p, score });
  }
  const byTeam = (team) =>
    [...best.values()]
      .filter((p) => (p.team || "").toLowerCase() === (team || "").toLowerCase())
      .sort((a, b) => b.score - a.score)
      .slice(0, perTeam)
      .map(analysisLeg);
  return { home: byTeam(home), away: byTeam(away) };
}

// Top value plays by edge (one best line per player, positive edge only)
function topValuePlays(enriched, n = 5) {
  const eligible = enriched.filter((p) => p.statsAvailable && p.edge != null && p.sampleSize >= 3 && Number(p.odds) > 1);
  const best = new Map();
  for (const p of eligible) {
    const cur = best.get(p.playerName);
    if (!cur || (p.edge ?? -1) > (cur.edge ?? -1)) best.set(p.playerName, p);
  }
  return [...best.values()]
    .filter((p) => (p.edge ?? 0) > 0)
    .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0))
    .slice(0, n)
    .map(analysisLeg);
}

// Matchup angles from defence factors: the stat each team concedes most AND the
// stat each team defends best, vs league average.
function buildMatchupAngles(factors, home, away) {
  if (!factors) return [];
  const angles = [];
  for (const team of [home, away]) {
    const f = factors[team];
    if (!f) continue;
    let topMetric = null, topVal = 1, lowMetric = null, lowVal = 1;
    for (const m of ANALYSIS_METRICS) {
      if (f[m] == null) continue;
      if (f[m] > topVal) { topVal = f[m]; topMetric = m; }
      if (f[m] < lowVal) { lowVal = f[m]; lowMetric = m; }
    }
    const opp = team === home ? away : home;
    if (topMetric) {
      angles.push(`${team} concedes +${Math.round((topVal - 1) * 100)}% ${metricLabel(topMetric)} vs league average — favours ${opp}'s ${metricLabel(topMetric)} scorers.`);
    }
    if (lowMetric && lowMetric !== topMetric) {
      angles.push(`${team} defends ${metricLabel(lowMetric)} well (${Math.round((lowVal - 1) * 100)}% vs average) — tougher for ${opp} there.`);
    }
  }
  return angles;
}

// Plain-text data block fed to the model for the narrated summary
function buildAnalysisDataBlock(analysis) {
  const out = [`GAME: ${analysis.game}`];
  const mr = analysis.marketRead;
  if (mr?.favourite) out.push(`MARKET: ${mr.favourite} favoured at $${mr.favPrice.toFixed(2)} (~${mr.favPct}% implied) over ${mr.underdog} $${mr.dogPrice.toFixed(2)} (~${mr.dogPct}%).${mr.totalLine != null ? ` Total points line ${mr.totalLine}.` : ""}${mr.spreadLine != null ? ` Line ${mr.spreadFav} -${mr.spreadLine}.` : ""}`);
  const fmt = (l) => `${l.player} (${l.team || "?"}) ${l.label} @ $${Number(l.odds).toFixed(2)} — form ${l.confidence}%${l.hr10 ? `, cleared ${l.hr10}` : ""}, recent avg ${l.recentAvg}${l.edgePct != null ? `, edge ${l.edgePct >= 0 ? "+" : ""}${l.edgePct}%` : ""}${l.matchupPct ? `, vs ${l.opponent} ${l.matchupPct >= 0 ? "+" : ""}${l.matchupPct}% on this stat` : ""}`;
  if (analysis.keyPlayers?.home?.length) out.push(`KEY ${analysis.homeTeam}:\n` + analysis.keyPlayers.home.map((l) => "• " + fmt(l)).join("\n"));
  if (analysis.keyPlayers?.away?.length) out.push(`KEY ${analysis.awayTeam}:\n` + analysis.keyPlayers.away.map((l) => "• " + fmt(l)).join("\n"));
  if (analysis.valuePlays?.length) out.push(`VALUE PLAYS (recent-form chance beats the odds-implied price):\n` + analysis.valuePlays.map((l) => "• " + fmt(l)).join("\n"));
  if (analysis.matchupAngles?.length) out.push(`MATCHUP:\n` + analysis.matchupAngles.map((a) => "• " + a).join("\n"));
  return out.join("\n\n");
}

// Parse a betslip screenshot via OpenAI vision. Routed through edge.js so we
// don't add a 13th serverless function (Vercel Hobby plan caps at 12). Returns
// structured JSON the frontend can use to pre-fill the Add Bet form.
async function parseBetslipImage(image) {
  // Accept either a bare base64 string or a data URL — normalise to data URL
  // for OpenAI's image_url input.
  const imageUrl = image.startsWith("data:") ? image : `data:image/png;base64,${image}`;

  const prompt = `You are a betting slip parser. Given a screenshot of a sports betting slip from any bookmaker
(Sportsbet, PointsBet, TAB, Ladbrokes, Neds, Unibet, Bet365, BetFair, etc.), extract the bet details.

Return ONLY a JSON object with EXACTLY this shape (no markdown, no commentary):
{
  "valid": true,
  "sport": "AFL"|"NBA"|"NRL"|"Soccer"|"Basketball"|"Cricket"|"Other",
  "betType": "Single"|"Multi"|"Player prop"|"Head-to-head"|"Line"|"Total"|"Other",
  "bookmaker": "<bookmaker name as shown, e.g. PointsBet>",
  "stake": <number>,
  "odds": <number>,
  "returnAmount": <number>,
  "status": "pending"|"settled",
  "result": "win"|"loss"|null,
  "legs": [
    { "player": "<player or selection name>", "line": "<line description e.g. 12+ disposals>", "odds": <number>, "game": "<home vs away if visible>" }
  ],
  "notes": "<one short line of context if useful, else null>"
}

Rules:
- stake / odds / returnAmount must be numbers (not strings). Strip $ and currency.
- For multis: include every leg. For singles: legs can be empty or a single entry.
- Use null for any field you genuinely can't determine. Don't guess.
- For status/result, look for VISUAL cues: green tick / "WON" / "CASHED" / payout > 0 = settled win.
  Red cross / "LOST" / strikethrough legs / "$0.00" return on a settled slip = settled loss.
  "OPEN" / "PENDING" / "IN PROGRESS" / no settlement marker = pending. If unsure, return
  status:"pending" and result:null — better to leave it pending than guess a win/loss wrong.
- If status="pending", result MUST be null. If status="settled", result must be "win" or "loss".
- If the image isn't a betslip, return: {"valid": false, "error": "Not a betslip"}.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI vision call failed: ${response.status} — ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Vision response was not valid JSON: " + raw.slice(0, 200));
  }
  return parsed;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "Missing OPENAI_API_KEY",
    });
  }

  try {
    const body = req.body || {};

    // Branch: betslip screenshot parsing. Handled here so we don't burn a
    // serverless-function slot on a small dedicated endpoint.
    if (body.intent === "parse_betslip" && body.image) {
      try {
        const result = await parseBetslipImage(body.image);
        return res.status(200).json(result);
      } catch (err) {
        return res.status(500).json({ valid: false, error: err.message || "Parse failed" });
      }
    }

    const { message, context } = body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Message is required",
      });
    }

    const previousEdgeContext = context?.previousEdgeContext || null;
    const explicitSport = detectExplicitSportFromMessage(message);
    const detectedTeamsFromMessage = detectAllTeamAliases(message);

    const detectedTeam =
      detectedTeamsFromMessage[0] ||
      previousEdgeContext?.detectedTeam ||
      null;

    const sport =
      explicitSport ||
      previousEdgeContext?.sport ||
      getSafeString(context?.sport, "AFL");

    const dateWindow = getDateWindowFromMessage(message);
    const requestedMarket = detectRequestedMarket(message, sport);
    const userIntent = getUserIntent(message, requestedMarket);
    const statsMetric = detectStatsMetric(message, requestedMarket);
    const requestedPlayers = extractRequestedPlayers(message);

    // Conversational editing: if the user has a build on screen and the message is
    // an edit instruction ("swap leg 2", "make it safer", "around $3"), route into
    // the multi branch and edit in place rather than starting a fresh build.
    const currentMulti =
      context?.currentMulti && Array.isArray(context.currentMulti.legs) && context.currentMulti.legs.length
        ? context.currentMulti
        : null;
    const editAction = currentMulti ? detectEditIntent(message, currentMulti) : null;

    const oddsContext = await fetchOddsContext(
      req,
      sport,
      detectedTeam,
      dateWindow
    );

    const edgeContext = {
      sport,
      detectedTeam,
      dateWindow,
    };

    // ── Game analysis: full data-backed read of one match ──────────────────
    if (context?.analysisRequest) {
      if (sport !== "AFL") {
        return res.status(200).json({
          reply: "Simple view:\n\nGame analysis currently supports AFL only.\n\nImportant:\n\nInformational only, not betting advice.",
          analysis: null, intent: "game_analysis", sport, edgeContext,
        });
      }
      if (!oddsContext.events.length) {
        return res.status(200).json({
          reply: "Simple view:\n\nI couldn't load live AFL games right now, so I can't analyse a match.\n\nWhat I would check:\n\nThe odds feed may be between updates — try again shortly.\n\nImportant:\n\nInformational only, not betting advice.",
          analysis: null, intent: "game_analysis", sport, edgeContext,
        });
      }

      const requestedGameId = getSafeString(context?.gameId, "");
      const teamsInMessage = detectAllTeamAliases(message);
      const game =
        (requestedGameId ? oddsContext.events.find((e) => e.id === requestedGameId) : null) ||
        (teamsInMessage.length ? findMatchingEvent(oddsContext.events, message, teamsInMessage) : null) ||
        oddsContext.events[0];

      if (!game) {
        return res.status(200).json({
          reply: "Simple view:\n\nI couldn't match that game. Pick one from the Game dropdown and try again.\n\nImportant:\n\nInformational only, not betting advice.",
          analysis: null, intent: "game_analysis", sport, edgeContext,
        });
      }

      const analysisMarkets = { label: "AFL analysis", markets: ["h2h", "totals", "spreads", ...ANALYSIS_PLAYER_MARKETS] };
      const eventCtx = await fetchEventOddsContext(req, sport, game.id, analysisMarkets);
      const event = eventCtx.event || { homeTeam: game.homeTeam, awayTeam: game.awayTeam, bookmakers: [] };
      const marketRead = extractMarketRead(event);

      const allProps = extractPlayerPropsFromEvent(event);
      let enriched = [];
      let statsAvailable = false;
      let defenseFactors = null;
      if (allProps.length) {
        const players = [...new Set(allProps.map((p) => p.playerName))].slice(0, 40);
        const metrics = [...new Set(allProps.map((p) => p.metric))];
        const aflStatsContext = await fetchStatsContext(req, "AFL", players, metrics);
        statsAvailable = aflStatsContext.available;
        const defenseContext = await fetchDefenseContext(req);
        defenseFactors = defenseContext.factors;
        // Apply the latest fitted recalibration curve when enriching for the
        // game-analysis flow too — keeps confidence numbers calibrated everywhere.
        const aflCurve = await loadCalibrationCurve("AFL");
        enriched = enrichProps(allProps, aflStatsContext, defenseFactors, aflCurve);
      }

      const analysis = {
        game: `${game.homeTeam} vs ${game.awayTeam}`,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        marketRead,
        keyPlayers: topKeyPlayersByTeam(enriched, game.homeTeam, game.awayTeam),
        valuePlays: topValuePlays(enriched, 5),
        matchupAngles: buildMatchupAngles(defenseFactors, game.homeTeam, game.awayTeam),
        propsFound: allProps.length,
      };

      let reply;
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: EDGE_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Task: write a detailed, realistic AFL match analysis (NOT a multi) using ONLY the data below.
Rules:
- Ground EVERY claim in the numbers provided — name specific players and cite their hit rate (e.g. cleared 9/10), recent average, the market price, edge and the matchup factors.
- Do NOT invent injuries, team news, scores, head-to-head history, weather, venue, ladder position or anything not in the data.
- Be measured and realistic: recent form is not a guarantee, samples are small, and bookmaker prices already reflect a lot — note the uncertainty and variance rather than hyping it.
- Write 3 to 5 short paragraphs of genuine analysis, not filler.
Use ONLY these section labels exactly:
Simple view:
What I would check:
Important:

In "Simple view", weave together: the market read (favourite, implied %, total/line), each team's standout players with their specific form numbers, where the genuine value is (form chance vs the price), and the key matchup angles. In "What I would check", list the concrete things a person should confirm before relying on this (team news, late mail, line moves, role/positional changes).

${buildAnalysisDataBlock(analysis)}`,
            },
          ],
          temperature: 0.3,
          max_tokens: 1100,
        });
        reply = completion.choices?.[0]?.message?.content || "";
      } catch (error) {
        console.error("Game analysis narration error:", error);
        reply = "Simple view:\n\nHere's the data-backed read for this match.\n\nImportant:\n\nInformational only, not betting advice.";
      }

      return res.status(200).json({
        reply,
        analysis,
        intent: "game_analysis",
        sport,
        oddsConnected: oddsContext.available,
        aflStatsConnected: statsAvailable,
        edgeContext,
      });
    }

    if (!editAction && userIntent === "market_stats_comparison" && requestedMarket?.metric) {
      const matchedEvent = findMatchingEvent(
        oddsContext.events,
        message,
        detectedTeamsFromMessage.length
          ? detectedTeamsFromMessage
          : detectedTeam
          ? [detectedTeam]
          : []
      );

      const eventMarketContext = matchedEvent
        ? await fetchEventOddsContext(req, sport, matchedEvent.id, requestedMarket)
        : null;

      const marketLines = extractComparableMarketLines(
        eventMarketContext?.event,
        requestedMarket
      );

      const playerNames = marketLines.map((line) => line.playerName);

      const playerStatsContext = await fetchPlayerStatsContext(
        req,
        sport,
        requestedMarket.metric,
        playerNames
      );

      const reply = buildMarketStatsComparisonReply({
        sport,
        requestedMarket,
        matchedEvent,
        eventMarketContext,
        playerStatsContext,
        marketLines,
        availableEvents: oddsContext.events,
      });

      return res.status(200).json({
        reply,
        oddsConnected: oddsContext.available,
        eventMarketsConnected: Boolean(eventMarketContext?.available),
        playerStatsConnected: Boolean(playerStatsContext?.available),
        intent: userIntent,
        sport,
        detectedTeam: detectedTeam?.team || null,
        dateWindow: dateWindow?.label || "upcoming games",
        requestedMarket: requestedMarket.label,
        statsMetric: requestedMarket.metric,
        matchedEventId: matchedEvent?.id || null,
        edgeContext: {
          ...edgeContext,
          statsMetric: requestedMarket.metric,
        },
      });
    }

    if (!editAction && userIntent === "player_stats") {
      const playerStatsContext = await fetchPlayerStatsContext(
        req,
        sport,
        statsMetric,
        requestedPlayers
      );

      return res.status(200).json({
        reply: buildDirectPlayerStatsReply({
          sport,
          metric: statsMetric,
          playerStatsContext,
        }),
        playerStatsConnected: Boolean(playerStatsContext?.available),
        intent: "player_stats",
        sport,
        detectedTeam: detectedTeam?.team || null,
        dateWindow: dateWindow?.label || "upcoming games",
        statsMetric,
        edgeContext: {
          ...edgeContext,
          statsMetric,
        },
      });
    }

    if (!editAction && userIntent === "event_markets" && requestedMarket) {
      const matchedEvent = findMatchingEvent(
        oddsContext.events,
        message,
        detectedTeamsFromMessage.length
          ? detectedTeamsFromMessage
          : detectedTeam
          ? [detectedTeam]
          : []
      );

      const eventMarketContext = matchedEvent
        ? await fetchEventOddsContext(req, sport, matchedEvent.id, requestedMarket)
        : null;

      const reply = buildDirectEventMarketReply({
        sport,
        requestedMarket,
        matchedEvent,
        eventMarketContext,
        availableEvents: oddsContext.events,
      });

      return res.status(200).json({
        reply,
        oddsConnected: oddsContext.available,
        eventMarketsConnected: Boolean(eventMarketContext?.available),
        intent: userIntent,
        sport,
        detectedTeam: detectedTeam?.team || null,
        dateWindow: dateWindow?.label || "upcoming games",
        requestedMarket: requestedMarket.label,
        matchedEventId: matchedEvent?.id || null,
        edgeContext,
      });
    }

    if (!editAction && userIntent === "available_games") {
      const reply = buildDirectOddsReply({
        sport,
        detectedTeam,
        dateWindow,
        oddsContext,
      });

      return res.status(200).json({
        reply,
        oddsConnected: oddsContext.available,
        intent: userIntent,
        sport,
        detectedTeam: detectedTeam?.team || null,
        dateWindow: dateWindow?.label || "upcoming games",
        edgeContext,
      });
    }

    // Multi builder: fetch real player props + stats before sending to GPT (AFL + NBA)
    if ((editAction || userIntent === "multi") && (sport === "AFL" || sport === "NBA")) {
      // Free tier: 3 builds/week. Subscribers are unlimited. Checked before the
      // expensive odds/stat work so a gated request costs nothing. Edits to an
      // existing build are refinements — they don't consume a build credit, so a
      // gated user can still tweak the build they already have.
      const access = await checkGridBuildAccess(req);
      if (access.gated && !editAction) {
        return res.status(200).json({
          reply: `Simple view:\n\nYou've used all ${access.limit} of your free Grid Build builds for this week.\n\nWhat I would check:\n\nUpgrade to keep building unlimited multis with live AFL stats and odds — your free builds reset on Monday.\n\nImportant:\n\nThis is informational only, not betting advice.`,
          gated: true,
          usage: access.usage,
          limit: access.limit,
          subscribed: false,
          multi: null,
          intent: "multi",
          sport,
          edgeContext,
        });
      }

      // No live odds (limit reached, or no games scheduled) — say so plainly. Never
      // fall through to a generic reply that invents placeholder players and stats.
      if (oddsContext.events.length === 0) {
        return res.status(200).json({
          reply: `Simple view:\n\nI couldn't load live ${sport} odds right now, so I can't build a real multi this time.\n\nWhat I would check:\n\nThis usually means the live odds data limit has been reached for the moment, or there are no upcoming ${sport} games posted yet. It refreshes over time.\n\nImportant:\n\nI won't invent players, odds or stats. This is informational only, not betting advice.`,
          multi: null,
          oddsConnected: oddsContext.available,
          statsConnected: false,
          intent: "multi",
          sport,
          detectedTeam: detectedTeam?.team || null,
          dateWindow: dateWindow?.label || "upcoming games",
          edgeContext,
        });
      }

      const playerMarkets = PLAYER_MARKETS_BY_SPORT[sport];
      if (!playerMarkets) {
        return res.status(200).json({
          reply: `Simple view:\n\nGrid Build doesn't support ${sport} player props yet.\n\nImportant:\n\nThis is informational only, not betting advice.`,
          multi: null,
          intent: "multi",
          sport,
          edgeContext,
        });
      }

      // Prefer values stated in the message (e.g. "give me a 3 leg multi"), fall back to the form
      const targetLegs =
        detectLegCountFromMessage(message) || getSafeString(context?.legs, "3");
      // Fall back to $2.00 when the target is missing/unparseable (e.g. "Custom"
      // selected with an empty field) so the balanced combo search runs instead of
      // the plain top-by-score path, which can produce lopsided builds.
      let targetOdds =
        detectTargetOddsFromMessage(message) || getSafeString(context?.targetOdds, "$2.00");
      if (!parseOddsValue(targetOdds)) targetOdds = "$2.00";
      const riskProfile =
        detectRiskFromMessage(message) || getSafeString(context?.riskProfile, "Balanced");
      // Optional: pin all legs to one bookmaker so the multi is placeable there.
      // Empty/"best" keeps the default best-price-across-books behaviour.
      const preferredBook = getSafeString(context?.bookmaker, "");

      // Choose which game(s) to build from: a specific game (selected in the form, or
      // named in the chat) if given; otherwise probe the first few upcoming games.
      const requestedGameId = getSafeString(context?.gameId, "");
      // Multi-select: the dashboard mini-builder can hand off several game ids to
      // spread one multi across. Falls back to the single id, then a chat-named game.
      const requestedGameIds = Array.isArray(context?.gameIds)
        ? context.gameIds.map((id) => getSafeString(id, "")).filter(Boolean)
        : [];
      const teamsInMessage = detectAllTeamAliases(message);
      const namedGame =
        !requestedGameId && !requestedGameIds.length && teamsInMessage.length
          ? findMatchingEvent(oddsContext.events, message, teamsInMessage)
          : null;
      const idsToResolve = requestedGameIds.length ? requestedGameIds : (requestedGameId ? [requestedGameId] : []);
      const specificGames = idsToResolve
        .map((id) => oddsContext.events.find((e) => e.id === id))
        .filter(Boolean);
      const specificGame = specificGames[0] || namedGame || null;
      // Keep props from the first games that actually return them (cap at 2 games when
      // probing). Limited to 3 to keep Odds API credit use down (charged per market).
      // For an edit, draw replacements from the same games as the current build so a
      // swapped/added leg comes from a match the user is already targeting.
      let candidateGames;
      if (editAction) {
        const matched = [];
        for (const label of [...new Set(currentMulti.legs.map((l) => l.game).filter(Boolean))]) {
          const ev = findMatchingEvent(oddsContext.events, label, detectAllTeamAliases(label));
          if (ev && !matched.find((m) => m.id === ev.id)) matched.push(ev);
        }
        candidateGames = matched.length
          ? matched.slice(0, 4)
          : specificGames.length
          ? specificGames.slice(0, 4)
          : oddsContext.events.slice(0, 3);
      } else {
        candidateGames = specificGames.length ? specificGames.slice(0, 4) : oddsContext.events.slice(0, 3);
      }

      // Fetch player props PLUS the team markets (totals + spreads) in one call
      // so we can read each game's pace + blowout risk. The event-odds cache
      // dedupes repeated builds; +2 markets is marginal on top of the player set.
      const buildMarkets = { ...playerMarkets, markets: [...playerMarkets.markets, "totals", "spreads"] };
      const eventMarketResults = await Promise.allSettled(
        candidateGames.map((game) =>
          fetchEventOddsContext(req, sport, game.id, buildMarkets)
        )
      );

      const allProps = [];
      const gameEnvByLabel = new Map(); // gameLabel → { total, spreads, sport }
      let gamesUsed = 0;
      for (const result of eventMarketResults) {
        if (gamesUsed >= Math.max(2, Math.min(specificGames.length, 4))) break;
        if (result.status === "fulfilled" && result.value?.event) {
          const ev = result.value.event;
          const gameProps = extractPlayerPropsFromEvent(ev, preferredBook);
          if (gameProps.length > 0) {
            allProps.push(...gameProps);
            gameEnvByLabel.set(`${ev.homeTeam} vs ${ev.awayTeam}`, { ...extractGameEnv(ev), sport });
            gamesUsed += 1;
          }
        }
      }

      // Honour a requested market focus (e.g. "disposals only"): keep only that metric,
      // unless none of that market is available (then fall back to all so we still build).
      // Skipped for edits — the edit engine keeps each leg's own metric and needs the
      // full pool to find replacements.
      const focusMetric = editAction ? null : detectMultiMetricFilter(message, context);
      if (focusMetric) {
        const filtered = allProps.filter((p) => p.metric === focusMetric);
        if (filtered.length) {
          allProps.length = 0;
          allProps.push(...filtered);
        }
      }

      // No player props — say so plainly instead of inventing legs.
      if (allProps.length === 0) {
        const gameLabel = specificGame
          ? `**${specificGame.homeTeam} vs ${specificGame.awayTeam}**`
          : `the upcoming ${sport} games`;
        const bookLabel = bookmakerLabel(preferredBook);
        const checkLine = bookLabel
          ? `You've pinned odds to **${bookLabel}**, which may not price player markets for ${gameLabel} yet. Switch the bookmaker to **Best available** for the widest pool, or try again closer to game time.`
          : `Player markets are usually posted closer to game time. Try again nearer to the game, pick a different game, or ask me for the available games and head-to-head odds.`;
        return res.status(200).json({
          reply: `Simple view:\n\nI could not find ${sport} player prop markets${bookLabel ? ` at **${bookLabel}**` : ""} for ${gameLabel} right now.\n\nWhat I would check:\n\n${checkLine}\n\nImportant:\n\nThis is informational only, not betting advice.`,
          multi: null,
          oddsConnected: oddsContext.available,
          statsConnected: false,
          intent: "multi",
          sport,
          detectedTeam: detectedTeam?.team || null,
          dateWindow: dateWindow?.label || "upcoming games",
          edgeContext,
        });
      }

      if (allProps.length > 0) {
        const uniqueMetrics = [...new Set(allProps.map((p) => p.metric))];
        // For AFL position inference, always include the role-indicator metrics
        // (disposals/hitouts/marks/goals/tackles/clearances) in the stats fetch.
        // Lets us tag each leg with MID/FWD/DEF/RUC even when the prop metric
        // itself doesn't expose enough signal (e.g. a 3+ tackles prop alone
        // can't distinguish a hard-running fwd from a mid). NBA inference
        // is left to a follow-up — modern NBA roles are blurrier and need a
        // different heuristic.
        if (sport === "AFL") {
          for (const m of ["disposals", "hitouts", "marks", "goals", "tackles", "clearances"]) {
            if (!uniqueMetrics.includes(m)) uniqueMetrics.push(m);
          }
        }

        // Group players by their game so each stats lookup only asks for that game's players
        const gameGroups = new Map();
        for (const prop of allProps) {
          if (!gameGroups.has(prop.gameLabel)) {
            gameGroups.set(prop.gameLabel, {
              homeTeam: prop.homeTeam,
              awayTeam: prop.awayTeam,
              players: new Set(),
            });
          }
          gameGroups.get(prop.gameLabel).players.add(prop.playerName);
        }

        // Fetch stats for each game in parallel (only that game's players).
        // The sport-aware /api/stats endpoint handles both AFL and NBA uniformly.
        const statsResults = await Promise.all(
          [...gameGroups.values()].map((group) =>
            fetchStatsContext(req, sport, [...group.players].slice(0, 30), uniqueMetrics)
          )
        );

        // Combine players from every game, preferring entries that actually have data
        const combinedPlayers = [];
        let totalGamesAnalysed = 0;
        let anyAvailable = false;
        for (const result of statsResults) {
          if (result.available) anyAvailable = true;
          totalGamesAnalysed += result.gamesAnalysed || 0;
          for (const player of result.players || []) {
            const existing = combinedPlayers.find(
              (cp) => cp.player?.toLowerCase() === player?.player?.toLowerCase()
            );
            if (!existing) combinedPlayers.push(player);
          }
        }

        const statsContext = {
          available: anyAvailable,
          players: combinedPlayers,
          gamesAnalysed: totalGamesAnalysed,
          source: sport === "NBA" ? "balldontlie.io (cached in Supabase)" : "AFL Tables (afltables.com)",
        };

        // Defence factors: AFL only — NBA has no per-team matchup data yet (Phase 2).
        // Defence factors are now sport-aware; the /api/defense endpoint dispatches
        // off ?sport= and falls back to neutral factors when data is sparse.
        const defenseContext = await fetchDefenseContext(req, sport);
        const defenseFactors = defenseContext?.factors || null;

        // Self-improvement loop: load the latest fitted recalibration curve for
        // this sport (written weekly by scripts/recalibrate.mjs) and pass it
        // into enrichProps + computeAFLMulti. When no curve is loaded yet the
        // helpers fall through to the raw empirical untouched.
        const calibrationCurve = await loadCalibrationCurve(sport);

        // Edit path: refine the current build in place using the fresh pool, no GPT call.
        if (editAction) {
          const enrichedPool = enrichProps(allProps, statsContext, defenseFactors, calibrationCurve, gameEnvByLabel);
          const editResult = editAFLMulti(enrichedPool, currentMulti, editAction, { sport });
          if (!editResult.ok) {
            return res.status(200).json({
              reply: `Simple view:\n\n${editResult.message}\n\nWhat I would check:\n\nYou can try a different change, name a specific leg or player, or rebuild from scratch.\n\nImportant:\n\nThis is informational only, not betting advice.`,
              multi: null,
              oddsConnected: oddsContext.available,
              statsConnected: statsContext.available,
              intent: "multi_edit",
              sport,
              usage: access.usage,
              limit: access.limit,
              subscribed: access.subscribed,
              edgeContext,
            });
          }
          const m = editResult.multi;
          const evText = typeof m.evPct === "number" ? ` Form value **${m.evPct >= 0 ? "+" : ""}${m.evPct}%** (recent-form chance vs the offered price).` : "";
          const reply = `Simple view:\n\n${editResult.summary} New combined odds **$${m.combinedOdds}** at about **${m.combinedProbPct}%** across **${m.legCount} leg${m.legCount === 1 ? "" : "s"}**.${evText}\n\nWhat I would check:\n\n${m.oddsNote || "The updated leg uses the best current price and recent-form hit rate. Tweak it again any time — e.g. 'swap leg 2', 'make it safer', or 'around $3'."}\n\nRisk level:\n\n${m.risk}/10 based on the new combination.\n\nImportant:\n\nThis is informational only, not betting advice.`;
          return res.status(200).json({
            reply,
            multi: m,
            oddsConnected: oddsContext.available,
            statsConnected: statsContext.available,
            gamesAnalysed: statsContext.gamesAnalysed,
            propsFound: allProps.length,
            usage: access.usage,
            limit: access.limit,
            subscribed: access.subscribed,
            intent: "multi_edit",
            sport,
            edgeContext,
          });
        }

        const computed = computeAFLMulti(
          allProps,
          statsContext,
          targetLegs,
          targetOdds,
          riskProfile,
          defenseFactors,
          calibrationCurve,
          gameEnvByLabel
        );
        const dataBlock = buildAFLMultiDataBlock(computed, targetLegs, targetOdds, riskProfile, sport);
        const structuredMulti = buildStructuredMulti(computed, sport, targetOdds);

        // Pinned-bookmaker note — at most ONE, kept short. Either the pool fell
        // short of the requested leg count, or (if it didn't) a brief nudge to
        // confirm any alternate-line legs are listed at the book. Never both.
        const bookLabelUsed = bookmakerLabel(preferredBook);
        if (structuredMulti && bookLabelUsed) {
          const wantLegs = parseInt(targetLegs, 10);
          const altLegs = (computed.selected || []).filter((leg) => String(leg.marketKey || "").endsWith("_alternate")).length;
          if (Number.isFinite(wantLegs) && structuredMulti.legCount < wantLegs) {
            structuredMulti.bookmakerNote = `Only ${structuredMulti.legCount} of ${wantLegs} legs are available at ${bookLabelUsed} for these games — switch the bookmaker to “Best available” for more options.`;
          } else if (altLegs > 0) {
            structuredMulti.bookmakerNote = `Some legs use alternate lines — confirm they're listed at ${bookLabelUsed} before betting.`;
          }
        }

        // Low now gates on hit rate, not cushion. When it lands well short of target,
        // few near-lock lines qualified — usually the selected book lists a coarse/deep
        // line ladder (e.g. TAB), or the game lacks in-form players. One short note.
        if (structuredMulti && riskProfile === "Best Chance") {
          const tv = parseOddsValue(targetOdds);
          const got = Number(structuredMulti.combinedOdds);
          const lc = structuredMulti.legCount || 0;
          // Only flag the BOARD when genuinely few near-locks qualified (<=3). A 6-leg
          // build that simply can't stretch to a long target is NOT a thin board —
          // that's the oddsNote's "add games" job, and naming the book there would be
          // wrong (e.g. PointsBet has a full ladder; only TAB-style coarse books trip this).
          if (tv && got && got < tv - 0.30 && lc <= 3) {
            structuredMulti.cushionNote = bookLabelUsed
              ? `Only ${lc} near-lock line${lc === 1 ? "" : "s"} qualified on ${bookLabelUsed} here — try “Best available” or add a game.`
              : `Only ${lc} near-lock${lc === 1 ? "" : "s"} in this game — add a game for a fuller Low build.`;
          }
        }

        const multiCompletion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: EDGE_SYSTEM_PROMPT },
            {
              role: "user",
              content: `User request: ${message}\n\n${dataBlock}`,
            },
          ],
          temperature: 0.2,
          max_tokens: 700,
        });

        const reply =
          multiCompletion.choices?.[0]?.message?.content ||
          "Grid Build could not generate a multi right now. Please try again.";

        // Count this as a build only when a real multi was produced.
        let usageAfter = access.usage;
        if (structuredMulti && !access.subscribed && access.userId) {
          await recordGridBuildUsage(access.userId);
          usageAfter = access.usage + 1;
        }

        // Log ALL rated legs for calibration/ML — not just the selected few — so
        // the dataset covers the model's low-confidence ratings too (the legs it
        // rejects), widening the curve domain. Each row is tagged `selected` so
        // the user-facing "picks hit rate" still counts only the built legs.
        if (structuredMulti) {
          const ratedPool = enrichProps(allProps, statsContext, defenseFactors, calibrationCurve, gameEnvByLabel);
          const selectedSet = new Set(
            (computed.selected || []).map((p) => `${nameKeyFromName(p.playerName)}|${p.metric}|${p.line}`)
          );
          await recordPredictions(ratedPool, selectedSet, defenseContext?.season, access.userId);
        }

        // TEMP DEBUG: dump the full per-line ladder with Best Chance gate results so
        // we can see exactly why longer lines get rejected. Remove after diagnosing.
        let debugPool;
        if (context?.debugLegs) {
          const dp = enrichProps(allProps, statsContext, defenseFactors, calibrationCurve, gameEnvByLabel);
          debugPool = dp
            .filter((p) => p.empirical != null && Number(p.odds) > 1)
            .map((p) => {
              const form = p.hr10 && p.hr10.total >= 5 ? p.hr10.hits / p.hr10.total : null;
              return {
                player: p.playerName, metric: p.metric, line: p.line, odds: Number(p.odds),
                emp: Math.round((p.empirical ?? 0) * 100),
                form: p.hr10 ? `${p.hr10.hits}/${p.hr10.total}` : "—",
                cuZ: p.cushionZ == null ? null : Math.round(p.cushionZ * 100) / 100,
                passForm: form != null && form >= 0.8,
                passEmp: (p.empirical ?? 0) >= 0.88,
                cand: form != null && form >= 0.8 && (p.empirical ?? 0) >= 0.88,
              };
            })
            .sort((a, b) => a.player.localeCompare(b.player) || a.line - b.line);
        }

        return res.status(200).json({
          reply,
          multi: structuredMulti,
          debugPool,
          oddsConnected: oddsContext.available,
          statsConnected: statsContext.available,
          gamesAnalysed: statsContext.gamesAnalysed,
          propsFound: allProps.length,
          usage: usageAfter,
          limit: access.limit,
          subscribed: access.subscribed,
          intent: "multi",
          sport,
          detectedTeam: detectedTeam?.team || null,
          dateWindow: dateWindow?.label || "upcoming games",
          edgeContext,
        });
      }
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: EDGE_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildUserPrompt({
            message,
            context,
            oddsContext,
            userIntent,
            sport,
            detectedTeam,
            dateWindow,
          }),
        },
      ],
      temperature: 0.25,
      max_tokens: 420,
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "Grid Build could not generate a response. Please try again.";

    return res.status(200).json({
      reply,
      oddsConnected: oddsContext.available,
      intent: userIntent,
      sport,
      detectedTeam: detectedTeam?.team || null,
      dateWindow: dateWindow?.label || "upcoming games",
      edgeContext,
    });
  } catch (error) {
    console.error("Edge API error:", error);

    if (error?.status === 429) {
      return res.status(429).json({
        error:
          "Grid Build is temporarily unavailable because the AI usage limit has been reached. Please try again later.",
      });
    }

    if (error?.status === 401) {
      return res.status(401).json({
        error:
          "Grid Build could not authenticate with the AI provider. Check the OpenAI API key in Vercel.",
      });
    }

    return res.status(500).json({
      error: "Grid Build could not respond right now. Please try again shortly.",
    });
  }
}