// Poll until the redeploy lands (value_board v7), then prove the haircut across
// the FULL board by reading the stored picks from Supabase (no free-gate).
// Triggers the recompute via curl; reads the table via supabase-js.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function stats(picks) {
  const cs = picks.map((p) => p.confidence).filter((x) => x != null).sort((a, b) => a - b);
  const n = cs.length; if (!n) return { n: 0 };
  return { n, min: cs[0], med: cs[Math.floor(n / 2)], max: cs[n - 1], over85: cs.filter((x) => x > 85).length };
}

for (let i = 1; i <= 14; i++) {
  try { execSync(`curl -s -m 60 -X POST https://pickd.tech/api/edge -H "Content-Type: application/json" -d '{"intent":"value","sport":"AFL"}' -o /dev/null`); } catch {}
  const { data } = await sb.from("value_board").select("board,computed_at").eq("sport", "AFL").maybeSingle();
  const v = data?.board?.v, picks = data?.board?.picks || [];
  console.log(`poll ${i} (${new Date().toLocaleTimeString()}): stored v=${v} computed_at=${data?.computed_at}`);
  if (v === 10) {
    const s = stats(picks);
    console.log(`\nV7 LIVE — board recomputed with the winner's-curse haircut`);
    console.log(`  ${s.n} cards | confidence min ${s.min} / median ${s.med} / MAX ${s.max} | cards >85%: ${s.over85}`);
    console.log(`  (pre-fix these topped ~90%+; honest AFL ceiling is ~80%)`);
    console.log(`  top 6 by confidence:`);
    picks.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 6)
      .forEach((p) => console.log(`    ${p.player || p.playerName} — ${p.metric} ${p.line} → ${p.confidence}%`));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 25000));
}
console.log("still v6 after ~6 min — redeploy may still be building or stuck again");
