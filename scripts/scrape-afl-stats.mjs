// Scrapes AFL player game-by-game stats from afltables.com and upserts them into
// the Supabase `afl_player_games` table. Designed to run on a schedule from a
// GitHub Action (gentle pace, retries, long timeouts) — NOT per web request.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Run: node scripts/scrape-afl-stats.mjs

import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

const AFLTABLES_BASE = "https://afltables.com/afl";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36";

// Column indices in afltables match-page player rows:
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

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(
    "Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } catch (error) {
    if (attempt < 3) {
      await sleep(4000 * attempt);
      return fetchText(url, attempt + 1);
    }
    throw error;
  }
}

function flipName(raw) {
  const parts = String(raw || "").split(",");
  if (parts.length === 2) return `${parts[1].trim()} ${parts[0].trim()}`;
  return String(raw || "").trim();
}

function nameKey(full) {
  const words = String(full || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  const last = words[words.length - 1];
  return `${words[0][0]}_${last}`;
}

async function getSeasonGames(year) {
  const html = await fetchText(`${AFLTABLES_BASE}/seas/${year}.html`);
  const $ = cheerio.load(html);
  const games = [];
  $("a").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (!/stats\/games\/\d{4}\/\d+\.html/.test(href)) return;
    const code = (href.match(/(\d+)\.html$/) || [])[1];
    if (!code) return;
    games.push({ url: href.replace(/^\.\.\//, `${AFLTABLES_BASE}/`), code });
  });
  return games;
}

function parseMatchPlayers(html, gameCode, season) {
  const $ = cheerio.load(html);
  const rows = [];
  const dateStr = gameCode.slice(-8); // YYYYMMDD
  const gameDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;

  $("table").each((_, table) => {
    const title = $(table).find("tr").first().text();
    if (!title.includes("Match Statistics")) return;
    const team = title.split("Match Statistics")[0].trim();

    $(table)
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 20) return;
        const raw = $(cells[1]).text().trim();
        if (!/^[A-Za-z .'-]+,\s*[A-Za-z .'-]+$/.test(raw)) return;

        const num = (i) => {
          const v = parseInt($(cells[i]).text().trim(), 10);
          return isNaN(v) ? 0 : v;
        };
        const s = {};
        for (const [metric, idx] of Object.entries(COL)) s[metric] = num(idx);

        const fantasy =
          s.kicks * 3 +
          s.handballs * 2 +
          s.marks * 3 +
          s.tackles * 4 +
          s.goals * 6 +
          s.behinds * 1 +
          s.hitouts * 1 +
          s.free_for * 1 -
          s.free_against * 3;

        const playerName = flipName(raw);
        rows.push({
          game_code: gameCode,
          game_date: gameDate,
          season,
          player_name: playerName,
          name_key: nameKey(playerName),
          team,
          kicks: s.kicks,
          marks: s.marks,
          handballs: s.handballs,
          disposals: s.disposals,
          goals: s.goals,
          behinds: s.behinds,
          hitouts: s.hitouts,
          tackles: s.tackles,
          clearances: s.clearances,
          fantasy_points: fantasy,
        });
      });
  });
  return rows;
}

async function main() {
  const currentYear = new Date().getFullYear();
  const seasons = [currentYear, currentYear - 1]; // current + previous for hit-rate depth

  // Skip games we already have. Paginate, because Supabase caps a single select
  // (default 1000 rows) — without this the scraper re-fetches every game each run.
  const have = new Set();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("afl_player_games")
      .select("game_code")
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("Could not read existing games:", error.message);
      process.exit(1);
    }
    for (const row of data || []) have.add(row.game_code);
    if (!data || data.length < pageSize) break;
  }
  console.log(`Already have ${have.size} games stored.`);

  let newGames = 0;
  let newRows = 0;

  for (const season of seasons) {
    let games = [];
    try {
      games = await getSeasonGames(season);
    } catch (error) {
      console.error(`Season ${season} index failed:`, error.message);
      continue;
    }
    console.log(`Season ${season}: ${games.length} completed games on afltables.`);

    for (const game of games) {
      if (have.has(game.code)) continue;
      await sleep(1000); // gentle on afltables (~1 request/sec)

      let html;
      try {
        html = await fetchText(game.url);
      } catch (error) {
        console.error(`Game ${game.code} fetch failed:`, error.message);
        continue;
      }

      const rows = parseMatchPlayers(html, game.code, season);
      if (!rows.length) continue;

      const { error } = await supabase
        .from("afl_player_games")
        .upsert(rows, { onConflict: "game_code,player_name" });
      if (error) {
        console.error(`Upsert ${game.code} failed:`, error.message);
        continue;
      }

      have.add(game.code);
      newGames += 1;
      newRows += rows.length;
      console.log(`  + ${game.code} -> ${rows.length} players`);
    }
  }

  console.log(`Done. Added ${newGames} new games, ${newRows} player rows.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
