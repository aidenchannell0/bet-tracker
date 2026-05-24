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
function enrichProps(props, aflStats) {
  const statsMap = new Map();
  for (const ps of aflStats?.players || []) {
    statsMap.set(String(ps.player || "").toLowerCase(), ps);
  }

  return props.map((prop) => {
    const matched = matchStatsForProp(prop, statsMap);
    const ms = matched?.metrics?.[prop.metric];

    if (!ms?.available) return { ...prop, statsAvailable: false };

    const hr5 = computeHitRate(ms.last5Values, prop.line);
    const hr10 = computeHitRate(ms.last10Values, prop.line);
    const implied = impliedProbFromOdds(prop.odds);

    // Laplace-smoothed probabilities (rule of succession) so small samples and
    // perfect records don't read as a literal 100% / 0% chance.
    const smoothed = (hr) => (hr ? (hr.hits + 1) / (hr.total + 2) : null);
    const p5 = smoothed(hr5);
    const p10 = smoothed(hr10);

    // Blend recent (last 5) with the larger, steadier sample (last 10)
    let empirical = null;
    if (p5 != null && p10 != null) empirical = p5 * 0.4 + p10 * 0.6;
    else if (p10 != null) empirical = p10;
    else if (p5 != null) empirical = p5;

    const edge = empirical != null && implied != null ? empirical - implied : null;

    return {
      ...prop,
      statsAvailable: true,
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

function computeCombinedMetrics(selected) {
  const combinedOdds = selected.reduce((acc, p) => acc * Number(p.odds), 1);
  const combinedProb = selected.reduce((acc, p) => acc * (p.empirical ?? 0), 1);
  const ev = combinedProb * combinedOdds - 1;
  return {
    combinedOdds: Number(combinedOdds.toFixed(2)),
    combinedProb,
    combinedProbPct: Math.round(combinedProb * 100),
    evPct: Math.round(ev * 100),
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
function computeAFLMulti(props, aflStats, targetLegs, targetOdds, riskProfile) {
  const enriched = enrichProps(props, aflStats);
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

// Structured multi for the output panel (separate from the GPT narration)
function buildStructuredMulti(computed, sport, targetOdds) {
  if (!computed.selected.length) return null;
  const { selected, metrics, risk } = computed;

  const legs = selected.map((p) => {
    const empPct = Math.round((p.empirical ?? 0) * 100);
    const impPct = p.implied != null ? Math.round(p.implied * 100) : null;
    const edgePct = p.edge != null ? Math.round(p.edge * 100) : null;
    const l5 = p.hr5 ? `${p.hr5.hits}/${p.hr5.total}` : "N/A";
    const l10 = p.hr10 ? `${p.hr10.hits}/${p.hr10.total}` : "N/A";

    return {
      name: `${p.playerName} Over ${p.line} ${metricLabel(p.metric)}`,
      player: p.playerName,
      game: p.gameLabel,
      odds: p.odds,
      bookmaker: p.bookmaker || null,
      confidence: `${empPct}%`,
      reason: `Cleared this line in ${l10} recent games, averaging ${p.recentAvg}.`,
      details: [
        { label: "Market line", value: `Over ${p.line}` },
        { label: "Best odds", value: p.bookmaker ? `$${p.odds} (${p.bookmaker})` : `$${p.odds}` },
        { label: "Recent average", value: `${p.recentAvg}` },
        { label: "Last 5 hit rate", value: l5 },
        { label: "Last 10 hit rate", value: l10 },
        { label: "Form edge", value: edgePct != null ? `${edgePct >= 0 ? "+" : ""}${edgePct}%` : "N/A" },
      ],
      trend: `Last 5 results: ${(p.last5Values || []).join(", ")}.`,
      extraReason: `Recent-form chance ${empPct}%${impPct != null ? ` vs odds-implied ${impPct}%` : ""}. Based on ${p.sampleSize} recent games.`,
    };
  });

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
    targetOdds,
    oddsNote,
    risk,
    riskExplanation: `A ${risk}/10 score reflects ${selected.length} legs with a combined recent-form chance of about ${metrics.combinedProbPct}%. More legs and lower individual hit rates raise the risk. This is based on historical stats only and does not guarantee the outcome.`,
  };
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

    if (userIntent === "market_stats_comparison" && requestedMarket?.metric) {
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

    if (userIntent === "player_stats") {
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

    if (userIntent === "event_markets" && requestedMarket) {
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

    if (userIntent === "available_games") {
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
    if (userIntent === "multi" && sport === "AFL") {
      // Free tier: 3 builds/week. Subscribers are unlimited. Checked before the
      // expensive odds/stat work so a gated request costs nothing.
      const access = await checkGridBuildAccess(req);
      if (access.gated) {
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
      const candidateGames = specificGame ? [specificGame] : oddsContext.events.slice(0, 3);

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
      const focusMetric = detectMultiMetricFilter(message, context);
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

        const computed = computeAFLMulti(
          allProps,
          aflStatsContext,
          targetLegs,
          targetOdds,
          riskProfile
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