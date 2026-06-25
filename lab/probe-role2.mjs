// NON-CIRCULAR test: does a player's PRIOR contested-ball tendency (CP-share) and
// PRIOR time-on-ground predict his FUTURE disposal clearing, beyond his disposal
// average? Walk-forward, mids only. Scrapes the full 2026 season once (cached).
//
// Run: node lab/probe-role2.mjs

import { readFileSync, existsSync, writeFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const UA = "Mozilla/5.0 (research probe)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CACHE = "/tmp/afl_role_all.json";
const SINCE = "2025-01-01"; // full 2025 season + 2026 — enough per-player history for walk-forward

function parseMatch(html) {
  const out = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
    if (cells.length < 25 || !/^\d+$/.test(cells[0])) continue;
    let name = cells[1];
    if (name.includes(",")) { const i = name.indexOf(","); name = `${name.slice(i + 1).trim()} ${name.slice(0, i).trim()}`; }
    const di = parseInt(cells[5], 10), cp = parseInt(cells[17], 10), pp = parseInt(String(cells[24]).replace(/\D/g, ""), 10);
    if (name && !Number.isNaN(di) && !Number.isNaN(cp) && !Number.isNaN(pp)) out.push({ name, di, cp, pp });
  }
  return out;
}

let data;
if (existsSync(CACHE)) {
  data = JSON.parse(readFileSync(CACHE, "utf8"));
  console.log(`loaded ${data.length} player-games from cache`);
} else {
  const gl = []; // paginate past Supabase's 1000-row cap or we only see the earliest ~23 games
  for (let from = 0; ; from += 1000) {
    const { data: pg, error } = await sb.from("afl_player_games").select("game_code,game_date").gte("game_date", SINCE).order("game_date", { ascending: true }).range(from, from + 999);
    if (error) { console.error(error.message); break; }
    if (!pg?.length) break; gl.push(...pg); if (pg.length < 1000) break;
  }
  const gm = new Map(); for (const r of gl) if (!gm.has(r.game_code)) gm.set(r.game_code, r.game_date);
  const games = [...gm.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 180); // most recent ~180 games
  console.log(`scraping ${games.length} games (of ${gm.size} total since ${SINCE})...`);
  data = [];
  for (const [code, date] of games) {
    try {
      const res = await fetch(`https://afltables.com/afl/stats/games/${String(date).slice(0, 4)}/${code}.html`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      for (const p of parseMatch(await res.text())) data.push({ ...p, date });
    } catch (e) { console.error("skip", code, e.message); }
    await sleep(650);
  }
  writeFileSync(CACHE, JSON.stringify(data));
  console.log(`scraped ${data.length} player-games, cached`);
}

const byP = new Map();
for (const r of data) { if (!byP.has(r.name)) byP.set(r.name, []); byP.get(r.name).push(r); }
for (const a of byP.values()) a.sort((x, y) => (x.date < y.date ? -1 : 1));

const shareB = [ { lo: 0, hi: 0.35, n: 0, c: 0 }, { lo: 0.35, hi: 0.42, n: 0, c: 0 }, { lo: 0.42, hi: 1.01, n: 0, c: 0 } ];
const togB = [ { lo: 0, hi: 82, n: 0, c: 0 }, { lo: 82, hi: 88, n: 0, c: 0 }, { lo: 88, hi: 101, n: 0, c: 0 } ];
let tested = 0;
for (const arr of byP.values()) {
  for (let i = 0; i < arr.length; i++) {
    const prior = arr.slice(Math.max(0, i - 10), i);
    if (prior.length < 4) continue;
    let w = 1, swd = 0, ssd = 0; for (let j = prior.length - 1; j >= 0; j--) { ssd += prior[j].di * w; swd += w; w *= 0.9; }
    const priorDI = ssd / swd;
    if (priorDI < 18 || priorDI > 32) continue; // mids band — controls for disposal average
    const sumCP = prior.reduce((a, p) => a + p.cp, 0), sumDI = prior.reduce((a, p) => a + p.di, 0);
    const cpShare = sumDI ? sumCP / sumDI : 0;
    const priorTOG = prior.reduce((a, p) => a + p.pp, 0) / prior.length;
    const line = Math.max(1, Math.round(priorDI) - 4);
    const clear = arr[i].di >= line ? 1 : 0;
    tested++;
    const s = shareB.find((b) => cpShare >= b.lo && cpShare < b.hi); if (s) { s.n++; s.c += clear; }
    const t = togB.find((b) => priorTOG >= b.lo && priorTOG < b.hi); if (t) { t.n++; t.c += clear; }
  }
}
console.log(`\n${tested} mid-games tested (walk-forward, line = prior form − 4)`);
console.log("\n=== PREDICTIVE: clear rate by PRIOR contested-share (controls for DI avg) ===");
for (const b of shareB) if (b.n) console.log(`  prior CP-share ${b.lo === 0 ? "<35" : b.hi >= 1 ? "42+" : Math.round(b.lo * 100) + "-" + Math.round(b.hi * 100)}%:  cleared ${(100 * b.c / b.n).toFixed(0)}%  (n=${b.n})`);
console.log("\n=== PREDICTIVE: clear rate by PRIOR avg TOG ===");
for (const b of togB) if (b.n) console.log(`  prior TOG ${b.lo === 0 ? "<82" : b.hi === 101 ? "88+" : b.lo + "-" + b.hi}%:  cleared ${(100 * b.c / b.n).toFixed(0)}%  (n=${b.n})`);
console.log("\n(if higher prior CP-share clears more at the SAME DI band, it's genuinely predictive — not circular)");
