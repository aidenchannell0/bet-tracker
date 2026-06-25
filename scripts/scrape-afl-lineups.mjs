// Scrapes confirmed AFL team selections from footywire and upserts them into
// afl_lineups. Runs round-by-round (teams drop progressively Thu–Sun), so a given
// run captures whichever teams are named so far. Player names are matched to our
// canonical name_key set both ways (last-word vs rest-joined) to survive hyphenated
// surnames. Powers the sponge factor + "drop un-named players" + late-mail read.
//
// Run: node scripts/scrape-afl-lineups.mjs   (reads .env)

import { readFileSync } from "node:fs";
try { // local dev reads .env; CI (GitHub Actions) injects these as secrets instead
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
    let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
} catch { /* no .env file — rely on process.env */ }
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const UA = "Mozilla/5.0 (Pickd lineup scraper; aidenchannell0@gmail.com)";

// 1) canonical name_keys (so footywire names map to our stats)
const canon = new Set(); const nameByKey = new Map();
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("afl_player_games").select("name_key,player_name").range(from, from + 999);
  if (error) { console.error("canon load:", error.message); break; }
  if (!data?.length) break;
  for (const r of data) { canon.add(r.name_key); if (!nameByKey.has(r.name_key)) nameByKey.set(r.name_key, r.player_name); }
  if (data.length < 1000) break;
}

// 2) footywire team selections
const res = await fetch("https://www.footywire.com/afl/footy/afl_team_selections", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
const html = await res.text();
const round = Number((html.match(/Round (\d+)/) || [])[1]) || null;
const season = new Date().getFullYear();
if (!round) { console.error("could not read round from page"); process.exit(1); }

// 3) parse pp-<club>--<name>; match name_key both ways for hyphenated surnames
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const rows = [], unmatched = [], seen = new Set();
for (const m of html.matchAll(/pp-([a-z0-9-]+--[a-z0-9-]+)/g)) {
  const parts = m[1].split("--"); const club = parts[0];
  const words = parts.slice(1).join("--").split("-").filter(Boolean);
  if (words.length < 2) continue;
  const dedupe = `${club}|${words.join("-")}`; if (seen.has(dedupe)) continue; seen.add(dedupe);
  const display = words.map(cap).join(" ");
  const keyA = `${words[0][0]}_${words[words.length - 1]}`;   // first initial + last word
  const keyB = `${words[0][0]}_${words.slice(1).join("")}`;   // first initial + rest joined (hyphenated surnames)
  const name_key = canon.has(keyA) ? keyA : canon.has(keyB) ? keyB : null;
  if (!name_key) { unmatched.push(display); continue; }
  rows.push({ season, round, name_key, player_name: nameByKey.get(name_key) || display, club, status: "named" });
}

// 4) summary + upsert
const clubs = [...new Set(rows.map((r) => r.club))];
console.log(`Round ${round} ${season} | matched ${rows.length} players, unmatched ${unmatched.length}`);
console.log(`clubs named so far (${clubs.length}): ${clubs.join(", ")}`);
if (unmatched.length) console.log(`unmatched (review): ${unmatched.join(", ")}`);
try {
  const { error } = await sb.from("afl_lineups").upsert(rows, { onConflict: "season,round,name_key" });
  if (error) throw error;
  console.log(`upserted ${rows.length} lineup rows ✅`);
} catch (e) {
  console.log(`\nupsert skipped — ${e.message}\n→ create the table first (db/afl_lineups.sql), then re-run.`);
}
