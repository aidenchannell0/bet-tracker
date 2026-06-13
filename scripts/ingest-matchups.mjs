// Weekly AFL role / positional matchup intel for MultiPick.
//
// For each game in the upcoming round it asks an OpenAI model (with the hosted
// web_search tool) to read REAL preview / team-news articles and extract ONLY
// explicit, sourced statements about taggers, role/position changes and defensive
// matchups that move a player's expected disposals / marks / goals / tackles.
// Results are upserted into Supabase `afl_matchup_notes`, round-stamped.
//
// Guardrails (a betting tool — accuracy over coverage):
//   - Grounded: the model summarises fetched articles, not its memory.
//   - Cited: every note must carry a real source_url, ENFORCED here in code —
//     any note without an http(s) source is dropped, regardless of the prompt.
//   - Never invent: an empty result is correct and expected.
//
// Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
// Run:  node scripts/ingest-matchups.mjs            (writes to Supabase)
//       node scripts/ingest-matchups.mjs --dry      (prints notes, writes nothing)
//       node scripts/ingest-matchups.mjs --round 14 (force a round)

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const DRY = process.argv.includes("--dry");
const roundArgIdx = process.argv.indexOf("--round");
const ROUND_OVERRIDE = roundArgIdx >= 0 ? parseInt(process.argv[roundArgIdx + 1], 10) : null;

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!DRY && (!supabaseUrl || !supabaseServiceKey)) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const supabase = !DRY ? createClient(supabaseUrl, supabaseServiceKey) : null;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Same normaliser as scripts/scrape-afl-stats.mjs + api/edge.js so notes match
// players: "Patrick Dangerfield" -> "p_dangerfield".
function nameKey(full) {
  const words = String(full || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  return `${words[0][0]}_${words[words.length - 1]}`;
}

// Upcoming round's fixture from the free Squiggle API (requires a User-Agent).
async function getNextRoundGames(season) {
  const res = await fetch(`https://api.squiggle.com.au/?q=games;year=${season}`, {
    headers: { "User-Agent": "Pickd matchup-intel (pickd.tech)" },
  });
  if (!res.ok) throw new Error(`Squiggle ${res.status}`);
  const data = await res.json();
  const all = Array.isArray(data.games) ? data.games : [];
  const upcoming = all.filter((g) => Number(g.complete) < 100 && g.hteam && g.ateam);
  if (!upcoming.length) return { round: null, games: [] };
  const round = ROUND_OVERRIDE ?? Math.min(...upcoming.map((g) => Number(g.round)));
  const games = upcoming
    .filter((g) => Number(g.round) === round)
    .map((g) => ({ home: g.hteam, away: g.ateam }));
  return { round, games };
}

const VALID_METRIC = new Set(["disposals", "marks", "goals", "tackles", "general"]);
const VALID_DIR = new Set(["up", "down", "neutral"]);

function buildPrompt(game, round, season) {
  return `You are researching AFL Round ${round} (${season}) for player-prop betting intel for this game ONLY: ${game.home} vs ${game.away}.

Run SEVERAL targeted web searches (not just one). Search for:
- "${game.home} vs ${game.away} round ${round} preview" and the named / selected teams
- "${game.home} tagger" and "${game.away} tagger" — who is tagging whom this week
- the run-with matchup on each side's key midfielders (e.g. "who will tag <that team's gun mid>")

Prefer trusted sources where role and tagger intel actually lives: afl.com.au, the official club sites, sen.com.au, espn.com.au/afl, dfsaustralia.com, footywire.com, theroar.com.au. Do NOT rely on fan-forum speculation (e.g. BigFooty) unless it quotes an official selection or coach.

Extract ONLY statements in these categories that change a player's expected disposals / marks / goals / tackles:
1. MATCHUP (HIGHEST PRIORITY) — a run-with tagger, or who is tasked to negate or guard whom. Set "player" to the player whose prop is affected (the one being tagged / guarded) and name the opponent in the summary. e.g. "Bedford to tag Wanganeen-Milera".
2. AVAILABILITY — a player confirmed OUT, or coming IN / returning, where it affects who plays or shifts roles.
3. ROLE / POSITION — a role or position change (e.g. a midfielder shifted forward or to defence).
4. MINUTES / MANAGEMENT — a returning player eased back or on a minutes/role restriction (expect reduced output).
5. USAGE SHIFT — a teammate's absence that lifts or lowers another player's expected usage.

DO NOT include (noise or already known):
- recent form, last-game stat lines, or season tallies (e.g. "had 30 disposals last week")
- milestones, games-played counts, contract or award news
- generic squad-list additions with no role or usage implication
- coach quotes with no concrete role/availability detail

STRICT RULES (this is a betting tool — accuracy matters far more than coverage):
- Only include a note if a real article you actually retrieved EXPLICITLY states it. Do NOT infer, guess, speculate, or use prior knowledge.
- Every note MUST include the exact source_url of the article it came from.
- If nothing concrete and sourced fits the categories above, return {"notes":[]}. An empty result is correct and expected.
- Keep each "summary" to one short factual line.

Return ONLY raw JSON (no markdown fences), exactly this shape:
{"notes":[{"player":"<full name>","team":"<team>","metric":"disposals|marks|goals|tackles|general","direction":"down|up|neutral","summary":"<one factual line>","source_url":"https://...","confidence":"high|medium|low"}]}`;
}

async function extractForGame(game, round, season) {
  let text = "";
  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      // Hosted grounding tool. If your account errors on "web_search", switch the
      // type to "web_search_preview" (older alias) — same behaviour.
      tools: [{ type: "web_search" }],
      input: buildPrompt(game, round, season),
    });
    text = (resp.output_text || "").trim();
  } catch (err) {
    console.error(`  ! OpenAI error for ${game.home} v ${game.away}: ${err.message}`);
    return [];
  }

  // Tolerate stray code fences / prose around the JSON.
  const jsonStr = (text.match(/\{[\s\S]*\}/) || [text])[0];
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error(`  ! Unparseable JSON for ${game.home} v ${game.away}`);
    return [];
  }

  const raw = Array.isArray(parsed?.notes) ? parsed.notes : [];
  // CODE-LEVEL GROUNDING GUARD: drop anything without a player, a summary, or a
  // real http(s) source. The prompt asks for this; we enforce it regardless.
  const clean = [];
  for (const n of raw) {
    if (!n || !n.player || !n.summary) continue;
    if (!/^https?:\/\/\S+/.test(String(n.source_url || ""))) continue;
    const metric = VALID_METRIC.has(n.metric) ? n.metric : "general";
    const direction = VALID_DIR.has(n.direction) ? n.direction : "neutral";
    clean.push({
      season,
      round,
      game: `${game.home} vs ${game.away}`,
      player_name: String(n.player).trim(),
      name_key: nameKey(n.player),
      team: n.team ? String(n.team).trim() : null,
      metric,
      direction,
      summary: String(n.summary).trim().slice(0, 300),
      source_url: String(n.source_url).trim(),
      confidence: ["high", "medium", "low"].includes(n.confidence) ? n.confidence : "low",
    });
  }
  return clean.filter((r) => r.name_key);
}

async function main() {
  const season = new Date().getFullYear();
  const { round, games } = await getNextRoundGames(season);
  if (!round || !games.length) {
    console.log("No upcoming games found — nothing to do.");
    return;
  }
  console.log(`Round ${round} (${season}) — ${games.length} games. ${DRY ? "[DRY RUN]" : ""}`);

  let all = [];
  for (const game of games) {
    console.log(`• ${game.home} v ${game.away}`);
    const notes = await extractForGame(game, round, season);
    console.log(`    ${notes.length} sourced note(s)`);
    all = all.concat(notes);
  }

  if (!all.length) {
    console.log("No sourced matchup notes this round.");
    return;
  }

  if (DRY) {
    console.log("\n--- notes that WOULD be stored ---");
    for (const n of all) {
      console.log(`  ${n.player_name} (${n.team || "?"}) ${n.metric} ${n.direction} — ${n.summary}\n      ↳ ${n.source_url} [${n.confidence}]`);
    }
    return;
  }

  const { error } = await supabase
    .from("afl_matchup_notes")
    .upsert(all, { onConflict: "season,round,name_key,summary" });
  if (error) {
    console.error("Upsert failed:", error.message);
    process.exit(1);
  }
  console.log(`Stored ${all.length} note(s) for round ${round}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
