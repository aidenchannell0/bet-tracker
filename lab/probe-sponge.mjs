// LAB PROBE #1 — does the "sponge effect" exist in our data?
// MultiLab's killer input is the Sponge Coefficient: when a teammate is out, a
// player's usage (disposals) rises. Before we build a projection engine on that
// idea, prove it's real + measure it from afl_player_games.
//
// Method: per team, take the 6 highest-disposal players ("core mids"). For every
// game a core mid PLAYED, count how many of his core teammates were OUT (no row
// that game_code). Bucket his disposals by that count → dose-response. Pool
// league-wide, and surface the biggest individual "sponges".
//
// Run: node lab/probe-sponge.mjs   (reads .env for SUPABASE creds)

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

// Load all player-games (paginate past the 1000-row cap)
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("afl_player_games")
    .select("game_code,game_date,team,name_key,player_name,disposals")
    .order("game_date", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}
console.log(`loaded ${rows.length} player-games`);

// Index per team
const teams = new Map(); // team -> { games:Set, players:Map(key->{name, g:Map(gc->disp)}) }
for (const r of rows) {
  if (!r.team || !r.game_code) continue;
  const t = teams.get(r.team) || teams.set(r.team, { games: new Set(), players: new Map() }).get(r.team);
  t.games.add(r.game_code);
  const p = t.players.get(r.name_key) || t.players.set(r.name_key, { name: r.player_name, g: new Map() }).get(r.name_key);
  p.g.set(r.game_code, Number(r.disposals) || 0);
}

const buckets = new Map(); // outCount(0,1,2+) -> {n,sum}
const sponge = [];         // per-player: base vs teammate-out avg
for (const [team, t] of teams) {
  const players = [...t.players.values()]
    .map((p) => ({ ...p, avg: [...p.g.values()].reduce((a, b) => a + b, 0) / p.g.size, n: p.g.size }))
    .filter((p) => p.n >= 5);
  const core = players.sort((a, b) => b.avg - a.avg).slice(0, 6);
  for (const m of core) {
    let baseN = 0, baseSum = 0, outN = 0, outSum = 0;
    for (const [gc, disp] of m.g) {
      let outCount = 0;
      for (const c of core) { if (c !== m && !c.g.has(gc)) outCount++; }
      const b = Math.min(outCount, 2);
      const bk = buckets.get(b) || buckets.set(b, { n: 0, sum: 0 }).get(b);
      bk.n++; bk.sum += disp;
      if (outCount === 0) { baseN++; baseSum += disp; } else { outN++; outSum += disp; }
    }
    if (baseN >= 3 && outN >= 2) {
      sponge.push({ name: m.name, team, base: baseSum / baseN, out: outSum / outN, delta: outSum / outN - baseSum / baseN, outN });
    }
  }
}

console.log("\n=== Dose-response: core-mid disposals by # of core teammates OUT ===");
for (const k of [0, 1, 2]) {
  const b = buckets.get(k);
  if (b) console.log(`  ${k === 2 ? "2+" : k} out:  ${(b.sum / b.n).toFixed(2)} avg disposals   (n=${b.n})`);
}
const b0 = buckets.get(0), b1 = buckets.get(1), b2 = buckets.get(2);
if (b0 && b1) console.log(`  => +1 teammate out lifts disposals by ${((b1.sum / b1.n) - (b0.sum / b0.n)).toFixed(2)}`);
if (b0 && b2) console.log(`  => 2+ out lifts disposals by ${((b2.sum / b2.n) - (b0.sum / b0.n)).toFixed(2)}`);

console.log("\n=== Top 12 'sponges' (gain most disposals when a core teammate is out) ===");
sponge.sort((a, b) => b.delta - a.delta).slice(0, 12).forEach((s) =>
  console.log(`  +${s.delta.toFixed(1)}  ${s.name} (${s.team})  ${s.base.toFixed(1)} -> ${s.out.toFixed(1)}  [n=${s.outN}]`));
