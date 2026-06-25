// FAIRER sponge test (the user's actual claim): when a team's #1 mid is OUT,
// do the OTHER mids CLEAR their disposal lines more often? Uses clear-rate (the
// betting metric, not MAE) and KEY-player-out (not "any teammate out"). Walk-forward:
// the line is built from each beneficiary's PRIOR form; "key out" is a lineup fact.
//
// Run: node lab/probe-sponge2.mjs

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

const byTeamPlayer = new Map(); // team -> Map(name -> [{date,di,gc}])
const presence = new Map();     // `${gc}|${team}` -> Set(name present)
const byPlayer = new Map();     // name -> [{date,di}] for form
const gameTeams = new Map();    // gc -> {date, teams:Set}
for (const r of rows) {
  const di = Number(r.disposals) || 0;
  if (!byTeamPlayer.has(r.team)) byTeamPlayer.set(r.team, new Map());
  const tp = byTeamPlayer.get(r.team);
  if (!tp.has(r.player_name)) tp.set(r.player_name, []);
  tp.get(r.player_name).push({ date: r.game_date, di, gc: r.game_code });
  const pk = `${r.game_code}|${r.team}`;
  if (!presence.has(pk)) presence.set(pk, new Set());
  presence.get(pk).add(r.player_name);
  if (!byPlayer.has(r.player_name)) byPlayer.set(r.player_name, []);
  byPlayer.get(r.player_name).push({ date: r.game_date, di });
  if (!gameTeams.has(r.game_code)) gameTeams.set(r.game_code, { date: r.game_date, teams: new Set() });
  gameTeams.get(r.game_code).teams.add(r.team);
}
for (const a of byPlayer.values()) a.sort((x, y) => (x.date < y.date ? -1 : 1));

const teamMids = new Map(); // team -> [{name, avg, n}] sorted desc, n>=8
for (const [team, tp] of byTeamPlayer) {
  teamMids.set(team, [...tp.entries()]
    .map(([name, gs]) => ({ name, n: gs.length, avg: gs.reduce((a, b) => a + b.di, 0) / gs.length }))
    .filter((p) => p.n >= 8).sort((a, b) => b.avg - a.avg));
}
function formAvg(name, beforeDate) {
  const prior = (byPlayer.get(name) || []).filter((g) => g.date < beforeDate).slice(-10);
  if (prior.length < 4) return null;
  let w = 1, sw = 0, ss = 0; for (let i = prior.length - 1; i >= 0; i--) { ss += prior[i].di * w; sw += w; w *= 0.9; }
  return ss / sw;
}

const stat = { in: { n: 0, c: 0, di: 0 }, out: { n: 0, c: 0, di: 0 } };
const dose = [ { k: 0, n: 0, c: 0, di: 0 }, { k: 1, n: 0, c: 0, di: 0 }, { k: 2, n: 0, c: 0, di: 0 } ];
for (const [gc, g] of gameTeams) {
  for (const team of g.teams) {
    const mids = teamMids.get(team); if (!mids || mids.length < 3) continue;
    const present = presence.get(`${gc}|${team}`) || new Set();
    const key = mids[0];
    const keyOut = !present.has(key.name);
    const topOut = mids.slice(0, 3).filter((m) => !present.has(m.name)).length;
    for (const m of mids) {                    // beneficiaries = other mids (avg>=18) who played
      if (m.avg < 18 || m.name === key.name || !present.has(m.name)) continue;
      const rec = byTeamPlayer.get(team).get(m.name).find((x) => x.gc === gc); if (!rec) continue;
      const form = formAvg(m.name, g.date); if (form == null) continue;
      const line = Math.max(1, Math.round(form) - 4);
      const clear = rec.di >= line ? 1 : 0;
      const b = keyOut ? stat.out : stat.in; b.n++; b.c += clear; b.di += rec.di;
      const d = dose.find((x) => x.k === Math.min(topOut, 2)); if (d) { d.n++; d.c += clear; d.di += rec.di; }
    }
  }
}
const pct = (o) => (o.n ? (100 * o.c / o.n).toFixed(0) + "%" : "-");
const avg = (o) => (o.n ? (o.di / o.n).toFixed(1) : "-");
console.log("=== other mids: clear rate (vs their form−4 line) when the #1 mid is IN vs OUT ===");
console.log(`  #1 mid IN:   cleared ${pct(stat.in)}   avg ${avg(stat.in)} disposals   (n=${stat.in.n})`);
console.log(`  #1 mid OUT:  cleared ${pct(stat.out)}   avg ${avg(stat.out)} disposals   (n=${stat.out.n})`);
console.log("\n=== dose: by # of the team's top-3 mids OUT ===");
for (const d of dose) if (d.n) console.log(`  ${d.k === 2 ? "2+" : d.k} out:  cleared ${pct(d)}   avg ${avg(d)}   (n=${d.n})`);
console.log("\n(if 'OUT' clears clearly more than 'IN', the sponge IS betting-actionable with lineup data)");
