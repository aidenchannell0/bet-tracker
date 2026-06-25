// VALIDATE the role/usage signal BEFORE wiring it into the builder.
// Scrapes %P (time on ground) + CP (contested poss) from AFL Tables for recent
// 2026 games, then asks: do LOW %P / LOW CP games predict the disposal "craters"
// that recent form rates as safe? If clear rate drops hard in the low buckets,
// the signal catches busts form is blind to — worth ingesting.
//
// Run: node lab/probe-role.mjs

import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const UA = "Mozilla/5.0 (research probe)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) disposal form history from data we already have
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("afl_player_games").select("game_code,game_date,player_name,disposals").order("game_date", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  if (!data?.length) break; rows.push(...data); if (data.length < 1000) break;
}
const byPlayer = new Map(); // name -> [{date, di}] sorted
const gmeta = new Map();     // game_code -> { date, year }
for (const r of rows) {
  if (!byPlayer.has(r.player_name)) byPlayer.set(r.player_name, []);
  byPlayer.get(r.player_name).push({ date: r.game_date, di: Number(r.disposals) || 0 });
  if (!gmeta.has(r.game_code)) gmeta.set(r.game_code, { date: r.game_date, year: String(r.game_date).slice(0, 4) });
}
for (const a of byPlayer.values()) a.sort((x, y) => (x.date < y.date ? -1 : 1));

const testGames = [...gmeta.entries()]
  .filter(([, g]) => g.year === "2026")
  .sort((a, b) => (a[1].date < b[1].date ? 1 : -1))
  .slice(0, 55);
console.log(`testing on ${testGames.length} recent 2026 games`);

function formAvg(name, beforeDate) {
  const prior = (byPlayer.get(name) || []).filter((g) => g.date < beforeDate).slice(-10);
  if (prior.length < 4) return null;
  let w = 1, sw = 0, ss = 0;
  for (let i = prior.length - 1; i >= 0; i--) { ss += prior[i].di * w; sw += w; w *= 0.9; }
  return ss / sw;
}

// AFL Tables cols: 1:Player 5:DI 17:CP 24:%P
function parseMatch(html) {
  const out = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
    if (cells.length < 25 || !/^\d+$/.test(cells[0])) continue; // jumper number = player row
    let name = cells[1]; // AFL Tables uses "Surname, First" — flip to match our DB's "First Surname"
    if (name.includes(",")) { const i = name.indexOf(","); name = `${name.slice(i + 1).trim()} ${name.slice(0, i).trim()}`; }
    const di = parseInt(cells[5], 10), cp = parseInt(cells[17], 10), pp = parseInt(String(cells[24]).replace(/\D/g, ""), 10);
    if (name && !Number.isNaN(di)) out.push({ name, di, cp, pp });
  }
  return out;
}

const ppB = [ { lo: 0, hi: 80, n: 0, c: 0 }, { lo: 80, hi: 90, n: 0, c: 0 }, { lo: 90, hi: 101, n: 0, c: 0 } ];
const cpB = [ { lo: 0, hi: 8, n: 0, c: 0 }, { lo: 8, hi: 12, n: 0, c: 0 }, { lo: 12, hi: 99, n: 0, c: 0 } ];
let tested = 0, scraped = 0;
for (const [code, g] of testGames) {
  let html;
  try {
    const res = await fetch(`https://afltables.com/afl/stats/games/${g.year}/${code}.html`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error("HTTP " + res.status); html = await res.text();
  } catch (e) { console.error("skip", code, e.message); await sleep(500); continue; }
  scraped++;
  for (const p of parseMatch(html)) {
    if (Number.isNaN(p.pp) || Number.isNaN(p.cp)) continue;
    const form = formAvg(p.name, g.date);
    if (form == null || form < 18) continue;        // disposal-mids only
    const line = Math.max(1, Math.round(form) - 4);  // a typical "safe" cushion line
    const clear = p.di >= line ? 1 : 0;
    tested++;
    const pb = ppB.find((b) => p.pp >= b.lo && p.pp < b.hi); if (pb) { pb.n++; pb.c += clear; }
    const cb = cpB.find((b) => p.cp >= b.lo && p.cp < b.hi); if (cb) { cb.n++; cb.c += clear; }
  }
  await sleep(700);
}

console.log(`scraped ${scraped} games | ${tested} mid-games tested (form>=18, line = form-4)\n`);
console.log("=== clear rate by TIME ON GROUND (%P) ===");
for (const b of ppB) if (b.n) console.log(`  ${b.lo === 0 ? "<80" : b.hi === 101 ? "90+ " : b.lo + "-" + b.hi}% TOG:  cleared ${(100 * b.c / b.n).toFixed(0)}%  (n=${b.n})`);
console.log("\n=== clear rate by CONTESTED POSSESSIONS (CP) ===");
for (const b of cpB) if (b.n) console.log(`  ${b.lo === 0 ? "<8 " : b.hi === 99 ? "12+" : b.lo + "-" + b.hi} CP:  cleared ${(100 * b.c / b.n).toFixed(0)}%  (n=${b.n})`);
console.log("\n(if the low buckets clear much less, %P/CP catch craters recent form misses)");
