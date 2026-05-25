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
async function recordPredictions(selected, season, userId) {
  if (!supabaseAdmin || !selected?.length) return;
  try {
    const week = isoWeekKey();
    const rows = selected
      .filter((p) => p.playerName && p.metric && p.line != null && p.empirical != null)
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
          dedupe_key: `${nk}|${p.metric}|${p.line}|${week}`,
        };
      });
    if (rows.length) {
      await supabaseAdmin.from("grid_build_predictions").upsert(rows, { onConflict: "dedupe_key" });
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

async function fetchAFLStatsContext(req, team1, team2, players, metrics) {
  try {
    const baseUrl = buildBaseUrl(req);
    const url = new URL("/api/afl-stats", baseUrl);

    url.searchParams.set("team1", team1);
    url.searchParams.set("team2", team2);
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
      source: data.source || "Squiggle API",
      year: data.year,
    };
  } catch (error) {
    console.error("AFL stats context error:", error);
    return { available: false, players: [], gamesAnalysed: 0 };
  }
}

// Per-team defensive factors for the current season (cached server-side).
async function fetchDefenseContext(req) {
  try {
    const baseUrl = buildBaseUrl(req);
    const url = new URL("/api/afl-defense", baseUrl);
    const response = await fetch(url.toString());
    const data = await response.json();
    if (!response.ok || !data.available) return { available: false, factors: null };
    return { available: true, factors: data.factors || null, season: data.season };
  } catch (error) {
    console.error("AFL defense context error:", error);
    return { available: false, factors: null };
  }
}

function extractPlayerPropsFromEvent(event) {
  const props = [];
  const overMarketKeys = [
    "player_disposals_over",
    "player_goals_scored_over",
    "player_marks_over",
    "player_tackles_over",
    "player_afl_fantasy_points_over",
    "player_clearances_over",
    "player_kicks_over",
    "player_handballs_over",
  ];

  const metricFromMarket = {
    player_disposals_over: "disposals",
    player_goals_scored_over: "goals",
    player_marks_over: "marks",
    player_tackles_over: "tackles",
    player_afl_fantasy_points_over: "fantasy_points",
    player_clearances_over: "clearances",
    player_kicks_over: "kicks",
    player_handballs_over: "handballs",
  };

  // For each unique player+market+line, keep the BEST (highest) price across all
  // bookmakers, and record which book offers it — that's the most accurate, useful odds.
  const bestByKey = new Map();

  for (const bookmaker of event?.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      if (!overMarketKeys.includes(market.key)) continue;

      for (const outcome of market.outcomes || []) {
        const isOver = outcome.name === "Over" || market.key.includes("_over");
        if (!isOver) continue;

        const player = outcome.description || outcome.name;
        if (!player || player === "Over") continue;

        const price = Number(outcome.price);
        if (!price || price <= 1) continue;

        const key = `${player}-${market.key}-${outcome.point}`;
        const existing = bestByKey.get(key);
        if (existing && price <= existing.odds) continue;

        bestByKey.set(key, {
          playerName: player,
          metric: metricFromMarket[market.key] || "disposals",
          marketKey: market.key,
          line: outcome.point,
          odds: price,
          bookmaker: bookmaker.title,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          gameLabel: `${event.homeTeam} vs ${event.awayTeam}`,
        });
      }
    }
  }

  props.push(...bestByKey.values());
  return props;
}

function impliedProbFromOdds(odds) {
  const value = Number(odds);
  return value > 1 ? 1 / value : null;
}

function computeHitRate(values, line) {
  if (!values?.length || line == null) return null;
  const hits = values.filter((v) => v >= line).length;
  return { hits, total: values.length, prob: hits / values.length };
}

function parseOddsValue(targetOdds) {
  const value = parseFloat(String(targetOdds).replace(/[^0-9.]/g, ""));
  return isNaN(value) ? null : value;
}

function propKey(prop) {
  return `${prop.playerName}|${prop.metric}|${prop.line}`;
}

function matchStatsForProp(prop, statsMap) {
  const normName = String(prop.playerName || "").toLowerCase();
  const propWords = normName.split(" ").filter(Boolean);
  const propLast = propWords[propWords.length - 1];
  const propFirst = propWords[0]?.[0];

  for (const [key, stats] of statsMap.entries()) {
    const keyWords = key.split(" ").filter(Boolean);
    const keyLast = keyWords[keyWords.length - 1];
    if (!keyLast || !propLast || keyLast !== propLast) continue;
    const keyFirst = keyWords[0]?.[0];
    if (!keyFirst || !propFirst || keyFirst === propFirst) return stats;
  }
  return null;
}

// Attach probability, edge and recent-form numbers to each prop
function enrichProps(props, aflStats, factors = null) {
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
    const implied = impliedProbFromOdds(prop.odds);

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

    // Matchup-adjusted hit rates feed the confidence/empirical only
    const scaleVals = (vals) =>
      matchupFactor === 1 ? vals || [] : (vals || []).map((v) => v * matchupFactor);
    const adjHr5 = computeHitRate(scaleVals(ms.last5Values), prop.line);
    const adjHr10 = computeHitRate(scaleVals(ms.last10Values), prop.line);

    // Laplace-smoothed probabilities (rule of succession) so small samples and
    // perfect records don't read as a literal 100% / 0% chance.
    const smoothed = (hr) => (hr ? (hr.hits + 1) / (hr.total + 2) : null);
    const p5 = smoothed(adjHr5);
    const p10 = smoothed(adjHr10);

    // Blend recent (last 5) with the larger, steadier sample (last 10)
    let empirical = null;
    if (p5 != null && p10 != null) empirical = p5 * 0.4 + p10 * 0.6;
    else if (p10 != null) empirical = p10;
    else if (p5 != null) empirical = p5;

    const edge = empirical != null && implied != null ? empirical - implied : null;

    return {
      ...prop,
      statsAvailable: true,
      team: matched?.team || null,
      opponent,
      matchupFactor,
      recentAvg: ms.recentAvg,
      avg10: ms.avg10,
      last5Values: ms.last5Values || [],
      sampleSize: (ms.last10Values || []).length,
      hr5,
      hr10,
      implied,
      empirical,
      edge,
      margin: ms.recentAvg != null ? Number((ms.recentAvg - prop.line).toFixed(1)) : null,
    };
  });
}

// Deterministically pick the strongest legs for the target and risk profile
function selectOptimalLegs(enriched, targetLegs, targetOddsValue, riskProfile) {
  const candidates = enriched.filter(
    (p) => p.statsAvailable && p.empirical != null && Number(p.odds) > 1 && p.sampleSize >= 3
  );

  const minHit = riskProfile === "Safer" ? 0.7 : riskProfile === "Aggressive" ? 0.45 : 0.58;

  // Keep the single best-scoring prop per player (a multi can't repeat a player)
  const byPlayer = new Map();
  for (const p of candidates) {
    const score = (p.empirical ?? 0) + Math.max(0, p.edge ?? 0) * 1.5;
    const current = byPlayer.get(p.playerName);
    if (!current || score > current.score) byPlayer.set(p.playerName, { ...p, score });
  }

  const ranked = [...byPlayer.values()];
  const ordered = [
    ...ranked.filter((p) => p.empirical >= minHit).sort((a, b) => b.score - a.score),
    ...ranked.filter((p) => p.empirical < minHit).sort((a, b) => b.score - a.score),
  ];

  const wantCount =
    targetLegs === "Any" || !targetLegs ? null : Math.max(1, parseInt(targetLegs, 10) || 3);

  // No target odds: just honour the requested leg count by quality
  if (!targetOddsValue) {
    return ordered.slice(0, wantCount || 3);
  }

  // Target odds set: search combinations across leg counts and return one whose combined
  // odds land within a tolerance of the target (e.g. $2 -> $1.80–$2.20). Tolerance widens
  // only if no tighter combo exists. Prefer the requested leg count, then highest chance.
  const shortlist = ordered.slice(0, Math.min(ordered.length, 14));
  if (!shortlist.length) return [];

  const minLegs = 2;
  const maxLegs = Math.min(7, shortlist.length);

  const combos = [];
  let closest = null;
  const choose = (start, acc) => {
    if (acc.length >= minLegs) {
      const odds = acc.reduce((a, p) => a * Number(p.odds), 1);
      const prob = acc.reduce((a, p) => a * (p.empirical ?? 0), 1);
      const diff = Math.abs(odds - targetOddsValue);
      const legPenalty = wantCount ? Math.abs(acc.length - wantCount) : 0;
      const cand = { legs: [...acc], prob, diff, legPenalty };
      combos.push(cand);
      if (!closest || diff < closest.diff) closest = cand;
    }
    if (acc.length >= maxLegs) return;
    for (let i = start; i < shortlist.length; i++) {
      acc.push(shortlist[i]);
      choose(i + 1, acc);
      acc.pop();
    }
  };
  choose(0, []);

  // Tightest tolerance band that contains at least one combo
  let pool = [];
  for (const tol of [0.2, 0.35, 0.5, 0.75, 1.0, Infinity]) {
    pool = combos.filter((c) => c.diff <= tol);
    if (pool.length) break;
  }
  if (!pool.length) pool = closest ? [closest] : [];
  if (!pool.length) return ordered.slice(0, wantCount || 3);

  // Prefer requested leg count, then highest combined chance, then closest to target
  pool.sort((a, b) => a.legPenalty - b.legPenalty || b.prob - a.prob || a.diff - b.diff);
  return pool[0].legs.sort((a, b) => b.score - a.score);
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
  "disposals", "kicks", "handballs", "marks", "clearances", "fantasy_points",
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
  disposals: "disposals",
  goals: "goals",
  marks: "marks",
  tackles: "tackles",
  fantasy_points: "fantasy points",
  kicks: "kicks",
  handballs: "handballs",
  clearances: "clearances",
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
  if (lower.includes("safer") || lower.includes("safe multi") || lower.includes("low risk")) return "Safer";
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
function computeAFLMulti(props, aflStats, targetLegs, targetOdds, riskProfile, factors = null) {
  const enriched = enrichProps(props, aflStats, factors);
  const targetOddsValue = parseOddsValue(targetOdds);
  const selected = selectOptimalLegs(enriched, targetLegs, targetOddsValue, riskProfile);
  const dataSource = aflStats?.available
    ? `AFL Tables — ${aflStats.gamesAnalysed} recent games analysed`
    : "AFL Tables stats unavailable";

  if (!selected.length) {
    return { selected: [], enriched, dataSource, metrics: null, risk: null };
  }

  const metrics = computeCombinedMetrics(selected);
  const risk = computeRiskScore(metrics.combinedProb, selected.length);
  return { selected, enriched, dataSource, metrics, risk };
}

// Build one structured leg from an enriched prop (shared by fresh builds + edits)
function structureLegFromEnriched(p) {
  const empPct = Math.round((p.empirical ?? 0) * 100);
  const impPct = p.implied != null ? Math.round(p.implied * 100) : null;
  const edgePct = p.edge != null ? Math.round(p.edge * 100) : null;
  const l5 = p.hr5 ? `${p.hr5.hits}/${p.hr5.total}` : "N/A";
  const l10 = p.hr10 ? `${p.hr10.hits}/${p.hr10.total}` : "N/A";
  const matchupPct = p.matchupFactor && p.matchupFactor !== 1 ? Math.round((p.matchupFactor - 1) * 100) : 0;

  const details = [
    { label: "Market line", value: `Over ${p.line}` },
    { label: "Best odds", value: p.bookmaker ? `$${p.odds} (${p.bookmaker})` : `$${p.odds}` },
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

  return {
    name: `${p.playerName} Over ${p.line} ${metricLabel(p.metric)}`,
    player: p.playerName,
    metric: p.metric,
    team: p.team || null,
    opponent: p.opponent || null,
    matchupFactor: p.matchupFactor || 1,
    game: p.gameLabel,
    odds: p.odds,
    bookmaker: p.bookmaker || null,
    confidence: `${empPct}%`,
    edgePct, // form hit-rate minus odds-implied probability (the value signal)
    reason: `Cleared this line in ${l10} recent games, averaging ${p.recentAvg}.`,
    details,
    trend: `Last 5 results: ${(p.last5Values || []).join(", ")}.`,
    extraReason: `Recent-form chance ${empPct}%${impPct != null ? ` vs odds-implied ${impPct}%` : ""}${matchupPct !== 0 && p.opponent ? `, matchup-adjusted for ${p.opponent} (${matchupPct >= 0 ? "+" : ""}${matchupPct}% ${metricLabel(p.metric)})` : ""}. Based on ${p.sampleSize} recent games.`,
  };
}

// Structured multi for the output panel (separate from the GPT narration)
function buildStructuredMulti(computed, sport, targetOdds) {
  if (!computed.selected.length) return null;
  const { selected, metrics, risk } = computed;

  const legs = selected.map(structureLegFromEnriched);

  const targetVal = parseOddsValue(targetOdds);
  let oddsNote = null;
  if (targetVal && metrics.combinedOdds > targetVal * 1.25) {
    oddsNote = `${selected.length} legs naturally pays more than your ${targetOdds} target — for odds nearer ${targetOdds}, try fewer legs.`;
  } else if (targetVal && metrics.combinedOdds < targetVal * 0.8) {
    oddsNote = `These legs combine below your ${targetOdds} target — for higher odds, add more legs.`;
  }

  return {
    sport,
    legCount: selected.length,
    legs,
    combinedOdds: metrics.combinedOdds,
    combinedProbPct: metrics.combinedProbPct,
    independentProbPct: metrics.independentProbPct,
    correlated: metrics.correlated,
    evPct: metrics.evPct, // combined recent-form chance vs the offered price
    valueLegs: legs.filter((l) => typeof l.edgePct === "number" && l.edgePct > 0).length,
    targetOdds,
    oddsNote,
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
  const evPct = Math.round((combinedProb * combinedOdds - 1) * 100);
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
    const used = usedPlayers();
    used.delete((old.player || "").toLowerCase());
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
    const used = usedPlayers();
    used.delete((old.player || "").toLowerCase());
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

function buildAFLMultiDataBlock(computed, targetLegs, targetOdds, riskProfile) {
  const { selected, enriched, dataSource, metrics, risk } = computed;

  if (!selected.length) {
    return `
PRE-COMPUTED AFL MULTI (no qualifying legs)
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
      return `LEG ${i + 1}: ${p.playerName} — ${p.metric} Over ${p.line} @ $${p.odds}${p.bookmaker ? ` (best at ${p.bookmaker})` : ""} (${p.gameLabel})
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
        `• ${p.playerName} — ${p.metric} Over ${p.line} @ $${p.odds} | form chance ${fmtPct(p.empirical)} | edge ${fmtEdge(p.edge)}`
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
PRE-COMPUTED AFL MULTI (all numbers below are already calculated by the app's math engine — DO NOT recompute or change selections, just present and explain them)
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
    const { message, context } = req.body || {};

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

    // AFL multi builder: fetch real player props + Squiggle stats before sending to GPT
    if ((editAction || userIntent === "multi") && sport === "AFL") {
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
          aflStatsConnected: false,
          intent: "multi",
          sport,
          detectedTeam: detectedTeam?.team || null,
          dateWindow: dateWindow?.label || "upcoming games",
          edgeContext,
        });
      }

      const allAFLPlayerMarkets = {
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
      };

      // Prefer values stated in the message (e.g. "give me a 3 leg multi"), fall back to the form
      const targetLegs =
        detectLegCountFromMessage(message) || getSafeString(context?.legs, "3");
      const targetOdds =
        detectTargetOddsFromMessage(message) || getSafeString(context?.targetOdds, "$2.00");
      const riskProfile =
        detectRiskFromMessage(message) || getSafeString(context?.riskProfile, "Balanced");

      // Choose which game(s) to build from: a specific game (selected in the form, or
      // named in the chat) if given; otherwise probe the first few upcoming games.
      const requestedGameId = getSafeString(context?.gameId, "");
      const teamsInMessage = detectAllTeamAliases(message);
      const namedGame =
        !requestedGameId && teamsInMessage.length
          ? findMatchingEvent(oddsContext.events, message, teamsInMessage)
          : null;
      const specificGame = requestedGameId
        ? oddsContext.events.find((e) => e.id === requestedGameId)
        : namedGame;
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
          ? matched.slice(0, 3)
          : specificGame
          ? [specificGame]
          : oddsContext.events.slice(0, 3);
      } else {
        candidateGames = specificGame ? [specificGame] : oddsContext.events.slice(0, 3);
      }

      const eventMarketResults = await Promise.allSettled(
        candidateGames.map((game) =>
          fetchEventOddsContext(req, sport, game.id, allAFLPlayerMarkets)
        )
      );

      const allProps = [];
      let gamesUsed = 0;
      for (const result of eventMarketResults) {
        if (gamesUsed >= 2) break;
        if (result.status === "fulfilled" && result.value?.event) {
          const gameProps = extractPlayerPropsFromEvent(result.value.event);
          if (gameProps.length > 0) {
            allProps.push(...gameProps);
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
        return res.status(200).json({
          reply: `Simple view:\n\nI could not find player prop markets (disposals, goals, tackles and similar) for ${gameLabel} right now.\n\nWhat I would check:\n\nPlayer markets are usually posted closer to game time. Try again nearer to the game, pick a different game, or ask me for the available games and head-to-head odds.\n\nImportant:\n\nThis is informational only, not betting advice.`,
          multi: null,
          oddsConnected: oddsContext.available,
          aflStatsConnected: false,
          intent: "multi",
          sport,
          detectedTeam: detectedTeam?.team || null,
          dateWindow: dateWindow?.label || "upcoming games",
          edgeContext,
        });
      }

      if (allProps.length > 0) {
        const uniqueMetrics = [...new Set(allProps.map((p) => p.metric))];

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

        // Fetch AFL Tables stats for each game in parallel (only that game's players)
        const statsResults = await Promise.all(
          [...gameGroups.values()].map((group) =>
            fetchAFLStatsContext(
              req,
              group.homeTeam,
              group.awayTeam,
              [...group.players].slice(0, 30),
              uniqueMetrics
            )
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

        const aflStatsContext = {
          available: anyAvailable,
          players: combinedPlayers,
          gamesAnalysed: totalGamesAnalysed,
          source: "AFL Tables (afltables.com)",
        };

        // Opponent defensive factors (current season) to matchup-adjust each leg
        const defenseContext = await fetchDefenseContext(req);
        const defenseFactors = defenseContext?.factors || null;

        // Edit path: refine the current build in place using the fresh pool, no GPT call.
        if (editAction) {
          const enrichedPool = enrichProps(allProps, aflStatsContext, defenseFactors);
          const editResult = editAFLMulti(enrichedPool, currentMulti, editAction, { sport });
          if (!editResult.ok) {
            return res.status(200).json({
              reply: `Simple view:\n\n${editResult.message}\n\nWhat I would check:\n\nYou can try a different change, name a specific leg or player, or rebuild from scratch.\n\nImportant:\n\nThis is informational only, not betting advice.`,
              multi: null,
              oddsConnected: oddsContext.available,
              aflStatsConnected: aflStatsContext.available,
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
            aflStatsConnected: aflStatsContext.available,
            gamesAnalysed: aflStatsContext.gamesAnalysed,
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
          aflStatsContext,
          targetLegs,
          targetOdds,
          riskProfile,
          defenseFactors
        );
        const dataBlock = buildAFLMultiDataBlock(computed, targetLegs, targetOdds, riskProfile);
        const structuredMulti = buildStructuredMulti(computed, sport, targetOdds);

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

        // Log the rated legs for calibration (compare predictions vs outcomes later)
        if (structuredMulti && computed.selected?.length) {
          await recordPredictions(computed.selected, defenseContext?.season, access.userId);
        }

        return res.status(200).json({
          reply,
          multi: structuredMulti,
          oddsConnected: oddsContext.available,
          aflStatsConnected: aflStatsContext.available,
          gamesAnalysed: aflStatsContext.gamesAnalysed,
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