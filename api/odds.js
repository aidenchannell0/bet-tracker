const ODDS_API_BASE_URL = "https://api.the-odds-api.com/v4";

const SPORT_KEY_MAP = {
  AFL: "aussierules_afl",
  NRL: "rugbyleague_nrl",

  EPL: "soccer_epl",
  ChampionsLeague: "soccer_uefa_champs_league",
  Soccer: "soccer_australia_aleague",

  NBA: "basketball_nba",
  Basketball: "basketball_nba",

  NFL: "americanfootball_nfl",
  MLB: "baseball_mlb",
  NHL: "icehockey_nhl",

  Cricket: "cricket_test_match",
  UFC: "mma_mixed_martial_arts",
  Tennis: "tennis_atp",
};

function getSportKey(sport) {
  return SPORT_KEY_MAP[sport] || SPORT_KEY_MAP.AFL;
}

function getSafeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function simplifyOddsData(events) {
  return (events || []).map((event) => ({
    id: event.id,
    sportKey: event.sport_key,
    sportTitle: event.sport_title,
    commenceTime: event.commence_time,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    bookmakers: (event.bookmakers || []).map((bookmaker) => ({
      key: bookmaker.key,
      title: bookmaker.title,
      lastUpdate: bookmaker.last_update,
      markets: (bookmaker.markets || []).map((market) => ({
        key: market.key,
        lastUpdate: market.last_update,
        outcomes: (market.outcomes || []).map((outcome) => ({
          name: outcome.name,
          price: outcome.price,
          point: outcome.point ?? null,
        })),
      })),
    })),
  }));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  if (!process.env.ODDS_API_KEY) {
    return res.status(500).json({
      error: "Missing ODDS_API_KEY",
    });
  }

  try {
    const sport = getSafeString(req.query.sport, "AFL");
    const sportKey = getSportKey(sport);

    const regions = getSafeString(req.query.regions, "au");
    const markets = getSafeString(req.query.markets, "h2h");
    const oddsFormat = getSafeString(req.query.oddsFormat, "decimal");
    const dateFormat = getSafeString(req.query.dateFormat, "iso");

    const commenceTimeFrom = req.query.commenceTimeFrom;
    const commenceTimeTo = req.query.commenceTimeTo;

    const url = new URL(`${ODDS_API_BASE_URL}/sports/${sportKey}/odds`);
    url.searchParams.set("apiKey", process.env.ODDS_API_KEY);
    url.searchParams.set("regions", regions);
    url.searchParams.set("markets", markets);
    url.searchParams.set("oddsFormat", oddsFormat);
    url.searchParams.set("dateFormat", dateFormat);

    if (commenceTimeFrom) {
      url.searchParams.set("commenceTimeFrom", commenceTimeFrom);
    }

    if (commenceTimeTo) {
      url.searchParams.set("commenceTimeTo", commenceTimeTo);
    }

    const response = await fetch(url.toString());

    const requestsRemaining = response.headers.get("x-requests-remaining");
    const requestsUsed = response.headers.get("x-requests-used");
    const requestsLast = response.headers.get("x-requests-last");

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.message || "Could not fetch odds.",
        status: response.status,
        quota: {
          requestsRemaining,
          requestsUsed,
          requestsLast,
        },
      });
    }

    return res.status(200).json({
      sport,
      sportKey,
      regions,
      markets,
      oddsFormat,
      commenceTimeFrom: commenceTimeFrom || null,
      commenceTimeTo: commenceTimeTo || null,
      events: simplifyOddsData(data),
      quota: {
        requestsRemaining,
        requestsUsed,
        requestsLast,
      },
    });
  } catch (error) {
    console.error("Odds API error:", error);

    return res.status(500).json({
      error: "Could not fetch odds right now. Please try again shortly.",
    });
  }
}