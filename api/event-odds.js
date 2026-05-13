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

const DEFAULT_MARKETS_BY_SPORT = {
  AFL: [
    "h2h",
    "spreads",
    "totals",
    "outrights",
    "player_disposals",
    "player_disposals_over",
    "player_goals",
    "player_goals_over",
    "player_tackles",
    "player_tackles_over",
    "player_marks",
    "player_marks_over",
    "player_clearances",
    "player_clearances_over",
    "player_fantasy_points",
    "player_fantasy_points_over",
    "player_first_goal_scorer",
    "player_last_goal_scorer",
  ],
  NRL: [
    "h2h",
    "spreads",
    "totals",
    "outrights",
    "player_anytime_try_scorer",
    "player_first_try_scorer",
    "player_last_try_scorer",
    "player_tries",
    "player_tries_over",
  ],
  NBA: [
    "h2h",
    "spreads",
    "totals",
    "player_points",
    "player_points_over",
    "player_rebounds",
    "player_rebounds_over",
    "player_assists",
    "player_assists_over",
    "player_threes",
    "player_threes_over",
  ],
  NFL: [
    "h2h",
    "spreads",
    "totals",
    "player_pass_yds",
    "player_rush_yds",
    "player_reception_yds",
    "player_anytime_td",
  ],
};

function getSportKey(sport) {
  return SPORT_KEY_MAP[sport] || SPORT_KEY_MAP.AFL;
}

function getSafeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getDefaultMarkets(sport) {
  return DEFAULT_MARKETS_BY_SPORT[sport] || ["h2h", "spreads", "totals"];
}

function simplifyEventOdds(event) {
  return {
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
          description: outcome.description ?? null,
          price: outcome.price,
          point: outcome.point ?? null,
        })),
      })),
    })),
  };
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
    const eventId = getSafeString(req.query.eventId, "");

    if (!eventId) {
      return res.status(400).json({
        error: "Missing eventId. Use /api/odds first to get an event ID.",
      });
    }

    const sportKey = getSportKey(sport);
    const regions = getSafeString(req.query.regions, "au");
    const oddsFormat = getSafeString(req.query.oddsFormat, "decimal");
    const dateFormat = getSafeString(req.query.dateFormat, "iso");

    const requestedMarkets = getSafeString(
      req.query.markets,
      getDefaultMarkets(sport).join(",")
    );

    const url = new URL(
      `${ODDS_API_BASE_URL}/sports/${sportKey}/events/${eventId}/odds`
    );

    url.searchParams.set("apiKey", process.env.ODDS_API_KEY);
    url.searchParams.set("regions", regions);
    url.searchParams.set("markets", requestedMarkets);
    url.searchParams.set("oddsFormat", oddsFormat);
    url.searchParams.set("dateFormat", dateFormat);

    const response = await fetch(url.toString());

    const requestsRemaining = response.headers.get("x-requests-remaining");
    const requestsUsed = response.headers.get("x-requests-used");
    const requestsLast = response.headers.get("x-requests-last");

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.message || "Could not fetch event odds.",
        status: response.status,
        sport,
        sportKey,
        eventId,
        markets: requestedMarkets,
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
      eventId,
      regions,
      markets: requestedMarkets,
      oddsFormat,
      event: simplifyEventOdds(data),
      quota: {
        requestsRemaining,
        requestsUsed,
        requestsLast,
      },
    });
  } catch (error) {
    console.error("Event odds API error:", error);

    return res.status(500).json({
      error: "Could not fetch event odds right now. Please try again shortly.",
    });
  }
}