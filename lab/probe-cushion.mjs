// Does CUSHION DEPTH predict clearing beyond the flat haircut? For every logged
// AFL leg, compute how far the player's recent average sat above the line in std
// units (cushionZ) from games BEFORE the multi, then bucket the actual clear rate.
// If deep-cushion legs clear ~90% while thin ones clear ~70%, real near-locks
// deserve higher honest confidence and genuine high-chance multis are possible.
//
// Run: node lab/probe-cushion.mjs

import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const AFL = ["kicks","marks","handballs","disposals","goals","behinds","hitouts","tackles","clearances","fantasy_points"];
const AFL_SET = new Set(AFL);

async function loadAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order("game_date",{ascending:true}).range(from, from+999);
    if (error) { console.error(table, error.message); break; }
    if (!data?.length) break; out.push(...data); if (data.length < 1000) break;
  }
  return out;
}
const { data: multis } = await sb.from("grid_build_multis").select("created_at,legs").order("created_at",{ascending:true}).limit(5000);
const games = await loadAll("afl_player_games", `name_key,game_date,${AFL.join(",")}`);
const byKey = new Map();
for (const r of games) (byKey.get(r.name_key) || byKey.set(r.name_key, []).get(r.name_key)).push(r);

// cushionZ buckets + a raw-margin (disposals only) cross-check
const zb = [ {lo:-9,hi:1,n:0,c:0}, {lo:1,hi:1.5,n:0,c:0}, {lo:1.5,hi:2,n:0,c:0}, {lo:2,hi:2.5,n:0,c:0}, {lo:2.5,hi:99,n:0,c:0} ];
let used = 0;
for (const mu of multis || []) {
  const after = String(mu.created_at).slice(0,10);
  for (const leg of mu.legs || []) {
    if (!leg?.name_key || !AFL_SET.has(leg.metric) || leg.line == null) continue;
    const g = byKey.get(leg.name_key) || [];
    const prior = g.filter((x) => x.game_date < after && x[leg.metric] != null).slice(-10).map((x) => Number(x[leg.metric]));
    const res = g.find((x) => x.game_date >= after && x[leg.metric] != null);
    if (prior.length < 4 || !res) continue;
    const avg = prior.reduce((a,b)=>a+b,0)/prior.length;
    const sd = Math.sqrt(prior.reduce((a,b)=>a+(b-avg)**2,0)/prior.length) || 0.5;
    const z = (avg - Number(leg.line)) / sd;            // how many std the avg sits above the line
    const clear = Number(res[leg.metric]) >= Number(leg.line) ? 1 : 0;
    const b = zb.find((x) => z >= x.lo && z < x.hi); if (!b) continue;
    b.n++; b.c += clear; used++;
  }
}
console.log(`resolved ${used} AFL legs with cushion + outcome\n`);
console.log("=== ACTUAL clear rate by cushion depth (recent avg above the line, in std) ===");
for (const b of zb) if (b.n) {
  const lbl = b.lo === -9 ? "< 1.0" : b.hi === 99 ? `>= ${b.lo.toFixed(1)}` : `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`;
  console.log(`  cushion ${lbl.padEnd(8)} std:  cleared ${(100*b.c/b.n).toFixed(0)}%   (n=${b.n})`);
}
console.log(`\n(flat haircut currently assigns ~77-79% to ALL of these regardless of cushion)`);
