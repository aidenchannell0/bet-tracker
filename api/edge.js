import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const EDGE_SYSTEM_PROMPT = `
You are Edge, a professional sports analysis assistant for Bet Tracker.

Your role:
- Help users understand sports markets in a simple way.
- Help users explore informational example multis.
- Explain risk clearly.
- Explain what data should be checked before making any decision.
- Use available odds data when it is provided.

Tone:
- 75% professional, 25% friendly.
- Clear, calm, direct, and easy to understand.
- Sound like a helpful analyst, not a hype betting tipster.
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

    if (lowerMessage.includes("mark")) {
      return {
        label: "marks",
        metric: "marks",
        markets: ["player_marks_over", "player_marks_most"],
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

  const asksForMulti =
    lowerMessage.includes("multi") ||
    lowerMessage.includes("leg") ||
    lowerMessage.includes("legs") ||
    lowerMessage.includes("build") ||
    lowerMessage.includes("selection") ||
    lowerMessage.includes("example bet");

  if (asksForGames && !asksForMulti) return "available_games";
  if (asksForMulti) return "multi";
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

async function fetchEventOddsContext(req, sport, eventId, requestedMarket) {
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

    return {
      available: true,
      event: data.event,
      summary: summariseEventMarkets(data.event, requestedMarket),
      quota: data.quota,
    };
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
  if (lowerMessage.includes("mark")) return "marks";
  if (lowerMessage.includes("goal")) return "goals";
  if (lowerMessage.includes("kick")) return "kicks";
  if (lowerMessage.includes("handball")) return "handballs";

  return requestedMarket?.metric || "fantasy_points";
}

function extractRequestedPlayers(message) {
  const text = String(message || "");

  if (text.toLowerCase().includes("test player")) {
    return ["Test Player"];
  }

  return [];
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

Respond as Edge.

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
      "Edge could not generate a response. Please try again.";

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
          "Edge is temporarily unavailable because the AI usage limit has been reached. Please try again later.",
      });
    }

    if (error?.status === 401) {
      return res.status(401).json({
        error:
          "Edge could not authenticate with the AI provider. Check the OpenAI API key in Vercel.",
      });
    }

    return res.status(500).json({
      error: "Edge could not respond right now. Please try again shortly.",
    });
  }
}