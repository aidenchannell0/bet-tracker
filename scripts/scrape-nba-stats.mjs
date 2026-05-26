// Scrapes NBA player game-by-game stats from balldontlie.io into the Supabase
// `nba_player_games` table. balldontlie isn't IP-blocked, so this can run from
// a Vercel cron or GitHub Action — no Mac uptime dependency like the AFL job.
//
// Env: SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
//      BALLDONTLIE_API_KEY (free key from balldontlie.io)
// Optional: NBA_DAYS (default 30), BALLDONTLIE_GAP_MS (default 13000ms — paces
//          requests under the free-tier 5/min limit; set lower on paid plans)
//
// Run: node scripts/scrape-nba-stats.mjs

import { createClient } from "@supabase/supabase-js";

const BD_BASE = "https://api.balldontlie.io/v1";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const balldontlieKey = process.env.BALLDONTLIE_API_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!balldontlieKey) {
  console.error("Missing BALLDONTLIE_API_KEY (sign up free at balldontlie.io)");
  process.exit(1);
}

const DAYS = Number(process.env.NBA_DAYS || 30);
const GAP_MS = Number(process.env.BALLDONTLIE_GAP_MS || 13000);
const supabase = createClient(supabaseUrl, supabaseServiceKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nameKey(first, last) {
  const f = String(first || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  const l = String(last || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!f || !l) return "";
  return `${f[0]}_${l}`;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function recentDates(days) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    out.push(isoDate(d));
  }
  return out;
}

// Manual query-string build so `dates[]` brackets stay un-encoded (balldontlie
// expects `dates[]=YYYY-MM-DD&dates[]=...` syntax).
function buildUrl(path, params) {
  const qs = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach((item) => qs.push(`${k}=${encodeURIComponent(item)}`));
    else if (v != null) qs.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return `${BD_BASE}${path}${qs.length ? "?" + qs.join("&") : ""}`;
}

async function bdFetch(path, params = {}, attempt = 1) {
  const url = buildUrl(path, params);
  try {
    const res = await fetch(url, {
      headers: { Authorization: balldontlieKey },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429 && attempt <= 4) {
      const wait = 15000 * attempt;
      console.log(`  429 rate-limited, waiting ${wait}ms`);
      await sleep(wait);
      return bdFetch(path, params, attempt + 1);
    }
    if (!res.ok) throw new Error(`balldontlie HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  } catch (error) {
    if (attempt <= 3) {
      await sleep(4000 * attempt);
      return bdFetch(path, params, attempt + 1);
    }
    throw error;
  }
}

function statRow(stat) {
  const player = stat.player || {};
  const team = stat.team || {};
  const game = stat.game || {};
  const date = String(game.date || "").slice(0, 10);
  const name = `${player.first_name || ""} ${player.last_name || ""}`.trim();
  return {
    game_id: game.id || null,
    player_id: player.id || null,
    game_date: date || null,
    season: Number(game.season) || (date ? Number(date.slice(0, 4)) : new Date().getUTCFullYear()),
    player_name: name,
    name_key: nameKey(player.first_name, player.last_name),
    team: team.full_name || team.name || null,
    pts: Number(stat.pts) || 0,
    reb: Number(stat.reb) || 0,
    ast: Number(stat.ast) || 0,
    fg3m: Number(stat.fg3m) || 0,
    stl: Number(stat.stl) || 0,
    blk: Number(stat.blk) || 0,
    min: stat.min || null,
  };
}

function isValidRow(r) {
  return r.game_id && r.player_id && r.game_date && r.name_key;
}

async function fetchStatsForDates(dates) {
  const out = [];
  let cursor;
  let pageNum = 0;
  while (true) {
    pageNum += 1;
    const params = { "dates[]": dates, per_page: 100 };
    if (cursor) params.cursor = cursor;
    const json = await bdFetch("/stats", params);
    const rows = (json.data || [])
      .filter((s) => s.min && s.min !== "0:00") // skip DNPs
      .map(statRow)
      .filter(isValidRow);
    out.push(...rows);
    cursor = json.meta?.next_cursor;
    console.log(`  page ${pageNum}: ${rows.length} rows${cursor ? " · more" : ""}`);
    if (!cursor) break;
    await sleep(GAP_MS);
  }
  return out;
}

async function main() {
  console.log(`[${new Date().toISOString()}] NBA scrape: last ${DAYS} days`);
  const dates = recentDates(DAYS);
  const CHUNK = 15; // keep the dates[] list short for safety
  let total = 0;
  for (let i = 0; i < dates.length; i += CHUNK) {
    const slice = dates.slice(i, i + CHUNK);
    console.log(`Fetching stats for ${slice[slice.length - 1]} .. ${slice[0]}`);
    const rows = await fetchStatsForDates(slice);
    if (!rows.length) {
      await sleep(GAP_MS);
      continue;
    }
    for (let j = 0; j < rows.length; j += 500) {
      const batch = rows.slice(j, j + 500);
      const { error } = await supabase
        .from("nba_player_games")
        .upsert(batch, { onConflict: "game_id,player_id" });
      if (error) {
        console.error("Upsert error:", error.message);
      } else {
        total += batch.length;
      }
    }
    await sleep(GAP_MS);
  }
  console.log(`Done. Upserted ${total} NBA stat rows.`);
}

main().catch((err) => {
  console.error("NBA scrape failed:", err);
  process.exit(1);
});
