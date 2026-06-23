// LAB BACKTEST #1 — does base + sponge beat base (form) alone at predicting disposals?
//
// base   = recency-weighted avg of the player's PRIOR games (walk-forward, no leakage)
// sponge = per-player coefficient learned from TRAIN only (2025), shrunk toward the
//          league effect by sample size, applied when a core teammate is OUT this game.
// Train = season 2025, Test = season 2026. Metric = MAE / RMSE on test, overall and on
// the teammate-out subset (where sponge is supposed to matter).
//
// Note: backtest uses the actual lineup (who played) as a stand-in for "the lineup we'd
// have if we ingested team announcements" — so this measures the model's ceiling and tells
// us whether building the lineup feed is worth it.
//
// Run: node lab/backtest-projection.mjs

import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("afl_player_games")
    .select("game_code,game_date,season,team,name_key,player_name,disposals")
    .order("game_date", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}

// index per team + per player's ordered game list
const teams = new Map();
const playerSeq = new Map(); // name_key -> [{gc,date,disp,team}] ordered by date
for (const r of rows) {
  if (!r.team || !r.game_code) continue;
  const t = teams.get(r.team) || teams.set(r.team, { players: new Map() }).get(r.team);
  const p = t.players.get(r.name_key) || t.players.set(r.name_key, new Map()).get(r.name_key);
  p.set(r.game_code, Number(r.disposals) || 0);
  const seq = playerSeq.get(r.name_key) || playerSeq.set(r.name_key, []).get(r.name_key);
  seq.push({ gc: r.game_code, date: r.game_date, disp: Number(r.disposals) || 0, team: r.team });
}
for (const s of playerSeq.values()) s.sort((a, b) => (a.date < b.date ? -1 : 1));

// core mids per team (top 6 by avg, >=5 games)
const coreOf = new Map(); // team -> Set(name_key)
for (const [team, t] of teams) {
  const ranked = [...t.players.entries()]
    .map(([k, g]) => ({ k, avg: [...g.values()].reduce((a, b) => a + b, 0) / g.size, n: g.size }))
    .filter((p) => p.n >= 5).sort((a, b) => b.avg - a.avg).slice(0, 6);
  coreOf.set(team, new Set(ranked.map((r) => r.k)));
}
// outCount for a (team, name_key, game_code): core teammates with no row that game
function outCount(team, key, gc) {
  const core = coreOf.get(team); if (!core) return 0;
  const players = teams.get(team).players;
  let n = 0;
  for (const ck of core) { if (ck !== key && !players.get(ck)?.has(gc)) n++; }
  return n;
}

const TRAIN_SEASON = 2025;
const seasonOf = new Map(rows.map((r) => [r.game_code, r.season]));

// learn per-player sponge coeff from TRAIN (binary: any core teammate out)
let poolInN = 0, poolInSum = 0, poolOutN = 0, poolOutSum = 0;
const trainStats = new Map(); // key -> {inN,inSum,outN,outSum}
for (const [key, seq] of playerSeq) {
  for (const g of seq) {
    if (seasonOf.get(g.gc) !== TRAIN_SEASON) continue;
    if (!coreOf.get(g.team)?.has(key)) continue; // only core mids
    const oc = outCount(g.team, key, g.gc);
    const s = trainStats.get(key) || trainStats.set(key, { inN: 0, inSum: 0, outN: 0, outSum: 0 }).get(key);
    if (oc === 0) { s.inN++; s.inSum += g.disp; poolInN++; poolInSum += g.disp; }
    else { s.outN++; s.outSum += g.disp; poolOutN++; poolOutSum += g.disp; }
  }
}
const leagueDelta = poolOutN && poolInN ? poolOutSum / poolOutN - poolInSum / poolInN : 0;
const K = 8; // shrinkage strength
function spongeCoeff(key) {
  const s = trainStats.get(key);
  if (!s || s.inN < 2 || s.outN < 1) return leagueDelta; // thin -> league effect
  const playerDelta = s.outSum / s.outN - s.inSum / s.inN;
  return (s.outN * playerDelta + K * leagueDelta) / (s.outN + K);
}
function base(prior) {
  const r = prior.slice(-12);
  let w = 1, sw = 0, ss = 0;
  for (let i = r.length - 1; i >= 0; i--) { ss += r[i] * w; sw += w; w *= 0.88; }
  return sw ? ss / sw : null;
}

// TEST on 2026 core-mid games (walk-forward base, fixed train coeff)
// Three models compared:
//   base        — recency-weighted recent form only
//   sponge naive — base + coeff when ANY core teammate out (the first attempt)
//   sponge rel   — base + coeff × (this game's outs − the base period's avg outs)
//                  i.e. only adjust for how THIS lineup differs from recent games
let nAll = 0, maeBaseAll = 0, maeSpAll = 0, maeRelAll = 0;
let nOut = 0, maeBaseOut = 0, maeSpOut = 0, maeRelOut = 0;
for (const [key, seq] of playerSeq) {
  const priors = []; // {disp, oc}
  for (const g of seq) {
    const oc = outCount(g.team, key, g.gc);
    const train = seasonOf.get(g.gc) === TRAIN_SEASON;
    const isCore = coreOf.get(g.team)?.has(key);
    if (!train && isCore && priors.length >= 3) {
      const b = base(priors.map((p) => p.disp));
      if (b != null) {
        const recent = priors.slice(-12);
        const recentOut = recent.reduce((a, p) => a + p.oc, 0) / recent.length;
        const coeff = spongeCoeff(key);
        const predSp = b + (oc >= 1 ? coeff : 0);
        const predRel = b + coeff * (oc - recentOut);
        const eB = Math.abs(b - g.disp), eS = Math.abs(predSp - g.disp), eR = Math.abs(predRel - g.disp);
        nAll++; maeBaseAll += eB; maeSpAll += eS; maeRelAll += eR;
        if (oc >= 1) { nOut++; maeBaseOut += eB; maeSpOut += eS; maeRelOut += eR; }
      }
    }
    priors.push({ disp: g.disp, oc });
  }
}

const pct = (a, b) => `${b < a ? "improves " : "worse "}${(Math.abs((a - b) / a) * 100).toFixed(1)}%`;
console.log(`loaded ${rows.length} games | train ${TRAIN_SEASON} | league sponge Δ = +${leagueDelta.toFixed(2)} disposals`);
console.log(`\n=== TEST (2026 core-mid games), MAE on disposals (lower = better) ===`);
console.log(`ALL (n=${nAll}):`);
console.log(`  base only              ${(maeBaseAll / nAll).toFixed(2)}`);
console.log(`  base + sponge (naive)  ${(maeSpAll / nAll).toFixed(2)}   ${pct(maeBaseAll / nAll, maeSpAll / nAll)}`);
console.log(`  base + sponge (rel)    ${(maeRelAll / nAll).toFixed(2)}   ${pct(maeBaseAll / nAll, maeRelAll / nAll)}`);
console.log(`TEAMMATE-OUT only (n=${nOut}):`);
console.log(`  base only              ${(maeBaseOut / nOut).toFixed(2)}`);
console.log(`  base + sponge (naive)  ${(maeSpOut / nOut).toFixed(2)}   ${pct(maeBaseOut / nOut, maeSpOut / nOut)}`);
console.log(`  base + sponge (rel)    ${(maeRelOut / nOut).toFixed(2)}   ${pct(maeBaseOut / nOut, maeRelOut / nOut)}`);
