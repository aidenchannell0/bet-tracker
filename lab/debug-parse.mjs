import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: g } = await sb.from("afl_player_games").select("game_code,game_date,player_name,disposals").gte("game_date", "2026-01-01").order("game_date", { ascending: false }).limit(60);
const code = g[0].game_code, year = String(g[0].game_date).slice(0, 4);
const dbP = g.filter((r) => r.game_code === code);
console.log("game", code, year, "| db rows this game:", dbP.length);
console.log("DB names:", dbP.slice(0, 6).map((r) => `[${r.player_name}=${r.disposals}]`).join(" "));

const res = await fetch(`https://afltables.com/afl/stats/games/${year}/${code}.html`, { headers: { "User-Agent": "Mozilla/5.0 (probe)" } });
const html = await res.text();
console.log("html bytes:", html.length);

// cell-count distribution of all <tr>
const counts = {};
let sampleRow = null;
for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
  const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
  counts[cells.length] = (counts[cells.length] || 0) + 1;
  if (cells.length >= 20 && /^\d+$/.test(cells[0]) && !sampleRow) sampleRow = cells;
}
console.log("row cell-count distribution:", JSON.stringify(counts));
console.log("first numeric-jumper row cells[0..6]:", sampleRow ? sampleRow.slice(0, 7) : "NONE FOUND");
console.log("that row cells[17],[24]:", sampleRow ? [sampleRow[17], sampleRow[24]] : "-");
