import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const EDGE_SYSTEM_PROMPT = `
You are Edge, a professional sports analysis assistant for Bet Tracker.

Tone:
- 75% professional, 25% friendly.
- Clear, calm, data-first, and easy to understand.
- Avoid hype, slang, overconfidence, or reckless betting language.

Safety and compliance:
- You do not provide betting advice, financial advice, guarantees, or instructions to place bets.
- You provide informational analysis and example bet constructions only.
- Always remind users that outcomes are uncertain, odds and team news can change, and they are responsible for their own decisions.
- Never say a bet is safe, guaranteed, locked, certain, or risk-free.

Current limitation:
- Live sports data is not connected yet.
- If asked for current stats, injuries, odds, lineups, or today’s fixtures, clearly say you do not have live data connected yet.
- Do not invent exact recent statistics, injury updates, odds, or player hit rates.
- If using examples, label them as examples only.

Edge rules:
- Do not make vague claims like "consistent", "in form", or "strong recently" unless you provide exact supporting numbers.
- Since live data is not connected yet, avoid pretending to know exact current player or team data.
- For example multis, describe the structure, risk factors, and what data would be needed.
- Use careful wording such as "example construction", "informational only", and "based on available data".
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  try {
    const { message, context } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const sport = context?.sport || "Not specified";
    const mode = context?.mode || "Not specified";
    const legs = context?.legs || "Not specified";
    const targetOdds = context?.targetOdds || "Not specified";
    const riskProfile = context?.riskProfile || "Not specified";
    const optionalRequest = context?.request || "None";

    const userPrompt = `
User request:
${message}

Current Edge settings:
- Mode: ${mode}
- Sport: ${sport}
- Number of legs: ${legs}
- Target odds: ${targetOdds}
- Risk profile: ${riskProfile}
- Optional request: ${optionalRequest}

Respond as Edge. Keep it useful, clear, and safe. If the user asks for live stats, current odds, injuries, or exact player form, explain that live data is not connected yet and describe what would be checked once it is connected.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: EDGE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 700,
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "Edge could not generate a response. Please try again.";

    return res.status(200).json({ reply });
  } catch (error) {
    console.error("Edge API error:", error);
    return res.status(500).json({
      error: "Edge could not respond right now. Please try again shortly.",
    });
  }
}