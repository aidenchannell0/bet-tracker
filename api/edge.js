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
- Do not use bold markers like **text**.
- Never put the whole answer in one paragraph.
- Use blank lines between each section.
- Keep most responses under 260 words.
- Prioritise clarity over detail.
- Use this exact structure with blank lines between each section when useful:

Simple view:

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

function buildBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return `${protocol}://${host}`;
}

function getSafeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getPrimaryMarketOdds(event) {
  const bookmaker = event.bookmakers?.[0];
  const market = bookmaker?.markets?.find((item) => item.key === "h2h") || bookmaker?.markets?.[0];

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

function summariseOddsForEdge(oddsData) {
  const events = oddsData?.events || [];

  if (!events.length) {
    return "No upcoming odds were returned for this sport right now.";
  }

  return events
    .slice(0, 5)
    .map((event, index) => {
      const market = getPrimaryMarketOdds(event);
      const teams = `${event.homeTeam || "Home team"} vs ${event.awayTeam || "Away team"}`;

      if (!market) {
        return `${index + 1}. ${teams}\nNo clear head-to-head odds returned.`;
      }

      const prices = market.outcomes
        .map((outcome) => `${outcome.name}: $${outcome.price}`)
        .join(", ");

      return `${index + 1}. ${teams}\nBookmaker sample: ${market.bookmaker}\nOdds: ${prices}`;
    })
    .join("\n\n");
}

async function fetchOddsContext(req, sport) {
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
        summary: `Odds data could not be loaded right now. Error: ${data?.error || "Unknown error"}`,
      };
    }

    return {
      available: true,
      summary: summariseOddsForEdge(data),
      quota: data.quota,
    };
  } catch (error) {
    console.error("Edge odds context error:", error);

    return {
      available: false,
      summary: "Odds data could not be loaded right now.",
    };
  }
}

function buildUserPrompt({ message, context, oddsContext }) {
  const sport = context?.sport || "Not specified";
  const mode = context?.mode || "Not specified";
  const legs = context?.legs || "Not specified";
  const targetOdds = context?.targetOdds || "Not specified";
  const riskProfile = context?.riskProfile || "Not specified";
  const optionalRequest = context?.request || "None";

  return `
User request:
${message}

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
- Do not explain formulas or odds calculations unless asked.
- Do not use Markdown headings or bold formatting.
- Do not invent player stats, injuries, lineups, odds, or player data.
- If the user asks for a multi, give a placeholder example structure unless the required real market/player data is available.
- Do not use real player names unless the user gives you the data.
- Use this exact structure with blank lines between each section when it fits the request:

Simple view:

Example structure:

What I would check:

Risk level:

Important:

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

    const sport = getSafeString(context?.sport, "AFL");
    const oddsContext = await fetchOddsContext(req, sport);

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: EDGE_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildUserPrompt({ message, context, oddsContext }),
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