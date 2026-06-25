// HONESTY GATE for the candidate adjustments. For every AFL mid-game, compute the
// RESIDUAL = actual disposals − recency-weighted form (the part form MISSES), then
// test whether each factor predicts that residual out-of-sample. r≈0 ⇒ the factor
// adds nothing beyond form; |r|>~0.15 ⇒ worth keeping. Walk-forward / train-test.
//
// Run: node lab/probe-adjustments.mjs

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
  const { data, error } = await sb.from("afl_player_games").select("player_name,team,game_code,game_date,disposals").order("game_date", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  if (!data?.length) break; rows.push(...data); if (data.length < 1000) break;
}

const gameTeams = new Map();
for (const r of rows) { if (!gameTeams.has(r.game_code)) gameTeams.set(r.game_code, new Set()); gameTeams.get(r.game_code).add(r.team); }
const oppOf = (gc, team) => { const ts = [...(gameTeams.get(gc) || [])]; return ts.length === 2 ? ts.find((t) => t !== team) : null; };

const byPlayer = new Map();
for (const r of rows) {
  if (!byPlayer.has(r.player_name)) byPlayer.set(r.player_name, []);
  byPlayer.get(r.player_name).push({ date: r.game_date, di: Number(r.disposals) || 0, opp: oppOf(r.game_code, r.team) });
}
for (const a of byPlayer.values()) a.sort((x, y) => (x.date < y.date ? -1 : 1));
const rw = (arr) => { let w = 1, sw = 0, ss = 0; for (let i = arr.length - 1; i >= 0; i--) { ss += arr[i] * w; sw += w; w *= 0.9; } return sw ? ss / sw : null; };

// residuals for every mid-game (≥6 prior)
const recs = [];
for (const [player, gs] of byPlayer) {
  for (let i = 6; i < gs.length; i++) {
    const prior = gs.slice(Math.max(0, i - 10), i);
    const base = rw(prior.map((p) => p.di)); if (base == null) continue;
    const l3 = prior.slice(-3).reduce((a, p) => a + p.di, 0) / Math.min(3, prior.length);
    recs.push({ player, date: gs[i].date, opp: gs[i].opp, base, residual: gs[i].di - base, formDelta: l3 - base });
  }
}
recs.sort((a, b) => (a.date < b.date ? -1 : 1));
const cut = recs[Math.floor(recs.length * 0.7)].date;
const train = recs.filter((r) => r.date < cut), test = recs.filter((r) => r.date >= cut);

// team matchup = opponent's mean residual in TRAIN
const oppAgg = new Map();
for (const r of train) { if (!r.opp) continue; const a = oppAgg.get(r.opp) || { n: 0, s: 0 }; a.n++; a.s += r.residual; oppAgg.set(r.opp, a); }
const teamMF = (opp) => { const a = oppAgg.get(opp); return a && a.n >= 20 ? a.s / a.n : null; };

// H2H = this player's mean residual vs this opp, from prior meetings
const pair = new Map();
for (const r of recs) { if (!r.opp) continue; const k = `${r.player}|${r.opp}`; if (!pair.has(k)) pair.set(k, []); pair.get(k).push({ date: r.date, residual: r.residual }); }
const h2h = (player, opp, date) => { const arr = (pair.get(`${player}|${opp}`) || []).filter((x) => x.date < date); return arr.length >= 2 ? arr.reduce((a, x) => a + x.residual, 0) / arr.length : null; };

const pearson = (pairs) => { const n = pairs.length; if (n < 10) return null; const mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n; let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };

const fd = [], tm = [], hh = [];
for (const r of test) {
  if (r.base < 15) continue; // disposal mids
  fd.push([r.formDelta, r.residual]);
  const t = teamMF(r.opp); if (t != null) tm.push([t, r.residual]);
  const h = h2h(r.player, r.opp, r.date); if (h != null) hh.push([h, r.residual]);
}
const f = (x) => (x == null ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(3));
console.log(`test mid-games: ${fd.length}  (residual = actual − recency-weighted form)\n`);
console.log("=== does each factor predict what recent form MISSES? ===");
console.log(`  form delta      r = ${f(pearson(fd))}   (n=${fd.length})`);
console.log(`  team matchup    r = ${f(pearson(tm))}   (n=${tm.length})`);
console.log(`  H2H (player)    r = ${f(pearson(hh))}   (n=${hh.length})  ← of ${fd.length} mid-games, only this many even had ≥2 prior meetings`);
console.log("\n(r≈0 = adds nothing beyond form;  |r|>~0.15 = worth keeping)");
