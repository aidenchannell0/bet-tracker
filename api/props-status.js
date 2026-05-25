// Lightweight "have player props dropped?" check for the in-app notice.
// Player markets post close to game time; this lets the UI tell users when
// they're live. Checks only the soonest upcoming AFL game for a single market
// and caches the result for 30 min so page loads don't burn Odds API credits.

function buildBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  return `${protocol}://${req.headers.host}`;
}

let cache = { at: 0, payload: null };
const CACHE_MS = 1000 * 60 * 30;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (cache.payload && Date.now() - cache.at < CACHE_MS) {
      return res.status(200).json({ ...cache.payload, cached: true });
    }

    const base = buildBaseUrl(req);
    const oddsRes = await fetch(new URL("/api/odds?sport=AFL&markets=h2h", base).toString());
    const oddsData = await oddsRes.json();

    const now = Date.now();
    const upcoming = (oddsData.events || [])
      .filter((e) => !e.commenceTime || new Date(e.commenceTime).getTime() > now)
      .sort((a, b) => new Date(a.commenceTime || 0) - new Date(b.commenceTime || 0));

    if (!upcoming.length) {
      const payload = { available: true, propsAvailable: false, reason: "no_games" };
      cache = { at: now, payload };
      return res.status(200).json(payload);
    }

    const soonest = upcoming[0];
    const evRes = await fetch(
      new URL(
        `/api/event-odds?sport=AFL&eventId=${encodeURIComponent(soonest.id)}&markets=player_disposals_over`,
        base
      ).toString()
    );
    const evData = await evRes.json();
    const bookmakers = evData?.event?.bookmakers || [];
    const propsAvailable = bookmakers.some((b) =>
      (b.markets || []).some((m) => String(m.key || "").startsWith("player_") && (m.outcomes || []).length > 0)
    );

    const payload = {
      available: true,
      propsAvailable,
      // round key lets the client show the notice once per round (until dismissed)
      roundKey: String(soonest.commenceTime || soonest.id || "").slice(0, 10),
      game: `${soonest.homeTeam} vs ${soonest.awayTeam}`,
      gameId: soonest.id,
      commenceTime: soonest.commenceTime || null,
      reason: propsAvailable ? "live" : "not_posted_yet",
    };
    cache = { at: now, payload };
    return res.status(200).json(payload);
  } catch (error) {
    console.error("props-status error:", error);
    return res.status(200).json({ available: false });
  }
}
