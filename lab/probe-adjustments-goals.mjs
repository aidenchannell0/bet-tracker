// HONESTY GATE on GOALS for team matchup + game total — the markets where these
// SHOULD matter (defences genuinely concede goals; high-scoring games = more goals).
// residual = actual goals − recency-weighted form. Restricted to goal threats
// (base ≥ 0.7). Game total has no stored pre-game line, so proxy = both teams'
// recent goals-scored rate. Walk-forward / train-test.
//
// Run: node lab/probe-adjustments-goals.mjs

import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("afl_player_games").select("player_name,team,game_code,game_date,goals").order("game_date", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  if (!data?.length) break; rows.push(...data); if (data.length < 1000) break;
}

const gameTeams = new Map(), gameDate = new Map();
for (const r of rows) { if (!gameTeams.has(r.game_code)) gameTeams.set(r.game_code, new Set()); gameTeams.get(r.game_code).add(r.team); gameDate.set(r.game_code, r.game_date); }
const oppOf = (gc, team) => { const ts = [...(gameTeams.get(gc) || [])]; return ts.length === 2 ? ts.find((t) => t !== team) : null; };
const rw = (arr) => { let w = 1, sw = 0, ss = 0; for (let i = arr.length - 1; i >= 0; i--) { ss += arr[i] * w; sw += w; w *= 0.9; } return sw ? ss / sw : null; };

// team goals scored per game -> team GF series
const tgg = new Map();
for (const r of rows) { const k = `${r.game_code}|${r.team}`; tgg.set(k, (tgg.get(k) || 0) + (Number(r.goals) || 0)); }
const teamGF = new Map();
for (const [k, gf] of tgg) { const [gc, team] = k.split("|"); if (!teamGF.has(team)) teamGF.set(team, []); teamGF.get(team).push({ date: gameDate.get(gc), gf }); }
for (const a of teamGF.values()) a.sort((x, y) => (x.date < y.date ? -1 : 1));
const gfRecent = (team, beforeDate) => { const a = (teamGF.get(team) || []).filter((x) => x.date < beforeDate).slice(-6); return a.length >= 3 ? rw(a.map((x) => x.gf)) : null; };

// per-player goal series
const byPlayer = new Map();
for (const r of rows) { if (!byPlayer.has(r.player_name)) byPlayer.set(r.player_name, []); byPlayer.get(r.player_name).push({ date: r.game_date, g: Number(r.goals) || 0, opp: oppOf(r.game_code, r.team), team: r.team }); }
for (const a of byPlayer.values()) a.sort((x, y) => (x.date < y.date ? -1 : 1));

const recs = [];
for (const [player, gs] of byPlayer) {
  for (let i = 6; i < gs.length; i++) {
    const prior = gs.slice(Math.max(0, i - 10), i);
    const base = rw(prior.map((p) => p.g)); if (base == null) continue;
    recs.push({ player, date: gs[i].date, opp: gs[i].opp, team: gs[i].team, base, residual: gs[i].g - base });
  }
}
recs.sort((a, b) => (a.date < b.date ? -1 : 1));
const cut = recs[Math.floor(recs.length * 0.7)].date;
const train = recs.filter((r) => r.date < cut), test = recs.filter((r) => r.date >= cut);

const oppAgg = new Map();
for (const r of train) { if (!r.opp) continue; const a = oppAgg.get(r.opp) || { n: 0, s: 0 }; a.n++; a.s += r.residual; oppAgg.set(r.opp, a); }
const teamMF = (opp) => { const a = oppAgg.get(opp); return a && a.n >= 15 ? a.s / a.n : null; };

const pearson = (pairs) => { const n = pairs.length; if (n < 10) return null; const mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n; let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };

const tm = [], gt = [];
for (const r of test) {
  if (r.base < 0.7) continue; // goal threats only
  const t = teamMF(r.opp); if (t != null) tm.push([t, r.residual]);
  const g1 = gfRecent(r.team, r.date), g2 = gfRecent(r.opp, r.date);
  if (g1 != null && g2 != null) gt.push([g1 + g2, r.residual]);
}
const f = (x) => (x == null ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(3));
console.log(`test goal-threat games: ${Math.max(tm.length, gt.length)}  (residual = actual goals − recency-weighted form)\n`);
console.log("=== GOALS: does each factor predict what form misses? ===");
console.log(`  team matchup    r = ${f(pearson(tm))}   (n=${tm.length})`);
console.log(`  game total      r = ${f(pearson(gt))}   (n=${gt.length})  [proxy = both teams' recent goals-scored]`);
console.log("\n(compare to disposals, where team matchup was only +0.11;  |r|>~0.15 = worth keeping)");
