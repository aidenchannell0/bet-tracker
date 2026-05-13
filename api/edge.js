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
- Live player statistics are not connected yet.
- Current injuries, team news, lineups and player form are not connected yet.
- Do not invent player stats, injuries, lineups, or player hit rates.
- If the user asks for player-market analysis, explain that odds are available but player stats still need to be connected.

Odds data rules:
- If odds data is provided, use it to mention real upcoming games and approximate available prices.
- Keep odds summaries simple.
- Do not list every bookmaker unless the user asks.
- Do not claim the best pick from odds alone.
- Do not say a team or market is value unless the user provides enough supporting data.
- Say that odds can change.
- If no odds are available for the requested sport or league, say that clearly.
- Do not show odds from another sport unless the user specifically asks.

Intent rules:
- If the user only asks what games or odds are available, only list the available games and sample odds. Do not build a multi.
- Only provide an example multi if the user asks for a multi, bet build, legs, selections, or example structure.
- Only provide a risk score if the user asks about risk, a multi, or a build.
- Only provide the full section structure when it fits the user request.
- Do not force every response into every section if the user asked a simple question.

Placeholder example rule:
- If the user asks for an example multi and player stats are not available, provide a generic placeholder structure.
- Use placeholders like Player A, Player B, Team A, Team B, Midfielder A, Forward B.
- Do not use real player names unless the user provides player data.
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

function detectTeamAlias(message) {
  const lowerMessage = String(message || "").toLowerCase();

  for (const entry of TEAM_ALIAS_MAP) {
    for (const alias of entry.aliases) {
      const aliasPattern = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

      if (aliasPattern.test(lowerMessage)) {
        return entry;
      }
    }
  }

  return null;
}

function getSportFromMessage(message, fallbackSport) {
  const lowerMessage = String(message || "").toLowerCase();
  const teamAlias = detectTeamAlias(message);

  if (teamAlias) {
    return teamAlias.sport;
  }

  if (lowerMessage.includes("nrl") || lowerMessage.includes("rugby league")) {
    return "NRL";
  }

  if (lowerMessage.includes("afl") || lowerMessage.includes("aussie rules")) {
    return "AFL";
  }

  if (
    lowerMessage.includes("epl") ||
    lowerMessage.includes("premier league") ||
    lowerMessage.includes("man city") ||
    lowerMessage.includes("manchester city")
  ) {
    return "EPL";
  }

  if (
    lowerMessage.includes("champions league") ||
    lowerMessage.includes("ucl")
  ) {
    return "ChampionsLeague";
  }

  if (
    lowerMessage.includes("nba") ||
    lowerMessage.includes("basketball")
  ) {
    return "NBA";
  }

  if (
    lowerMessage.includes("nfl") ||
    lowerMessage.includes("american football")
  ) {
    return "NFL";
  }

  if (
    lowerMessage.includes("mlb") ||
    lowerMessage.includes("baseball")
  ) {
    return "MLB";
  }

  if (
    lowerMessage.includes("nhl") ||
    lowerMessage.includes("ice hockey")
  ) {
    return "NHL";
  }

  if (
    lowerMessage.includes("soccer") ||
    lowerMessage.includes("football") ||
    lowerMessage.includes("a-league") ||
    lowerMessage.includes("aleague")
  ) {
    return "Soccer";
  }

  if (lowerMessage.includes("cricket")) {
    return "Cricket";
  }

  if (
    lowerMessage.includes("ufc") ||
    lowerMessage.includes("mma")
  ) {
    return "UFC";
  }

  if (lowerMessage.includes("tennis")) {
    return "Tennis";
  }

  return fallbackSport || "AFL";
}

function getUserIntent(message) {
  const lowerMessage = String(message || "").toLowerCase();

  const asksForGames =
    lowerMessage.includes("what games") ||
    lowerMessage.includes("which games") ||
    lowerMessage.includes("games can you see") ||
    lowerMessage.includes("odds for right now") ||
    lowerMessage.includes("odds for this week") ||
    lowerMessage.includes("available games") ||
    lowerMessage.includes("upcoming games") ||
    (lowerMessage.includes("give me") && lowerMessage.includes("odds")) ||
    (lowerMessage.includes("show me") && lowerMessage.includes("odds"));

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

  if (asksForGames && !asksForMulti && !asksForRisk) {
    return "available_games";
  }

  if (asksForMulti) {
    return "multi";
  }

  if (asksForRisk) {
    return "risk";
  }

  return "general";
}

function getPrimaryMarketOdds(event) {
  const bookmaker = event.bookmakers?.[0];
  const market =
    bookmaker?.markets?.find((item) => item.key === "h2h") ||
    bookmaker?.markets?.[0];

  if (!bookmaker || !market?.outcomes?.length) {
    return null;
  }

  return {
    bookmaker: bookmaker.title,
    outcomes: market.outcomes.map((outcome) => ({
      name: outcome.name,
      price: outcome.price,
    })),
  };
}

function filterEventsByDetectedTeam(events, detectedTeam) {
  if (!detectedTeam?.team) {
    return events;
  }

  const teamLower = detectedTeam.team.toLowerCase();

  const filtered = events.filter((event) => {
    const homeTeam = String(event.homeTeam || "").toLowerCase();
    const awayTeam = String(event.awayTeam || "").toLowerCase();

    return homeTeam.includes(teamLower) || awayTeam.includes(teamLower);
  });

  return filtered.length ? filtered : events;
}

function summariseOddsForEdge(oddsData, requestedSport, detectedTeam) {
  const allEvents = oddsData?.events || [];
  const events = filterEventsByDetectedTeam(allEvents, detectedTeam);

  if (!events.length) {
    if (detectedTeam?.team) {
      return `No upcoming odds were returned for **${detectedTeam.team}** in **${requestedSport}** right now.`;
    }

    return `No upcoming odds were returned for **${requestedSport}** right now.`;
  }

  return events
    .slice(0, 6)
    .map((event, index) => {
      const market = getPrimaryMarketOdds(event);
      const teams = `${event.homeTeam || "Home team"} vs ${
        event.awayTeam || "Away team"
      }`;

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

async function fetchOddsContext(req, sport, detectedTeam) {
  try {
    const baseUrl = buildBaseUrl(req);
    const url = new URL("/api/odds", baseUrl);

    url.searchParams.set("sport", sport || "AFL");
    url.searchParams.set("markets", "h2h");

    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok) {
      return {
        available: false,
        summary: `Odds data could not be loaded for **${sport}** right now. Error: ${
          data?.error || "Unknown error"
        }`,
      };
    }

    return {
      available: true,
      summary: summariseOddsForEdge(data, sport, detectedTeam),
      quota: data.quota,
    };
  } catch (error) {
    console.error("Edge odds context error:", error);

    return {
      available: false,
      summary: `Odds data could not be loaded for **${sport}** right now.`,
    };
  }
}

function buildUserPrompt({
  message,
  context,
  oddsContext,
  userIntent,
  sport,
  detectedTeam,
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
- If a detected team exists, focus on that team where possible.
- Do not show odds from a different sport or league.
- Do not explain formulas or odds calculations unless asked.
- Do not use Markdown headings.
- Use **bold** markers for important player names, team names, markets, stats, odds, disposals, goals, hit rates, and risk scores.
- Do not invent player stats, injuries, lineups, odds, or player data.
- If Detected user intent is "available_games", only list available games and simple sample odds. Do not create an example multi.
- If Detected user intent is "multi", you may give an example structure.
- If the user asks for a multi, give a placeholder example structure unless the required real market/player data is available.
- Do not use real player names unless the user gives you the data.
- Make clear that this is informational analysis only, not betting advice.

For available_games intent, use this structure:

Simple view:

Available games:

Important:

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

    const fallbackSport = getSafeString(context?.sport, "AFL");
    const detectedTeam = detectTeamAlias(message);
    const sport = getSportFromMessage(message, fallbackSport);
    const userIntent = getUserIntent(message);
    const oddsContext = await fetchOddsContext(req, sport, detectedTeam);

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