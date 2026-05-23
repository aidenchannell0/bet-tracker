import * as cheerio from "cheerio";

const AFLTABLES_BASE = "https://afltables.com/afl";
const UA = "Mozilla/5.0 (compatible; BetGrid/1.0; bettracker.tech informational tool)";

// The Odds API team name → AFL Tables canonical team name
const TEAM_NAME_MAP = {
  "Adelaide Crows": "Adelaide",
  "Brisbane Lions": "Brisbane Lions",
  "Carlton Blues": "Carlton",
  "Collingwood Magpies": "Collingwood",
  "Essendon Bombers": "Essendon",
  "Fremantle Dockers": "Fremantle",
  "Geelong Cats": "Geelong",
  "Gold Coast Suns": "Gold Coast",
  "GWS Giants": "Greater Western Sydney",
  "Hawthorn Hawks": "Hawthorn",
  "Melbourne Demons": "Melbourne",
  "North Melbourne Kangaroos": "North Melbourne",
  "Port Adelaide Power": "Port Adelaide",
  "Richmond Tigers": "Richmond",
  "St Kilda Saints": "St Kilda",
  "Sydney Swans": "Sydney",
  "West Coast Eagles": "West Coast",
  "Western Bulldogs": "Western Bulldogs",
};

const AFLTABLES_TEAMS = Object.values(TEAM_NAME_MAP);

// Column indices in the match-page player stat tables
// 0:# 1:Player 2:KI 3:MK 4:HB 5:DI 6:GL 7:BH 8:HO 9:TK 10:RB 11:IF 12:CL 13:CG 14:FF 15:FA
const COL = {
  kicks: 2,
  marks: 3,
  handballs: 4,
  disposals: 5,
  goals: 6,
  behinds: 7,
  hitouts: 8,
  tackles: 9,
  clearances: 12,
  free_for: 14,
  free_against: 15,
};

// Simple in-memory cache (persists across invocations on a warm instance)
const cache = new Map();
function getCached(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  return null;
}
function setCached(key, value) {
  cache.set(key, { at: Date.now(), value });
}

function toAfltablesTeam(name) {
  if (TEAM_NAME_MAP[name]) return TEAM_NAME_MAP[name];
  const lower = String(name || "").toLowerCase();
  // Contains-based fallback (e.g. "Sydney Swans" → "Sydney")
  for (const canonical of AFLTABLES_TEAMS) {
    if (lower.includes(canonical.toLowerCase()) || canonical.toLowerCase().includes(lower)) {
      return canonical;
    }
  }
  return name;
}

function flipName(raw) {
  const parts = String(raw || "").split(",");
  if (parts.length === 2) return `${parts[1].trim()} ${parts[0].trim()}`;
  return String(raw || "").trim();
}

function normaliseName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesPlayer(afltablesName, targetName) {
  const a = normaliseName(afltablesName);
  const b = normaliseName(targetName);
  if (a === b) return true;

  const aWords = a.split(" ").filter(Boolean);
  const bWords = b.split(" ").filter(Boolean);
  const aLast = aWords[aWords.length - 1];
  const bLast = bWords[bWords.length - 1];

  if (!aLast || !bLast || aLast !== bLast) return false;
  if (aWords[0] && bWords[0]) return aWords[0][0] === bWords[0][0];
  return true;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`AFL Tables ${response.status} for ${url}`);
  return response.text();
}

// Parse a season index into { teamA, teamB, url, date } games, most recent first
async function getSeasonGames(year) {
  const cacheKey = `season:${year}`;
  const cached = getCached(cacheKey, 6 * 60 * 60 * 1000);
  if (cached) return cached;

  let html;
  try {
    html = await fetchText(`${AFLTABLES_BASE}/seas/${year}.html`);
  } catch {
    return [];
  }

  const $ = cheerio.load(html);
  const games = [];

  $("a").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (!/stats\/games\/\d{4}\/\d+\.html/.test(href)) return;

    const table = $(a).closest("table");
    const teams = [];
    table.find("tr").each((__, tr) => {
      const first = $(tr).find("td").first().text().trim();
      if (first && /^[A-Z][a-zA-Z ]+$/.test(first) && first.length < 25) {
        teams.push(first);
      }
    });

    if (teams.length < 2) return;

    const dateMatch = href.match(/(\d{8})\.html$/);
    const date = dateMatch ? dateMatch[1] : "00000000";
    const url = href.replace(/^\.\.\//, `${AFLTABLES_BASE}/`);

    games.push({ teamA: teams[0], teamB: teams[1], url, date });
  });

  games.sort((a, b) => b.date.localeCompare(a.date));
  setCached(cacheKey, games);
  return games;
}

// Parse a match page into player stat lines
async function getMatchPlayers(url) {
  const cacheKey = `match:${url}`;
  const cached = getCached(cacheKey, 24 * 60 * 60 * 1000);
  if (cached) return cached;

  let html;
  try {
    html = await fetchText(url);
  } catch {
    return [];
  }

  const $ = cheerio.load(html);
  const players = [];

  $("table").each((_, table) => {
    const title = $(table).find("tr").first().text();
    if (!title.includes("Match Statistics")) return;

    $(table).find("tr").each((__, tr) => {
      const cells = $(tr).find("td");
      if (cells.length < 20) return;

      const rawName = $(cells[1]).text().trim();
      if (!/^[A-Za-z .'-]+,\s*[A-Za-z .'-]+$/.test(rawName)) return;

      const num = (i) => {
        const v = parseInt($(cells[i]).text().trim(), 10);
        return isNaN(v) ? 0 : v;
      };

      const stat = { name: flipName(rawName) };
      for (const [metric, idx] of Object.entries(COL)) {
        stat[metric] = num(idx);
      }
      // AFL Fantasy / DreamTeam score
      stat.fantasy_points =
        stat.kicks * 3 +
        stat.handballs * 2 +
        stat.marks * 3 +
        stat.tackles * 4 +
        stat.goals * 6 +
        stat.behinds * 1 +
        stat.hitouts * 1 +
        stat.free_for * 1 -
        stat.free_against * 3;

      players.push(stat);
    });
  });

  setCached(cacheKey, players);
  return players;
}

// Recent completed game URLs for a team (current year, supplemented by previous)
async function getRecentGameUrls(afltablesTeam, year, limit) {
  let games = (await getSeasonGames(year)).filter(
    (g) => g.teamA === afltablesTeam || g.teamB === afltablesTeam
  );

  if (games.length < limit) {
    const prev = (await getSeasonGames(year - 1)).filter(
      (g) => g.teamA === afltablesTeam || g.teamB === afltablesTeam
    );
    games = [...games, ...prev];
  }

  return games.slice(0, limit).map((g) => g.url);
}

function avg(arr) {
  if (!arr.length) return null;
  return Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { team1, team2, players: playersParam, metrics: metricsParam } = req.query;

    if (!team1 || !team2) {
      return res.status(400).json({ error: "team1 and team2 query params are required" });
    }

    const players = String(playersParam || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 30);

    const metrics = String(metricsParam || "disposals")
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m === "fantasy_points" || COL[m])
      .slice(0, 8);

    if (!players.length) {
      return res.status(400).json({ error: "At least one player name is required" });
    }
    if (!metrics.length) {
      return res.status(400).json({ error: "No valid metrics provided" });
    }

    const year = new Date().getFullYear();
    const aflTeam1 = toAfltablesTeam(team1);
    const aflTeam2 = toAfltablesTeam(team2);

    // Find recent game URLs for both teams (last 8 each), then dedupe
    const [urls1, urls2] = await Promise.all([
      getRecentGameUrls(aflTeam1, year, 8),
      getRecentGameUrls(aflTeam2, year, 8),
    ]);
    const matchUrls = [...new Set([...urls1, ...urls2])];

    if (!matchUrls.length) {
      return res.status(200).json({
        available: false,
        team1,
        team2,
        error: "No completed games found for these teams.",
        players: [],
        source: "AFL Tables (afltables.com)",
      });
    }

    // Fetch + parse all match pages in parallel (most recent first preserved per team)
    const matchResults = await Promise.allSettled(matchUrls.map((u) => getMatchPlayers(u)));
    const allMatches = matchResults
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);

    // For each requested player, collect game-by-game values per metric (most recent first)
    const playerSummaries = players.map((player) => {
      const metricsOut = {};

      for (const metric of metrics) {
        const values = [];
        for (const match of allMatches) {
          const found = match.find((p) => matchesPlayer(p.name, player));
          if (found && typeof found[metric] === "number") {
            values.push(found[metric]);
          }
        }

        if (!values.length) {
          metricsOut[metric] = { available: false };
          continue;
        }

        const last5 = values.slice(0, 5);
        const last10 = values.slice(0, 10);
        metricsOut[metric] = {
          available: true,
          gamesAnalysed: values.length,
          recentAvg: avg(last5),
          avg10: avg(last10),
          seasonAvg: avg(values),
          last5Values: last5,
          last10Values: last10,
        };
      }

      return { player, metrics: metricsOut };
    });

    return res.status(200).json({
      available: true,
      team1,
      team2,
      afltablesTeam1: aflTeam1,
      afltablesTeam2: aflTeam2,
      gamesAnalysed: matchUrls.length,
      year,
      players: playerSummaries,
      source: "AFL Tables (afltables.com)",
    });
  } catch (error) {
    console.error("AFL stats error:", error);
    return res.status(500).json({
      error: "Could not fetch AFL stats right now.",
      detail: error.message,
    });
  }
}
