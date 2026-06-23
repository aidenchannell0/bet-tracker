// LAB PROBE #2 — WHY are the multis losing? Decompose every logged leg into
// cleared / missed-the-line / DID-NOT-PLAY (DNP). If a big share of failures are
// DNPs (injured, late out, rested), the fix is lineup data, not a better model.
//
// Run: node lab/probe-dnp.mjs

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

const AFL = ["kicks","marks","handballs","disposals","goals","behinds","hitouts","tackles","clearances","fantasy_points"];
const NBA = { points:"pts", rebounds:"reb", assists:"ast", threes:"fg3m", blocks:"blk", steals:"stl" };
const colOf = (metric) => NBA[metric] ? { sport:"nba", col:NBA[metric] } : { sport:"afl", col:metric };

async function loadAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order("game_date",{ascending:true}).range(from, from+999);
    if (error) { console.error(table, error.message); break; }
    if (!data?.length) break; out.push(...data); if (data.length < 1000) break;
  }
  return out;
}

const { data: multis } = await sb.from("grid_build_multis").select("created_at,sport,legs,combined_odds,predicted_prob").order("created_at",{ascending:true}).limit(5000);
if (!multis?.length) { console.log("no multis logged"); process.exit(0); }

const aflGames = await loadAll("afl_player_games", `name_key,game_date,${AFL.join(",")}`);
const nbaGames = await loadAll("nba_player_games", "name_key,game_date,pts,reb,ast,fg3m,stl,blk");
const byKey = { afl: new Map(), nba: new Map() };
for (const r of aflGames) (byKey.afl.get(r.name_key) || byKey.afl.set(r.name_key, []).get(r.name_key)).push(r);
for (const r of nbaGames) (byKey.nba.get(r.name_key) || byKey.nba.set(r.name_key, []).get(r.name_key)).push(r);

function resolveLeg(leg, afterDate) {
  if (!leg?.name_key || !leg?.metric || leg.line == null) return "unknown";
  const { sport, col } = colOf(leg.metric);
  const games = byKey[sport].get(leg.name_key) || [];
  const g = games.find((x) => x.game_date >= afterDate && x[col] != null);
  if (!g) return "dnp";                                   // no game on/after = didn't play
  return Number(g[col]) >= Number(leg.line) ? "clear" : "under";
}

let legClear=0, legUnder=0, legDnp=0, legUnknown=0;
let mWon=0, mLostUnderOnly=0, mLostHadDnp=0, mPending=0, mTotal=0;
const cal = [ {lo:0.5,hi:0.8,n:0,c:0}, {lo:0.8,hi:0.9,n:0,c:0}, {lo:0.9,hi:0.95,n:0,c:0}, {lo:0.95,hi:1.01,n:0,c:0} ];
for (const m of multis) {
  const outs = (m.legs || []).map((l) => resolveLeg(l, String(m.created_at).slice(0,10)));
  (m.legs || []).forEach((l, i) => {
    const o = outs[i], pb = l.predicted_prob;
    if (pb == null || o === "unknown") return;
    const b = cal.find((x) => pb >= x.lo && pb < x.hi); if (!b) return;
    b.n++; if (o === "clear") b.c++;
  });
  for (const o of outs) { if(o==="clear")legClear++; else if(o==="under")legUnder++; else if(o==="dnp")legDnp++; else legUnknown++; }
  if (outs.includes("unknown")) continue;
  mTotal++;
  const hasDnp = outs.includes("dnp"), hasUnder = outs.includes("under");
  if (!hasDnp && !hasUnder && !outs.includes("unknown")) mWon++;       // all cleared
  else if (hasDnp) mLostHadDnp++;                                      // a non-player killed it
  else if (hasUnder) mLostUnderOnly++;                                 // genuine form miss only
}

const legTot = legClear+legUnder+legDnp;
const failTot = legUnder+legDnp;
const p = (n,d)=> d? (100*n/d).toFixed(1)+"%" : "—";
console.log(`multis analysed: ${multis.length} | resolvable legs: ${legTot}`);
console.log(`\n=== LEG OUTCOMES ===`);
console.log(`  cleared:    ${legClear}  (${p(legClear,legTot)})`);
console.log(`  missed:     ${legUnder}  (${p(legUnder,legTot)})`);
console.log(`  DID NOT PLAY:${legDnp}  (${p(legDnp,legTot)})`);
console.log(`\n=== OF THE FAILURES (${failTot}) ===`);
console.log(`  missed the line: ${p(legUnder,failTot)}`);
console.log(`  didn't play:     ${p(legDnp,failTot)}  <- lineup data would catch these`);
console.log(`\n=== MULTI OUTCOMES (settled, n=${mWon+mLostUnderOnly+mLostHadDnp}) ===`);
console.log(`  won (all cleared):        ${mWon}`);
console.log(`  lost, had a DNP leg:      ${mLostHadDnp}  <- savable / restructurable with lineups`);
console.log(`  lost, genuine form miss:  ${mLostUnderOnly}`);
console.log(`\n=== CALIBRATION: model's predicted % vs actual clear % ===`);
for (const b of cal) if (b.n) console.log(`  rated ${Math.round(b.lo*100)}-${Math.round(b.hi*100)}%:  actually cleared ${(100*b.c/b.n).toFixed(0)}%   (n=${b.n})`);
