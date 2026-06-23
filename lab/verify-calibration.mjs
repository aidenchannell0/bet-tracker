// LAB VERIFY — does the winner's-curse haircut make the model honest?
// Re-scores every logged AFL leg with the new selectionBiasAdjust and compares
// predicted-vs-actual BEFORE (stored) and AFTER (haircut), at leg + multi level.
//
// Run: node lab/verify-calibration.mjs

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

// --- mirror of the new edge.js logic ---
const AFL = ["kicks","marks","handballs","disposals","goals","behinds","hitouts","tackles","clearances","fantasy_points"];
const AFL_SET = new Set(AFL);
const NBA = { points:"pts", rebounds:"reb", assists:"ast", threes:"fg3m", blocks:"blk", steals:"stl" };
const colOf = (metric) => NBA[metric] ? { sport:"nba", col:NBA[metric] } : { sport:"afl", col:metric };
const KNEE = 0.72, CEIL = 0.80, SLOPE = (CEIL - KNEE) / (1 - KNEE);
function selectionBiasAdjust(p, metric) {
  if (p == null || !AFL_SET.has(metric)) return p;
  if (p <= KNEE) return p;
  return KNEE + (p - KNEE) * SLOPE;
}

async function loadAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order("game_date",{ascending:true}).range(from, from+999);
    if (error) { console.error(table, error.message); break; }
    if (!data?.length) break; out.push(...data); if (data.length < 1000) break;
  }
  return out;
}
const { data: multis } = await sb.from("grid_build_multis").select("created_at,sport,legs").order("created_at",{ascending:true}).limit(5000);
const aflGames = await loadAll("afl_player_games", `name_key,game_date,${AFL.join(",")}`);
const nbaGames = await loadAll("nba_player_games", "name_key,game_date,pts,reb,ast,fg3m,stl,blk");
const byKey = { afl:new Map(), nba:new Map() };
for (const r of aflGames) (byKey.afl.get(r.name_key) || byKey.afl.set(r.name_key,[]).get(r.name_key)).push(r);
for (const r of nbaGames) (byKey.nba.get(r.name_key) || byKey.nba.set(r.name_key,[]).get(r.name_key)).push(r);
function resolveLeg(leg, after) {
  const { sport, col } = colOf(leg.metric);
  const g = (byKey[sport].get(leg.name_key) || []).find((x) => x.game_date >= after && x[col] != null);
  if (!g) return null;
  return Number(g[col]) >= Number(leg.line) ? 1 : 0;
}

const buckets = () => [ {lo:0.5,hi:0.8,n:0,c:0,ps:0}, {lo:0.8,hi:0.9,n:0,c:0,ps:0}, {lo:0.9,hi:0.95,n:0,c:0,ps:0}, {lo:0.95,hi:1.01,n:0,c:0,ps:0} ];
const calOld = buckets(), calNew = buckets();
let mN=0, mWon=0, sumOldComb=0, sumNewComb=0;
for (const m of multis) {
  const after = String(m.created_at).slice(0,10);
  let oldComb=1, newComb=1, anyMiss=false, anyUnres=false, ok=true;
  for (const leg of m.legs || []) {
    if (leg?.predicted_prob == null || !leg.name_key || !leg.metric || leg.line == null) { ok=false; break; }
    const r = resolveLeg(leg, after);
    const oldP = leg.predicted_prob, newP = selectionBiasAdjust(oldP, leg.metric);
    oldComb *= oldP; newComb *= newP;
    if (r === null) anyUnres = true; else if (r === 0) anyMiss = true;
    if (r !== null) {
      for (const [cal,pp] of [[calOld,oldP],[calNew,newP]]) {
        const b = cal.find((x)=> pp>=x.lo && pp<x.hi); if (b){ b.n++; b.ps+=pp; if(r===1)b.c++; }
      }
    }
  }
  if (!ok) continue;
  const status = anyMiss ? "lost" : anyUnres ? "pending" : "won";
  if (status !== "pending") { mN++; if (status==="won") mWon++; sumOldComb+=oldComb; sumNewComb+=newComb; }
}
const row = (b)=> `rated ${Math.round(b.lo*100)}-${Math.round(b.hi*100)}%: predicts ${(100*b.ps/b.n).toFixed(0)}% → actual ${(100*b.c/b.n).toFixed(0)}%  (n=${b.n})`;
console.log("=== LEG CALIBRATION: BEFORE (stored) ===");
for (const b of calOld) if (b.n) console.log("  "+row(b));
console.log("\n=== LEG CALIBRATION: AFTER (winner's-curse haircut) ===");
for (const b of calNew) if (b.n) console.log("  "+row(b));
console.log(`\n=== MULTI level (settled n=${mN}, actual win ${(100*mWon/mN).toFixed(0)}%) ===`);
console.log(`  avg predicted (BEFORE, leg-product): ${(100*sumOldComb/mN).toFixed(0)}%`);
console.log(`  avg predicted (AFTER,  leg-product): ${(100*sumNewComb/mN).toFixed(0)}%`);
console.log(`  reality:                              ${(100*mWon/mN).toFixed(0)}%`);
