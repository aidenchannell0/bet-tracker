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
- Live historical player statistics are not connected yet.
- Current injuries, team news, lineups and player form are not connected yet.
- Do not invent player stats, injuries, lineups, or player hit rates.
- If the user asks for player-market analysis, explain that market lines may be available but averages and hit rates still need a stats source.

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

Placeholder example rule:
- If the user asks for an example multi and player stats are not available, provide a generic placeholder structure.
- Use placeholders like Player A, Player B, Team A, Team B, Midfielder A, Forward B.
- Do not use real player names unless the user provides player data or real market data includes those player names.
- Do not pretend placeholder picks are real tips.
- Clearly label placeholder multis as example structures only.

Formatting rules:
- Keep responses simple and easy for everyday users to understand.
- Do not show equations, formulas, or odds multiplication unless the user specifically asks.
- Do not over-explain the maths.
- Do not use Markdown headings like ###.
- You may use bold markers like **text** only for important player names, team names, markets, stats, odds, disposals, goals, hit rates, and risk scores.
- When mentioning important player names, team names, markets, stats, odds, disposals, goals, hit rates, or risk scores, wrap them in **bold** markers so they are easier to scan.
- Never put the whole answer in one paragraph.
- Use blank lines between each section.
- Keep most responses under 260 words.
- Prioritise clarity over detail.
- Use simple section labels like these when useful:

Simple view:

Available games:

Example structure:

What I would check:

Risk level:

Important:

Edge analysis rules:
- Do not make vague claims like "consistent", "strong recently", or "in form" unless exact supporting numbers are provided.
- For example multis, describe the structure, risk factors, and data required in simple terms.
- If the user asks for a multi, frame it as an example construction only.
- Explain risk using a 1 to 10 scale when relevant.
- If the user asks for disposals-only, goals-only, points-only, etc., respect that filter in the example structure.
- Keep the answer focused on what the user asked.
`;

const TEAM_ALIAS_MAP = [
  // NRL
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

  // AFL
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

  // EPL
  { aliases: ["man city", "manchester city"], sport: "EPL", team: "Manchester City" },
  { aliases: ["man united", "man utd", "manchester united"], sport: "EPL", team: "Manchester United" },
  { aliases: ["arsenal"], sport: "EPL", team: "Arsenal" },
  { aliases: ["chelsea"], sport: "EPL", team: "Chelsea" },
  { aliases: ["liverpool"], sport: "EPL", team: "Liverpool" },
  { aliases: ["spurs", "tottenham", "tottenham hotspur"], sport: "EPL", team: "Tottenham Hotspur" },
  { aliases: ["newcastle", "newcastle united"], sport: "EPL", team: "Newcastle United" },
  { aliases: ["aston villa", "villa"], sport: "EPL", team: "Aston Villa" },
  { aliases: ["west ham"], sport: "EPL", team: "West Ham United" },
  { aliases: ["everton"], sport: "EPL", team: "Everton" },
  { aliases: ["leeds", "leeds united"], sport: "EPL", team: "Leeds United" },

  // NBA
  { aliases: ["lakers", "la lakers", "los angeles lakers"], sport: "NBA", team: "Los Angeles Lakers" },
  { aliases: ["warriors", "golden state warriors"], sport: "NBA", team: "Golden State Warriors" },
  { aliases: ["celtics", "boston celtics"], sport: "NBA", team: "Boston Celtics" },
  { aliases: ["bulls", "chicago bulls"], sport: "NBA", team: "Chicago Bulls" },
  { aliases: ["knicks", "new york knicks"], sport: "NBA", team: "New York Knicks" },
  { aliases: ["heat", "miami heat"], sport: "NBA", team: "Miami Heat" },
  { aliases: ["nuggets", "denver nuggets"], sport: "NBA", team: "Denver Nuggets" },
  { aliases: ["mavericks", "mavs", "dallas mavericks"], sport: "NBA", team: "Dallas Mavericks" },
  { aliases: ["bucks", "milwaukee bucks"], sport: "NBA", team: "Milwaukee Bucks" },
  { aliases: ["suns", "phoenix suns"], sport: "NBA", team: "Phoenix Suns" },

  // NFL
  { aliases: ["chiefs", "kansas city chiefs"], sport: "NFL", team: "Kansas City Chiefs" },
  { aliases: ["eagles", "philadelphia eagles"], sport: "NFL", team: "Philadelphia Eagles" },
  { aliases: ["cowboys", "dallas cowboys"], sport: "NFL", team: "Dallas Cowboys" },
  { aliases: ["niners", "49ers", "san francisco 49ers"], sport: "NFL", team: "San Francisco 49ers" },
  { aliases: ["patriots", "new england patriots"], sport: "NFL", team: "New England Patriots" },
  { aliases: ["packers", "green bay packers"], sport: "NFL", team: "Green Bay Packers" },
  { aliases: ["ravens", "baltimore ravens"], sport: "NFL", team: "Baltimore Ravens" },
  { aliases: ["bills", "buffalo bills"], sport: "NFL", team: "Buffalo Bills" },

  // MLB
  { aliases: ["yankees", "new york yankees"], sport: "MLB", team: "New York Yankees" },
  { aliases: ["dodgers", "la dodgers", "los angeles dodgers"], sport: "MLB", team: "Los Angeles Dodgers" },
  { aliases: ["red sox", "boston red sox"], sport: "MLB", team: "Boston Red Sox" },
  { aliases: ["mets", "new york mets"], sport: "MLB", team: "New York Mets" },
  { aliases: ["cubs", "chicago cubs"], sport: "MLB", team: "Chicago Cubs" },

  // NHL
  { aliases: ["maple leafs", "leafs", "toronto maple leafs"], sport: "NHL", team: "Toronto Maple Leafs" },
  { aliases: ["bruins", "boston bruins"], sport: "NHL", team: "Boston Bruins" },
  { aliases: ["rangers", "new york rangers"], sport: "NHL", team: "New York Rangers" },
  { aliases: ["oilers", "edmonton oilers"], sport: "NHL", team: "Edmonton Oilers" },
  { aliases: ["canucks", "vancouver canucks"], sport: "NHL", team: "Vancouver Canucks" },
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

function detectTeamAlias(message) {
  const lowerMessage = String(message || "").toLowerCase();

  for (const entry of TEAM_ALIAS_MAP) {
    for (const alias of entry.aliases) {
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const aliasPattern = new RegExp(`\\b${escapedAlias}\\b`, "i");

      if (aliasPattern.test(lowerMessage)) {
        return entry;
      }
    }
  }

  return null;
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
  const teamAlias = detectTeamAlias(message);

  if (teamAlias) return teamAlias.sport;
  if (lowerMessage.includes("nrl") || lowerMessage.includes("rugby league")) return "NRL";
  if (lowerMessage.includes("afl") || lowerMessage.includes("aussie rules")) return "AFL";
  if (lowerMessage.includes("epl") || lowerMessage.includes("premier league")) return "EPL";
  if (lowerMessage.includes("champions league") || lowerMessage.includes("ucl")) return "ChampionsLeague";
  if (lowerMessage.includes("nba") || lowerMessage.includes("basketball")) return "NBA";
  if (lowerMessage.includes("nfl") || lowerMessage.includes("american football")) return "NFL";
  if (lowerMessage.includes("mlb") || lowerMessage.includes("baseball")) return "MLB";
  if (lowerMessage.includes("nhl") || lowerMessage.includes("ice hockey")) return "NHL";

  if (
    lowerMessage.includes("soccer") ||
    lowerMessage.includes("football") ||
    lowerMessage.includes("a-league") ||
    lowerMessage.includes("aleague")
  ) {
    return "Soccer";
  }

  if (lowerMessage.includes("cricket")) return "Cricket";
  if (lowerMessage.includes("ufc") || lowerMessage.includes("mma")) return "UFC";
  if (lowerMessage.includes("tennis")) return "Tennis";

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
    const from = startOfDay(addDays(now, 1));
    const to = startOfDay(addDays(now, 2));

    return {
      label: "tomorrow",
      commenceTimeFrom: toIso(from),
      commenceTimeTo: toIso(to),
    };
  }

  if (
    lowerMessage.includes("week after") ||
    lowerMessage.includes("week after this week") ||
    lowerMessage.includes("next week") ||
    lowerMessage.includes("following week")
  ) {
    const from = startOfDay(addDays(now, 7));
    const to = startOfDay(addDays(now, 14));

    return {
      label: "next week",
      commenceTimeFrom: toIso(from),
      commenceTimeTo: toIso(to),
    };
  }

  if (lowerMessage.includes("this week")) {
    const from = now;
    const to = startOfDay(addDays(now, 7));

    return {
      label: "this week",
      commenceTimeFrom: toIso(from),
      commenceTimeTo: toIso(to),
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
        markets: ["player_disposals_over", "player_disposals"],
      };
    }

    if (lowerMessage.includes("clearance")) {
      return {
        label: "clearances",
        markets: ["player_clearances_over"],
      };
    }

    if (lowerMessage.includes("tackle")) {
      return {
        label: "tackles",
        markets: ["player_tackles_over", "player_tackles_most"],
      };
    }

    if (lowerMessage.includes("mark")) {
      return {
        label: "marks",
        markets: ["player_marks_over", "player_marks_most"],
      };
    }

    if (lowerMessage.includes("first goal")) {
      return {
        label: "first goalscorer",
        markets: ["player_goal_scorer_first"],
      };
    }

    if (lowerMessage.includes("last goal")) {
      return {
        label: "last goalscorer",
        markets: ["player_goal_scorer_last"],
      };
    }

    if (lowerMessage.includes("goalscorer") || lowerMessage.includes("goal scorer")) {
      return {
        label: "goalscorer",
        markets: ["player_goal_scorer_anytime", "player_goal_scorer_first", "player_goal_scorer_last"],
      };
    }

    if (lowerMessage.includes("goal")) {
      return {
        label: "goals",
        markets: ["player_goals_scored_over", "player_goal_scorer_anytime"],
      };
    }

    if (lowerMessage.includes("kick")) {
      return {
        label: "kicks",
        markets: ["player_kicks_over"],
      };
    }

    if (lowerMessage.includes("handball")) {
      return {
        label: "handballs",
        markets: ["player_handballs_over"],
      };
    }
  }

  if (sport === "NRL") {
    if (lowerMessage.includes("first try")) {
      return {
        label: "first tryscorer",
        markets: ["player_try_scorer_first"],
      };
    }

    if (lowerMessage.includes("last try")) {
      return {
        label: "last tryscorer",
        markets: ["player_try_scorer_last"],
      };
    }

    if (lowerMessage.includes("anytime") || lowerMessage.includes("try scorer") || lowerMessage.includes("tryscorer")) {
      return {
        label: "anytime tryscorer",
        markets: ["player_try_scorer_anytime"],
      };
    }

    if (lowerMessage.includes("try")) {
      return {
        label: "tryscorer",
        markets: ["player_try_scorer_anytime", "player_try_scorer_first", "player_try_scorer_last", "player_try_scorer_over"],
      };
    }
  }

  if (lowerMessage.includes("handicap") || lowerMessage.includes("line") || lowerMessage.includes("spread")) {
    return {
      label: "handicap",
      markets: ["spreads"],
    };
  }

  if (lowerMessage.includes("total") || lowerMessage.includes("over under") || lowerMessage.includes("over/under")) {
    return {
      label: "totals",
      markets: ["totals"],
    };
  }

  return null;
}

function getUserIntent(message, requestedMarket) {
  const lowerMessage = String(message || "").toLowerCase();

  if (requestedMarket) {
    return "event_markets";
  }

  const asksForGames =
    lowerMessage.includes("what games") ||
    lowerMessage.includes("which games") ||
    lowerMessage.includes("games can you see") ||
    lowerMessage.includes("odds for right now") ||
    lowerMessage.includes("odds for this week") ||
    lowerMessage.includes("available games") ||
    lowerMessage.includes("upcoming games") ||
    lowerMessage.includes("what about the week after") ||
    lowerMessage.includes("week after this week") ||
    (lowerMessage.includes("give me") && lowerMessage.includes("odds")) ||
    (lowerMessage.includes("show me") && lowerMessage.includes("odds")) ||
    (lowerMessage.includes("what are") && lowerMessage.includes("odds"));

  const asksForMulti =
    lowerMessage.includes("multi") ||
    lowerMessage.includes("leg") ||
    lowerMessage.includes("legs") ||
    lowerMessage.includes("build") ||
    lowerMessage.includes("selection") ||
    lowerMessage.includes("example bet");

  const asksForRisk =
    lowerMessage.includes("risk") ||
    lowerMessage.includes("safer") ||
    lowerMessage.includes("confidence");

  if (asksForGames && !asksForMulti && !asksForRisk) return "available_games";
  if (asksForMulti) return "multi";
  if (asksForRisk) return "risk";

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

  const filtered = events.filter((event) => {
    const homeTeam = String(event.homeTeam || "").toLowerCase();
    const awayTeam = String(event.awayTeam || "").toLowerCase();

    return homeTeam.includes(teamLower) || awayTeam.includes(teamLower);
  });

  return filtered.length ? filtered : [];
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

  if (normalisedMessage.includes(home)) score += 5;
  if (normalisedMessage.includes(away)) score += 5;

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

  if (scored[0]?.score > 0) {
    return scored[0].event;
  }

  return null;
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

    player_try_scorer_anytime: "Anytime tryscorer markets",
    player_try_scorer_first: "First tryscorer markets",
    player_try_scorer_last: "Last tryscorer markets",
    player_try_scorer_over: "Tries over markets",

    h2h: "Head-to-head markets",
    spreads: "Handicap / line markets",
    totals: "Total markets",
  };

  return labels[marketKey] || `${requestedMarketLabel} markets`;
}

function formatOutcomeLine(outcome, marketKey, bookmakerTitle) {
  const player = outcome.description || outcome.name || "Selection";
  const price = outcome.price ? ` at **$${outcome.price}**` : "";
  const point =
    outcome.point !== null && outcome.point !== undefined
      ? ` **${outcome.point}**`
      : "";

  if (marketKey.includes("_most")) {
    return `- **${player}** to record the most${price} (${bookmakerTitle})`;
  }

  if (marketKey.includes("_over") || outcome.name === "Over") {
    return `- **${player}** over${point}${price} (${bookmakerTitle})`;
  }

  if (marketKey.includes("first")) {
    return `- **${player}** first scorer${price} (${bookmakerTitle})`;
  }

  if (marketKey.includes("last")) {
    return `- **${player}** last scorer${price} (${bookmakerTitle})`;
  }

  if (marketKey.includes("anytime")) {
    return `- **${player}** anytime scorer${price} (${bookmakerTitle})`;
  }

  if (outcome.point !== null && outcome.point !== undefined) {
    return `- **${player}** ${outcome.name} **${outcome.point}**${price} (${bookmakerTitle})`;
  }

  if (outcome.name === "Yes") {
    return `- **${player}** yes${price} (${bookmakerTitle})`;
  }

  return `- **${player}** ${outcome.name ? `- ${outcome.name}` : ""}${price} (${bookmakerTitle})`;
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

        if (groupedLines[groupLabel].length >= 8) break;
      }
    }
  }

  const groupEntries = Object.entries(groupedLines)
    .filter(([, lines]) => lines.length)
    .map(([label, lines]) => `**${label}:**\n\n${lines.slice(0, 8).join("\n")}`);

  if (!groupEntries.length) {
    return `No **${requestedMarket.label}** markets were returned for this event right now.`;
  }

  return `**${event.homeTeam} vs ${event.awayTeam}**

${groupEntries.join("\n\n")}`;
}

function buildDirectOddsReply({ sport, detectedTeam, dateWindow, oddsContext }) {
  const dateLabel = dateWindow?.label || "upcoming games";
  const targetLabel = detectedTeam?.team ? `**${detectedTeam.team}**` : `**${sport}**`;

  const summary =
    oddsContext?.summary ||
    `No odds were returned for ${targetLabel} for **${dateLabel}**.`;

  const hasNoOdds =
    summary.toLowerCase().includes("no odds were returned") ||
    summary.toLowerCase().includes("no upcoming odds were returned") ||
    summary.toLowerCase().includes("could not be loaded");

  const importantMessage = hasNoOdds
    ? "Odds may not be available that far ahead yet. Check again closer to the game dates. This is informational only, not betting advice."
    : "Odds can change leading up to the games. These are sample odds from available bookmaker data. This is informational only, not betting advice. Always check the latest odds, team news and player availability before making any decisions.";

  return `Available games:

${summary}

Important:

${importantMessage}`;
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

  const hasNoMarkets =
    !eventMarketContext?.available ||
    eventMarketContext.summary.toLowerCase().includes("no ") ||
    eventMarketContext.summary.toLowerCase().includes("could not be loaded");

  const importantMessage = hasNoMarkets
    ? "These markets may not be available for this game yet, or they may not be included by the bookmaker/API right now. Check again closer to the game. This is informational only, not betting advice."
    : "These are market lines only. Historical averages, hit rates, injuries and team news are not connected yet. This is informational only, not betting advice.";

  return `Available games:

Available **${requestedMarket.label}** markets for **${matchedEvent.homeTeam} vs ${matchedEvent.awayTeam}**:

${eventMarketContext?.summary || `No **${requestedMarket.label}** markets were returned for this game.`}

Important:

${importantMessage}`;
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
  const mode = context?.mode || "Not specified";
  const legs = context?.legs || "Not specified";
  const targetOdds = context?.targetOdds || "Not specified";
  const riskProfile = context?.riskProfile || "Not specified";
  const optionalRequest = context?.request || "None";

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

Current Edge settings:
- Mode: ${mode}
- Sport: ${sport}
- Number of legs: ${legs}
- Target odds: ${targetOdds}
- Risk profile: ${riskProfile}
- Optional request: ${optionalRequest}

Available odds context:
${oddsContext?.summary || "No odds context available."}

Respond as Edge.

Important:
- Keep the answer short, simple, and user-friendly.
- Use real odds context if it is relevant to the user request.
- Only discuss the requested sport or league: ${sport}.
- Only discuss the requested date window: ${dateWindow?.label || "upcoming games"}.
- If a detected team exists, focus on that team where possible.
- Do not show odds from a different sport, league, or date window.
- If no odds are returned for the requested date window, say that clearly.
- Do not explain formulas or odds calculations unless asked.
- Do not use Markdown headings.
- Use **bold** markers for important player names, team names, markets, stats, odds, disposals, goals, hit rates, and risk scores.
- Do not invent player stats, injuries, lineups, odds, or player data.
- If the user asks for a multi, give a placeholder example structure unless the required real market/player data is available.
- Do not use real player names unless the user gives you the data.
- Make clear that this is informational analysis only, not betting advice.

For multi intent, use this structure when useful:

Simple view:

Example structure:

What I would check:

Risk level:

Important:
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